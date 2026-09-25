"""时间戳契约守卫的**证据收集**（判据在 scripts/verify-timefmt.mjs）。

跑法：
    python scripts/timefmt-probe.py > <某处>.json

为什么把证据收集与判据分开：本项目已有 9 个 `verify-*.mjs` 都以 node 为判据的主人，
这里保持一致 —— Python 只负责"把事实摆出来"，是绿是红由 node 断言。

本脚本做四件在 JS 里做不到的事：

1. 调**真实**的 `services.timefmt.now_iso_ms()`，确认后端产出的就是契约格式。
2. 用**真实** SQLite 验证 `date(timestamp, 'localtime')` 的日归属，并**留证**
   「写入本地时间串会导致跨日错位」——这正是修复前的桌面端行为。
3. 造一个装着**老格式**数据的临时库，跑**真实迁移 SQL**，验证「格式统一 + 本地日
   不变 + 范围外归档不被删 + 幂等」。
4. 在同一个临时库上跑**真实** `rollup_daily`，验证归档与「按本地日区间查询」同源。

🔴 全程只使用 `:memory:` 与临时文件，绝不打开用户的真实数据库。

⚠️ 一处**如实记录的覆盖盲区**：第 2 项里「旧写法会错位」这条断言依赖本机时区
偏移非 0。CI runner 的 TZ 是 UTC、偏移为 0，此时本地串与 UTC 串恰好相同，该错位
**在本机不可复现** —— 脚本会把 `legacy_misplaced` 置为 `null` 并附上原因，而不是
假装验过了（守卫会单独报告这一项是否真的覆盖到）。
"""

import asyncio
import json
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, time as dtime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import aiosqlite  # noqa: E402

from db.migrations import BASELINE_SQL, DAILY_AGG_SQL, TIMESTAMP_UTC_SQL  # noqa: E402
from services.retention import local_day_bounds_utc, rollup_daily  # noqa: E402
from services.timefmt import ISO_MS_RE, is_iso_ms, now_iso_ms, to_iso_ms  # noqa: E402


