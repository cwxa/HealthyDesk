"""生成导出/导入格式的对拍期望值（Python 侧真实函数算出来）。

用法：
    python scripts/gen-export-cases.py > scripts/export-expected.json
    node scripts/verify-export-format.mjs

覆盖：
- 常量：格式标识、格式版本、BOM、表顺序、每表字段与类型、排序键、CSV 表头、保留天数上下界
- build_export：规范化 + 稳定排序 + 脏行跳过计数
- validate_export：每种错误码 + 合法包
- CSV：精确文本（含需要转义的日期）
- clamp_retention_days：非法输入的回落值
- 非有限数（inf/NaN）无法写进 JSON，单独一小节由两端各自构造输入（见 non_finite）
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

from config import (  # noqa: E402
    MAX_RETENTION_DAYS,
    MIN_RETENTION_DAYS,
    RETENTION_DAYS,
    clamp_retention_days,
)
from services.export_format import (  # noqa: E402
    CSV_BOM,
    DAILY_CSV_HEADER,
    EXPORT_FORMAT,
    EXPORT_FORMAT_VERSION,
    SORT_KEY,
    TABLE_FIELDS,
    TABLE_ORDER,
    build_daily_csv,
    build_export,
    validate_export,
)

TS = "2026-09-25T0{}:00:00.000Z"


def ts(hour: int) -> str:
    return TS.format(hour)


# ---------------------------------------------------------------------------
# build_export 用例
# ---------------------------------------------------------------------------
BASE_TABLES = {
    "settings": [
        {"key": "voice_enabled", "value": "true"},
        {"key": "ai_enabled", "value": "false"},
        # 凭据必须被排除（且不计入 skipped）
        {"key": "deepseek_api_key", "value": "sk-should-never-be-exported"},
        # 脏行：缺 value / 非对象 / value 是布尔（不做隐式转换）
        {"key": "no_value"},
        "not-an-object",
        {"key": "bool_value", "value": True},
        {"key": "num_value", "value": 5},
    ],
    "posture_score": [
        {"timestamp": ts(2), "head_angle": 3, "shoulder_diff": 2, "spine_angle": 5, "score": 96},
        # 数值字符串应被接受（严格正则认识 "2.5" / "70"）
        {"timestamp": ts(1), "head_angle": 6.5, "shoulder_diff": "2.5", "spine_angle": 11, "score": "70"},
        # 与上一条同 timestamp：验证稳定排序（并列保持输入顺序）
        {"timestamp": ts(1), "head_angle": 0, "shoulder_diff": 0, "spine_angle": 0, "score": 100},
        # 以下都该被跳过
        {"timestamp": ts(3), "head_angle": 1, "shoulder_diff": 1, "spine_angle": 1, "score": None},
        {"timestamp": ts(3), "head_angle": 1, "shoulder_diff": 1, "spine_angle": 1, "score": "0x10"},
        {"timestamp": ts(3), "head_angle": 1, "shoulder_diff": 1, "spine_angle": 1, "score": "1_0"},
        {"timestamp": 123, "head_angle": 1, "shoulder_diff": 1, "spine_angle": 1, "score": 50},
        {"timestamp": ts(3), "head_angle": 1, "shoulder_diff": 1},
    ],
    "posture_daily": [
        {
            "date": "2026-09-24",
            "sample_count": 100,
            "score_sum": 8500,
            "min_score": 60,
            "head_bad_count": 30,
            "shoulder_bad_count": 12,
            "spine_bad_count": 5,
            "updated_at": ts(23),
        },
        {
            "date": "2026-09-23",
            "sample_count": 50,
            "score_sum": 4000,
            "min_score": 20,
            "head_bad_count": 1,
            "shoulder_bad_count": 0,
            "spine_bad_count": 0,
            "updated_at": ts(23),
        },
    ],
    "usage_record": [
        {"date": "2026-09-24", "usage_minutes": 480, "break_count": 12},
        {"date": "2026-09-23", "usage_minutes": 300, "break_count": 8},
    ],
    "activity_log": [
        {
            "timestamp": ts(15),
            "activity_type": "exercise",
            "exercise_count": 7,
            "duration_sec": 82,
            "avg_score": 78,
        }
    ],
    # 表外的键必须被忽略
    "unknown_table": [{"whatever": 1}],
}

BUILD_CASES = [
    {
        "name": "完整包（含脏行与未知表）",
        "tables": BASE_TABLES,
        "app_version": "1.4.0",
        "schema_version": 3,
        "exported_at": ts(10),
        "expected": build_export(BASE_TABLES, "1.4.0", 3, ts(10)),
    },
    {
        "name": "空表（只给部分表）",
        "tables": {"settings": []},
        "app_version": "",
        "schema_version": 0,
        "exported_at": "",
        "expected": build_export({"settings": []}, "", 0, ""),
    },
    {
        "name": "tables 为 None（按全空处理）",
        "tables": None,
        "app_version": "0.0.0",
        "schema_version": 2,
        "exported_at": ts(10),
        "expected": build_export(None, "0.0.0", 2, ts(10)),
    },
]

# ---------------------------------------------------------------------------
# validate_export 用例
# ---------------------------------------------------------------------------
VALID = build_export(BASE_TABLES, "1.4.0", 3, ts(10))["bundle"]
MINIMAL = build_export(None, "", 0, "")["bundle"]

VALIDATE_CASES = [
    {"name": "合法包", "raw": VALID, "expected": validate_export(VALID)},
    {"name": "合法空包", "raw": MINIMAL, "expected": validate_export(MINIMAL)},
    {"name": "非法·不是对象（字符串）", "raw": "hello", "expected": validate_export("hello")},
    {"name": "非法·不是对象（null）", "raw": None, "expected": validate_export(None)},
    {"name": "非法·不是对象（数组）", "raw": [1, 2, 3], "expected": validate_export([1, 2, 3])},
    {"name": "非法·format 不对", "raw": {**VALID, "format": "other"}, "expected": validate_export({**VALID, "format": "other"})},
    {
        "name": "非法·版本不支持",
        "raw": {**VALID, "format_version": EXPORT_FORMAT_VERSION + 1},
        "expected": validate_export({**VALID, "format_version": EXPORT_FORMAT_VERSION + 1}),
    },
    {
        "name": "非法·版本是小数",
        "raw": {**VALID, "format_version": 1.5},
        "expected": validate_export({**VALID, "format_version": 1.5}),
    },
    {
        "name": "非法·版本是字符串（严格正则接受 \"1\")",
        "raw": {**VALID, "format_version": "1"},
        "expected": validate_export({**VALID, "format_version": "1"}),
    },
    {
        "name": "非法·版本是含糊字符串",
        "raw": {**VALID, "format_version": "1_0"},
        "expected": validate_export({**VALID, "format_version": "1_0"}),
    },
    {"name": "非法·缺 tables", "raw": {**VALID, "tables": None}, "expected": validate_export({**VALID, "tables": None})},
    {"name": "非法·tables 不是对象", "raw": {**VALID, "tables": "x"}, "expected": validate_export({**VALID, "tables": "x"})},
    {
        "name": "非法·缺某张表",
        "raw": {**VALID, "tables": {k: v for k, v in VALID["tables"].items() if k != "usage_record"}},
        "expected": validate_export({**VALID, "tables": {k: v for k, v in VALID["tables"].items() if k != "usage_record"}}),
    },
    {
        "name": "非法·某张表不是数组",
        "raw": {**VALID, "tables": {**VALID["tables"], "settings": {}}},
        "expected": validate_export({**VALID, "tables": {**VALID["tables"], "settings": {}}}),
    },
    {
        "name": "半脏数据（脏行被跳过但仍合法）",
        "raw": {
            "format": EXPORT_FORMAT,
            "format_version": EXPORT_FORMAT_VERSION,
            "tables": {**MINIMAL["tables"], "usage_record": [{"date": "2026-01-01", "usage_minutes": 10, "break_count": 1}, {"date": "2026-01-02"}]},
        },
        "expected": validate_export(
            {
                "format": EXPORT_FORMAT,
                "format_version": EXPORT_FORMAT_VERSION,
                "tables": {**MINIMAL["tables"], "usage_record": [{"date": "2026-01-01", "usage_minutes": 10, "break_count": 1}, {"date": "2026-01-02"}]},
            }
        ),
    },
]

# ---------------------------------------------------------------------------
# CSV 用例
# ---------------------------------------------------------------------------
CSV_ROWS = [
    {
        "date": "2026-09-24",
        "sample_count": 100,
        "score_sum": 8500,
        "min_score": 60,
        "head_bad_count": 30,
        "shoulder_bad_count": 12,
        "spine_bad_count": 5,
    },
    {
        # 恶意字段：需要 CSV 转义（日期里塞逗号与引号）
        "date": '2026-09-25,"x"',
        "sample_count": 16,
        "score_sum": 1420,
        "min_score": 70,
        "head_bad_count": 1,
        "shoulder_bad_count": 0,
        "spine_bad_count": 0,
    },
    {
        # 整数日均分：必须输出 "90.0" 而不是 "90"（两端格式差异的高发点）
        "date": "2026-09-26",
        "sample_count": 10,
        "score_sum": 900,
        "min_score": 90,
        "head_bad_count": 0,
        "shoulder_bad_count": 0,
        "spine_bad_count": 0,
    },
]

CSV_CASES = [
    {"name": "每日汇总", "rows": CSV_ROWS, "expected": build_daily_csv(CSV_ROWS)},
    {"name": "空", "rows": [], "expected": build_daily_csv([])},
]

# ---------------------------------------------------------------------------
# clamp_retention_days 用例
# ---------------------------------------------------------------------------
CLAMP_INPUTS = [30, 7, 365, 1, 0, -5, 366, 10000, "45", "abc", None, True, False, 30.9, "", " 45 ", "45abc", "45.0", [], {}]
CLAMP_CASES = [{"input": v, "expected": clamp_retention_days(v)} for v in CLAMP_INPUTS]

# ---------------------------------------------------------------------------
# 非有限数（JSON 无法表示 inf/NaN，两端各自构造输入，期望值由 Python 给出）
# ---------------------------------------------------------------------------
NON_FINITE_SPECS = ["inf", "neg_inf", "nan"]
NON_FINITE_ROWS = [
    {"timestamp": ts(3), "head_angle": 1, "shoulder_diff": 1, "spine_angle": 1, "score": float("inf")},
    {"timestamp": ts(3), "head_angle": 1, "shoulder_diff": 1, "spine_angle": 1, "score": float("-inf")},
    {"timestamp": ts(3), "head_angle": 1, "shoulder_diff": 1, "spine_angle": 1, "score": float("nan")},
    {"timestamp": ts(4), "head_angle": 1, "shoulder_diff": 1, "spine_angle": 1, "score": 88},
]
_NF_RESULT = validate_export(
    {
        "format": EXPORT_FORMAT,
        "format_version": EXPORT_FORMAT_VERSION,
        "tables": {**MINIMAL["tables"], "posture_score": NON_FINITE_ROWS},
    }
)
NON_FINITE = {
    "specs": NON_FINITE_SPECS,
    "expected_ok": _NF_RESULT["ok"],
    "expected_skipped": _NF_RESULT["skipped"]["posture_score"],
    "expected_rows": _NF_RESULT["bundle"]["tables"]["posture_score"],
}

payload = {
    "constants": {
        "EXPORT_FORMAT": EXPORT_FORMAT,
        "EXPORT_FORMAT_VERSION": EXPORT_FORMAT_VERSION,
        "CSV_BOM": CSV_BOM,
        "TABLE_ORDER": list(TABLE_ORDER),
        "SORT_KEY": SORT_KEY,
        "TABLE_FIELDS": {k: [list(f) for f in v] for k, v in TABLE_FIELDS.items()},
        "DAILY_CSV_HEADER": list(DAILY_CSV_HEADER),
        "RETENTION_DAYS": RETENTION_DAYS,
        "MIN_RETENTION_DAYS": MIN_RETENTION_DAYS,
        "MAX_RETENTION_DAYS": MAX_RETENTION_DAYS,
    },
    "build_cases": BUILD_CASES,
    "validate_cases": VALIDATE_CASES,
    "csv_cases": CSV_CASES,
    "clamp_cases": CLAMP_CASES,
    "non_finite": NON_FINITE,
}

json.dump(payload, sys.stdout, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
sys.stdout.write("\n")
