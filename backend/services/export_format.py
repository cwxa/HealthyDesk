"""统一导出 / 导入格式（桌面端 Python 实现）。

## 目标

导出的 JSON 文件**两端可以互相导入**：电脑导出的能导进手机，反之亦然。
这不是自然成立的 —— 两端的表名、字段名、字段类型、行的排序，任何一处不一致都会
造成"能导入但数字对不上"。所以这个文件与 `src/platform/exportFormat.ts`
是**同一份规格的两种实现**，由 `scripts/verify-export-format.mjs` 逐字段对拍。

## 三条设计决定

1. **只导出"数据"，不导出"派生量"。** `posture_daily` 导出的是
   `score_sum` / `*_bad_count` 这些精确量，日均分与占比在导入后由同一套函数现算 ——
   否则两份文件里存着各自的取整结果，合并时必然漂移。
2. **只认字段名 + 类型，不认表外的键。** 多出来的表和字段一律忽略：
   这样旧版本能导入新版本导出的文件（向前兼容），而不是整个报错。
3. **脏行跳过而不是整份失败。** 某一行缺字段/类型不对时跳过它并计数，
   写进 `skipped`。用户攒了一年的数据不该因为一行坏了就全导不进来。

## 版本

`format_version` 变化才代表不兼容。校验时**只接受当前版本**（拒绝而不是猜测），
因为格式演进时静默地"尽力而为"会让用户以为导入成功了。

## `skipped` 为什么不写进文件

脏行计数是**调用方拿到的诊断信息**，不是数据，所以放在返回值的 `skipped` 字段上，
而不是放进 `bundle`（要写进文件的那部分）。理由：一旦写进文件，
"导出 → 导入 → 再导出"就不是同一个文件了（第二次已经无脏行可跳），
而备份/恢复的直觉是**同一个文件**。文件本身必须是纯数据。
"""

import math
import re

from services.daily_agg import daily_avg_score, daily_bad_pct

EXPORT_FORMAT = "neckguardian-export"
EXPORT_FORMAT_VERSION = 1
# 导出的 CSV 前面要加 BOM，否则 Excel 打开中文表头是乱码。
CSV_BOM = "\ufeff"

# 导出文件里的表顺序（固定，便于人读与 diff）
TABLE_ORDER = ("settings", "posture_score", "posture_daily", "usage_record", "activity_log")

# 每张表的字段与类型：num = 数值，str = 字符串。字段顺序也是导出的键顺序。
TABLE_FIELDS = {
    "settings": (("key", "str"), ("value", "str")),
    "posture_score": (
        ("timestamp", "str"),
        ("head_angle", "num"),
        ("shoulder_diff", "num"),
        ("spine_angle", "num"),
        ("score", "num"),
    ),
    "posture_daily": (
        ("date", "str"),
        ("sample_count", "num"),
        ("score_sum", "num"),
        ("min_score", "num"),
        ("head_bad_count", "num"),
        ("shoulder_bad_count", "num"),
        ("spine_bad_count", "num"),
        ("updated_at", "str"),
    ),
    "usage_record": (("date", "str"), ("usage_minutes", "num"), ("break_count", "num")),
    "activity_log": (
        ("timestamp", "str"),
        ("activity_type", "str"),
        ("exercise_count", "num"),
        ("duration_sec", "num"),
        ("avg_score", "num"),
    ),
}

# 每张表的排序键。排序让导出文件稳定（同一份数据导出两次结果相同），
# 也让两端导入后落库顺序一致。
SORT_KEY = {
    "settings": "key",
    "posture_score": "timestamp",
    "posture_daily": "date",
    "usage_record": "date",
    "activity_log": "timestamp",
}

# 导出时**排除**的设置项。
#
# 它们是凭据，而导出文件是用户会随手放进网盘、发给自己的东西 —— 把 API Key 写进去
# 等于泄露。同一份数据在导入时也不会被覆盖（设置表用 upsert），
# 所以「导出 → 导入」不会把本机的密钥抹掉。
#
# 被排除的项**不计入 `skipped`**：那不是脏数据，是有意的策略。
# 界面上必须明说（"导出不包含 DeepSeek API Key"），否则用户会以为备份是全量的。
SECRET_SETTING_KEYS = ("deepseek_api_key",)