def local_offset_minutes() -> int:
    """本机相对 UTC 的偏移（分钟，东为正）。"""
    off = datetime.now().astimezone().utcoffset()
    return int(off.total_seconds() // 60) if off else 0


def local_day_to_iso(day, hour: int, minute: int = 0) -> str:
    """「本地某天的某时刻」→ 契约格式 UTC 串。

    用 naive datetime 经 `astimezone()` 解释为本地时间，与 `local_day_bounds_utc`
    同一套语义。
    """
    return to_iso_ms(datetime.combine(day, dtime(hour, minute)).astimezone())


def legacy_local_iso(day, hour: int, minute: int = 0) -> str:
    """**旧格式**：`datetime.now().isoformat()` 的形态 —— 本地时间、无时区标记。

    这正是修复前 `ws/camera_ws.py` 写进 `posture_score` 的字符串。
    """
    return datetime.combine(day, dtime(hour, minute)).isoformat()


def sample_rows(days, per_day: int = 6, hour: int = 10, legacy: bool = True):
    """造采样行。`legacy=True` 用旧格式（本地无 Z），否则用契约格式。"""
    rows = []
    for day in days:
        for i in range(per_day):
            minute = i * 6
            ts = (
                legacy_local_iso(day, hour, minute)
                if legacy
                else local_day_to_iso(day, hour, minute)
            )
            rows.append((ts, 12.0, 9.0, 14.0, 72))
    return rows


def probe_contract() -> dict:
    """1) 后端产出的确实是契约格式，且与 JS 的 toISOString() 同格式。"""
    now = now_iso_ms()
    # 固定时刻往返：用 **aware UTC** 构造，这样两端对同一瞬时必须给出同一个字符串。
    # （naive datetime 会被按本地时间解释，是另一个语义 —— 上面 2b 专门在验它。）
    fixed = datetime(2026, 1, 2, 3, 4, 5, 678000, tzinfo=timezone.utc)
    return {
        "now": now,
        "now_matches_contract": bool(ISO_MS_RE.match(now)),
        "roundtrip_fixed": to_iso_ms(fixed),
        "is_iso_ms_accepts": [
            now,
            "2026-01-02T03:04:05.678Z",
        ],
        "is_iso_ms_rejects": [
            "2026-01-02T03:04:05.678",          # 无时区标记（旧格式）
            "2026-01-02T03:04:05.678+00:00",    # 带偏移但不是 Z
            "2026-01-02T03:04:05.678000Z",      # 6 位微秒
            "2026-01-02T03:04:05Z",             # 缺毫秒
            "",
        ],
    }


def probe_local_day(con: sqlite3.Connection) -> dict:
    """2) `date(ts,'localtime')` 的日归属 —— 正确性 + 旧写法的错位留证。"""
    offset = local_offset_minutes()
    today = datetime.now().astimezone().date()

    # 2a) 契约格式串的日归属必须等于"它自己的本地日"（任何时区都成立）
    clock_samples = []
    for hour, minute in ((0, 0), (9, 30), (18, 45), (23, 59)):
        ts = local_day_to_iso(today, hour, minute)
        got = con.execute("SELECT date(?, 'localtime')", (ts,)).fetchone()[0]
        clock_samples.append(
            {"local": "%02d:%02d" % (hour, minute), "ts": ts, "sql_day": got, "expect": str(today), "ok": got == str(today)}
        )

    # 2b) 旧写法（本地时间串）会被 SQLite 再减一次偏移 → 跨日
    #     构造一个"必然跨日"的本地时刻：
    #       偏移 > 0（东半球）→ 取晚间，本地串被当 UTC，再 +偏移 → 次日
    #       偏移 < 0（西半球）→ 取凌晨，本地串被当 UTC，再 +偏移 → 前一日
    #       偏移 = 0 → 无法构造，如实记 null
    legacy = None
    if offset != 0:
        hour = 20 if offset > 0 else 2
        day = today
        ts = legacy_local_iso(day, hour, 0)
        got = con.execute("SELECT date(?, 'localtime')", (ts,)).fetchone()[0]
        legacy = {
            "ts": ts,
            "hour_local": hour,
            "sql_day": got,
            "true_day": str(day),
            "misplaced": got != str(day),
            "offset_minutes": offset,
        }

    # 2c) 区间不变式：某天的 UTC 区间起点，其本地日必须还是该天；且区间连续
    bounds = []
    for delta in (-1, 0, 1):
        day = today + timedelta(days=delta)
        start, end = local_day_bounds_utc(str(day))
        nxt_start, _ = local_day_bounds_utc(str(day + timedelta(days=1)))
        got_start = con.execute("SELECT date(?, 'localtime')", (start,)).fetchone()[0]
        got_end = con.execute("SELECT date(?, 'localtime')", (end,)).fetchone()[0]
        bounds.append(
            {
                "day": str(day),
                "start": start,
                "end": end,
                "start_is_day": got_start == str(day),
                "end_is_next_day": got_end == str(day + timedelta(days=1)),
                "continuous": end == nxt_start,
                "start_is_contract": is_iso_ms(start) and is_iso_ms(end),
            }
        )

    return {
        "offset_minutes": offset,
        "clock_samples": clock_samples,
        "legacy_misplaced": legacy,
        "bounds": bounds,
    }


def probe_grouping(con: sqlite3.Connection) -> dict:
    """3) SQL 分组键（date(ts,'localtime')）与区间窗口（local_day_bounds_utc）必须同源。

    这两者是**两套独立实现**：前者交给 SQLite，后者交给 Python。归档只按其中一套
    写键、另一套取行，两者一旦漂开，「归档里的数字」与「按天查原始表算出的数字」
    就会不同 —— 而这正是 `posture_daily` 存在的全部意义。所以必须钉住。
    """
    sql_days = [
        r[0]
        for r in con.execute(
            "SELECT DISTINCT date(timestamp, 'localtime') AS d FROM posture_score ORDER BY d"
        ).fetchall()
    ]

    window = []
    for day in sql_days:
        start, end = local_day_bounds_utc(day)
        n = con.execute(
            "SELECT COUNT(*) FROM posture_score WHERE timestamp >= ? AND timestamp < ?",
            (start, end),
        ).fetchone()[0]
        window.append({"day": day, "count": n})

    sql_counts = dict(
        con.execute(
            "SELECT date(timestamp, 'localtime') AS d, COUNT(*) FROM posture_score GROUP BY d"
        ).fetchall()
    )

    return {
        "sql_days": sql_days,
        "window": window,
        "counts_match": all(sql_counts.get(w["day"]) == w["count"] for w in window),
        "total_match": sum(sql_counts.values()) == sum(w["count"] for w in window),
        "sample_total": sum(sql_counts.values()),
    }


async def probe_migration(tmpdir: str) -> dict:
    """4) 真实迁移 + 真实 rollup：格式统一、本地日不变、范围外归档保留、幂等。"""
    path = os.path.join(tmpdir, "probe.db")
    today = datetime.now().astimezone().date()
    # 原始表只覆盖「昨天 / 今天」
    raw_days = [today - timedelta(days=1), today]
    legacy_rows = sample_rows(raw_days, per_day=6, hour=10, legacy=True)
    # 🔴 必须在同一个库里混入**已经是契约格式**的记录。真实场景：移动端导出的备份
    #    导入到桌面端，那些时间戳本来就是 UTC Z。没有这一批，「转换时排除带时区标记
    #    的串」这个条件永远不会被触发，守卫对它是瞎的 —— 而无条件转换会把它们再减
    #    一次本地偏移，本地凌晨的记录会被挪到前一天。取本地 01:00 是为了让这种挪动
    #    必然跨日（否则同一时区下可能"看起来没变"）。
    native_rows = sample_rows([today], per_day=2, hour=1, legacy=False)
    all_rows = legacy_rows + native_rows

    # 归档里放三行：
    #   - 前天：**范围外**（原始表里没有）→ 迁移必须保留（它的数据源已被清理）
    #   - 昨天：错位的旧口径行 → 迁移后应被重建
    #   - 明天：纯幽灵行（旧口径把今天晚上的数据记到了明天）→ 迁移后应消失
    stale_day = today - timedelta(days=2)
    misplaced_day = today + timedelta(days=1)

    async def init():
        db = await aiosqlite.connect(path)
        # `rollup_daily` 用 `row["day"]` 取值，需要 Row 工厂
        #（真实路径上由 `apply_migrations` / `db.database.get_db()` 设置）。
        db.row_factory = aiosqlite.Row
        await db.executescript(BASELINE_SQL + DAILY_AGG_SQL)
        await db.executemany(
            "INSERT INTO posture_score (timestamp, head_angle, shoulder_diff, spine_angle, score)"
            " VALUES (?, ?, ?, ?, ?)",
            all_rows,
        )
        for day, n in ((stale_day, 999), (today - timedelta(days=1), 6), (misplaced_day, 6)):
            await db.execute(
                "INSERT INTO posture_daily (date, sample_count, score_sum, min_score,"
                " head_bad_count, shoulder_bad_count, spine_bad_count, updated_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (str(day), n, float(n * 70), 60, 0, 0, 0, "2026-01-01T00:00:00.000Z"),
            )
        await db.commit()
        return db

    async def read_daily(db_conn):
        cur = await db_conn.execute(
            "SELECT date, sample_count, score_sum, min_score, updated_at FROM posture_daily ORDER BY date"
        )
        return {r[0]: tuple(r[1:]) for r in await cur.fetchall()}

    db = await init()
    try:
        # 迁移前：确认确实是旧格式（否则这个实验什么都没验到）
        cur = await db.execute(
            "SELECT COUNT(*) FROM posture_score WHERE timestamp NOT LIKE '%Z' AND timestamp NOT LIKE '%+'"
        )
        legacy_before = (await cur.fetchone())[0]
        cur = await db.execute("SELECT date, sample_count FROM posture_daily ORDER BY date")
        daily_before = await cur.fetchall()

        # 🔴 按 rowid 记住每条的"老串"，迁移后逐条比对：只有这样才能断言
        # 「同一条记录，转换前后本地日不变」，而不是"两个集合恰好一样"。
        cur = await db.execute("SELECT rowid, timestamp FROM posture_score ORDER BY rowid")
        before_pairs = [(r[0], r[1]) for r in await cur.fetchall()]
        before_by_id = dict(before_pairs)
        # 迁移前就已经是契约格式的那些 —— 迁移必须**原样放过**它们
        native_ids = [rid for rid, ts in before_pairs if ts.endswith("Z") or "+" in ts]

        # ---- 跑真实迁移 SQL ----
        await db.executescript(TIMESTAMP_UTC_SQL)
        await db.commit()

        cur = await db.execute("SELECT rowid, timestamp FROM posture_score ORDER BY rowid")
        after_pairs = [(r[0], r[1]) for r in await cur.fetchall()]
        after_ts = [t for _, t in after_pairs]
        by_id = {i: t for i, t in after_pairs}
        # 「本地日不变」这条只对**旧格式**记录成立：旧串的前 10 位就是它当时记录的
        # 本地日。native 行（本来就是 UTC Z）的前 10 位是 **UTC 日**，不适用这条 ——
        # 它们由 native_untouched 单独断言「原样未动」。
        native_id_set = set(native_ids)
        day_preserved = []
        for rid, old in before_pairs:
            if rid in native_id_set:
                continue
            new = by_id.get(rid)
            if new is None:
                day_preserved.append(False)
                continue
            cur = await db.execute("SELECT date(?, 'localtime')", (new,))
            got = (await cur.fetchone())[0]
            day_preserved.append(got == old[:10])
        native_untouched = all(by_id.get(rid) == before_by_id[rid] for rid in native_ids)

        # ---- 跑真实 rollup ----
        await rollup_daily(db)
        daily_after_1 = await read_daily(db)
        # 归档的日期集合必须等于原始表按本地日分组的集合
        cur = await db.execute(
            "SELECT DISTINCT date(timestamp, 'localtime') FROM posture_score"
        )
        expected_days = sorted(r[0] for r in await cur.fetchall())

        # ---- 幂等：再跑一次迁移 + rollup ----
        await db.executescript(TIMESTAMP_UTC_SQL)
        await db.commit()
        await rollup_daily(db)
        daily_after_2 = await read_daily(db)

        # ---- 归档数字与区间窗口同源 ----
        counts_match = []
        for day in expected_days:
            start, end = local_day_bounds_utc(day)
            cur = await db.execute(
                "SELECT COUNT(*) FROM posture_score WHERE timestamp >= ? AND timestamp < ?",
                (start, end),
            )
            n = (await cur.fetchone())[0]
            row = daily_after_1.get(day)
            counts_match.append(row is not None and row[0] == n)

        # ---- 总量守恒 ----
        # 不管怎么切天，各天样本数之和必须等于原始表总行数。窗口若错位（例如把
        # 本地零点换成 UTC 零点），本地凌晨那部分样本会被**静默漏掉** —— 上面那条
        # 「归档 == 窗口」反而恒成立（rollup 用的就是同一个窗口），只有总量守恒能抓住。
        #
        # ⚠️ 口径：只统计**原始表覆盖范围内**的归档天。范围外的那些行（`stale_day`）
        # 是迁移刻意保留的 —— 它们的数据源早已被保留策略清理，不属于本次求和的总体。
        cur = await db.execute("SELECT COUNT(*) FROM posture_score")
        raw_total = (await cur.fetchone())[0]
        floor_day = expected_days[0] if expected_days else ""
        covered_days = sorted(k for k in daily_after_1 if k >= floor_day)
        archived_days_exact = covered_days == expected_days
        archived_total = sum(daily_after_1[k][0] for k in covered_days)
        total_conserved = archived_total == raw_total
    finally:
        await db.close()

    return {
        "legacy_rows_before": legacy_before,
        "legacy_count": len(legacy_rows),
        "native_count": len(native_rows),
        "native_ids_found": len(native_ids),
        "native_untouched": native_untouched,
        "total_rows": len(all_rows),
        "daily_before": [list(r) for r in daily_before],
        "all_after_contract": all(is_iso_ms(t) for t in after_ts),
        "after_sample": after_ts[:2],
        "local_day_preserved": all(day_preserved),
        "stale_day": str(stale_day),
        "stale_day_kept": str(stale_day) in daily_after_1,
        "stale_day_count_kept": daily_after_1.get(str(stale_day), (None,))[0],
        "misplaced_day": str(misplaced_day),
        "misplaced_day_removed": str(misplaced_day) not in daily_after_1,
        "expected_days": expected_days,
        "daily_after": {k: list(v) for k, v in daily_after_1.items()},
        "counts_match": all(counts_match),
        "counts_checked": len(counts_match),
        "total_conserved": total_conserved,
        "archived_days_exact": archived_days_exact,
        "raw_total": raw_total,
        "archived_total": archived_total,
        "idempotent": {
            k: daily_after_1[k][:3] == daily_after_2.get(k, (None, None, None))[:3]
            for k in daily_after_1
        },
        "idempotent_days_same": sorted(daily_after_1) == sorted(daily_after_2),
    }


def main() -> None:
    con = sqlite3.connect(":memory:")
    con.executescript(BASELINE_SQL)
    # 分组一致性实验的数据：把契约格式的采样铺在 3 天上
    today = datetime.now().astimezone().date()
    days = [today - timedelta(days=2), today - timedelta(days=1), today]
    rows = sample_rows(days, per_day=5, hour=10, legacy=False)
    con.executemany(
        "INSERT INTO posture_score (timestamp, head_angle, shoulder_diff, spine_angle, score)"
        " VALUES (?, ?, ?, ?, ?)",
        rows,
    )
    # 🔴 再加两条**压日界**的样本，这是本守卫灵敏度的一半：
    #   - 本地 01:00，放在**最早那天**：在 UTC+8 下它属于 UTC 的**前一天**
    #     （该日 17:00Z），而"按 UTC 零点切天"的窗口从最早那天的 00:00Z 起 ——
    #     这条样本会落在所有窗口之外被**静默漏掉**，由 grouping.total_match（总量守恒）
    #     抓住。⚠️ 一开始放在"今天"是抓不住的（UTC 零点窗口照样覆盖得到它），那条
    #     断言就成了摆设 —— 这是变异测试 M5 跑出来的。
    #   - 本地 23:30（今天）：属于 UTC 的同一天，用来确认"没漏"不是靠运气。
    for day, hour, minute in ((today - timedelta(days=2), 1, 0), (today, 23, 30)):
        con.execute(
            "INSERT INTO posture_score (timestamp, head_angle, shoulder_diff, spine_angle, score)"
            " VALUES (?, ?, ?, ?, ?)",
            (local_day_to_iso(day, hour, minute), 12.0, 9.0, 14.0, 72),
        )

    with tempfile.TemporaryDirectory() as tmp:
        payload = {
            "contract": probe_contract(),
            "local_day": probe_local_day(con),
            "grouping": probe_grouping(con),
            "migration": asyncio.run(probe_migration(tmp)),
        }

    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