# 数值字符串的严格形态。
# ⚠️ 刻意**不用**各自的宽松转换：Python 的 `float("1_0")` 是 10、TS 的
# `Number("0x10")` 是 16，两者对同一串字符会给出不同结果 —— 那正是"两端不一致"
# 的来源。限制成一个共同的正则，两边行为才真正相同。
_NUM_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")


def _num(v):
    """按共同规则取数值；失败返回 None（Windows 的 NaN/Inf 也拒绝）。"""
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        return f if math.isfinite(f) else None
    if isinstance(v, str):
        s = v.strip()
        if not s or not _NUM_RE.match(s):
            return None
        f = float(s)
        return f if math.isfinite(f) else None
    return None


def _str(v):
    """只接受真正的字符串。数字/布尔**不做**隐式转换 —— `str(True)` 是 "True"、
    `String(true)` 是 "true"，两端的隐式转换规则不同，必须禁止。"""
    return v if isinstance(v, str) else None


def normalize_rows(table: str, rows) -> tuple[list[dict], int]:
    """规范化一张表的行，返回 (规范行, 被跳过的行数)。

    缺失/类型不对的字段 → 跳过该行（不修补、不填默认值：填默认值会静默改数据）。
    """
    fields = TABLE_FIELDS[table]
    out: list[dict] = []
    skipped = 0
    for raw in rows:
        if not isinstance(raw, dict):
            skipped += 1
            continue
        row = {}
        ok = True
        for name, kind in fields:
            value = _num(raw.get(name)) if kind == "num" else _str(raw.get(name))
            if value is None:
                ok = False
                break
            row[name] = value
        if not ok:
            skipped += 1
            continue
        out.append(row)
    key = SORT_KEY[table]
    # 稳定排序（Python 的 sort 保证稳定）：排序键并列时保持输入顺序，
    # 两端用同样的输入才能得到同样的输出。
    out.sort(key=lambda r: r[key])
    if table == "settings":
        out = [r for r in out if r["key"] not in SECRET_SETTING_KEYS]
    return out, skipped


def _bundle(tables: dict, app_version, schema_version, exported_at) -> dict:
    """要写进文件的部分 —— **只有数据**，不含任何诊断信息（见模块顶部说明）。"""
    return {
        "format": EXPORT_FORMAT,
        "format_version": EXPORT_FORMAT_VERSION,
        "app_version": app_version,
        "schema_version": int(schema_version or 0),
        "exported_at": exported_at,
        "tables": tables,
    }


def _sorted_skipped(skipped: dict) -> dict:
    """按表顺序整理诊断计数（键顺序稳定，方便两端比对与展示）。"""
    return {k: skipped[k] for k in TABLE_ORDER if k in skipped}


def build_export(tables: dict, app_version: str = "", schema_version: int = 0, exported_at: str = "") -> dict:
    """组装导出包。

    返回 `{"bundle": <写入文件的内容>, "skipped": {表名: 跳过行数}}`。
    `tables` 里没有的表按空表处理（导出不需要它也能成立）。
    """
    out: dict = {}
    skipped: dict = {}
    for table in TABLE_ORDER:
        rows, sk = normalize_rows(table, (tables or {}).get(table) or [])
        out[table] = rows
        if sk:
            skipped[table] = sk
    return {
        "bundle": _bundle(out, str(app_version), schema_version, str(exported_at)),
        "skipped": _sorted_skipped(skipped),
    }


def validate_export(raw) -> dict:
    """校验并规范化一个导入包。

    返回 `{"ok": True, "error": None, "bundle": {...}, "skipped": {...}}`
    或   `{"ok": False, "error": "<原因>", "bundle": None, "skipped": {}}`。

    错误码是**约定的字符串**（不是自然语言），两端必须给出同一个码。
    """
    empty: dict = {}
    if not isinstance(raw, dict):
        return {"ok": False, "error": "not_an_object", "bundle": None, "skipped": empty}
    if raw.get("format") != EXPORT_FORMAT:
        return {"ok": False, "error": "bad_format", "bundle": None, "skipped": empty}

    version = _num(raw.get("format_version"))
    if version is None or version != int(version) or int(version) != EXPORT_FORMAT_VERSION:
        return {"ok": False, "error": "unsupported_version", "bundle": None, "skipped": empty}

    tables = raw.get("tables")
    if not isinstance(tables, dict):
        return {"ok": False, "error": "missing_tables", "bundle": None, "skipped": empty}

    out: dict = {}
    skipped: dict = {}
    for table in TABLE_ORDER:
        if not isinstance(tables.get(table), list):
            return {"ok": False, "error": f"missing_table:{table}", "bundle": None, "skipped": empty}
        rows, sk = normalize_rows(table, tables[table])
        out[table] = rows
        if sk:
            skipped[table] = sk

    return {
        "ok": True,
        "error": None,
        "bundle": _bundle(
            out,
            _str(raw.get("app_version")) or "",
            int(_num(raw.get("schema_version")) or 0),
            _str(raw.get("exported_at")) or "",
        ),
        "skipped": _sorted_skipped(skipped),
    }


# ---------------------------------------------------------------------------
# CSV（给人看的那一份）
#
# 只导出**每日汇总**：原始采样动辄数十万行，摊成 CSV 没人看得下去；
# 而每日汇总正是用户想拿 Excel 看一眼的东西。派生量在这里现算（同 daily_agg）。
# ---------------------------------------------------------------------------

DAILY_CSV_HEADER = ("日期", "采样数", "日均分", "最低分", "头部问题占比%", "肩部问题占比%", "脊柱问题占比%")


def _csv_field(text: str) -> str:
    if any(c in text for c in (',', '"', '\n', '\r')):
        return '"' + text.replace('"', '""') + '"'
    return text


def _fmt_int(x) -> str:
    return str(int(x))


def _fmt_1(x) -> str:
    """固定一位小数。用 f"{x:.1f}" 而不是 str(x)：str(85.0) 是 "85.0" 但
    JS 的 String(85) 是 "85" —— 固定小数位才不会两端不一致。"""
    return f"{float(x):.1f}"


def build_daily_csv(daily_rows) -> str:
    """每日汇总 CSV。行尾用 CRLF（Excel 与 RFC 4180 的常规选择），两端一致。

    🔴 开头必须是 `CSV_BOM`。中文表头不带 BOM 时，Windows 版 Excel 会按
    系统 ANSI 代码页解读，直接显示成乱码 —— 这正是导出 CSV 唯一的用途场景。
    """
    rows = sorted(daily_rows, key=lambda r: _str(r.get("date")) or "")
    lines = [",".join(_csv_field(h) for h in DAILY_CSV_HEADER)]
    for r in rows:
        row = {
            "sample_count": r.get("sample_count") or 0,
            "score_sum": _num(r.get("score_sum")) or 0.0,
            "min_score": r.get("min_score") or 0,
            "head_bad_count": r.get("head_bad_count") or 0,
            "shoulder_bad_count": r.get("shoulder_bad_count") or 0,
            "spine_bad_count": r.get("spine_bad_count") or 0,
        }
        fields = [
            _str(r.get("date")) or "",
            _fmt_int(row["sample_count"]),
            _fmt_1(daily_avg_score(row)),
            _fmt_int(row["min_score"]),
            _fmt_1(daily_bad_pct(row, "head")),
            _fmt_1(daily_bad_pct(row, "shoulder")),
            _fmt_1(daily_bad_pct(row, "spine")),
        ]
        lines.append(",".join(_csv_field(f) for f in fields))
    return CSV_BOM + "\r\n".join(lines) + "\r\n"
