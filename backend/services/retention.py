"""数据保留与日聚合维护（桌面端）。

## 为什么需要它

`posture_score` 此前**只增不删**：`NeckActivity` 每 1500ms 写一条，全仓库没有任何
清理逻辑 —— 按每天 8 小时算约 **1.9 万条/天、57 万条/月**。移动端 IndexedDB 更是
"卸载即清除"，攒下的数据没有任何出路。

本模块做两件事，**顺序不可颠倒**：

1. `rollup_daily` —— 先把每天的原始采样折成一行归档（`posture_daily`）
2. `prune_raw`   —— 再删掉超出保留期的原始采样

若反过来先删，被删那天的数据就**永久消失**了（归档还没写）。`maintain()` 把顺序
固定在函数里，调用方不需要记住这条规则。

## 索引友好性

原始表约 1.9 万行/天，而迁移 2 建了 `idx_posture_score_ts`。因此这里所有按天过滤
都走**时间列的范围查询**（先算出本地日对应的 UTC 瞬时区间），而不是
`WHERE date(timestamp,'localtime') = ?` —— 对列做表达式会让索引失效，退化成全表扫描。
"""

import logging
import os
from datetime import datetime, timedelta, timezone

from config import DB_PATH, RETENTION_DAYS, clamp_retention_days
from services.daily_agg import aggregate_day

logger = logging.getLogger("neckguardian.retention")

SETTING_KEY = "retention_days"


def _iso(dt: datetime) -> str:
    """与前端 `new Date().toISOString()` **同格式**（毫秒 + `Z`）。

    这很关键：只有格式一致，字符串比较才等价于时间比较（`timestamp < ?` 这类
    WHERE 才能正确工作）。前端写库用的就是 `toISOString()`。
    """
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def local_day_bounds_utc(day: str) -> tuple[str, str]:
    """本地日历日 `YYYY-MM-DD` → 其对应的 UTC 瞬时区间 `[start, end)`（ISO 串）。

    用**本地**日历日而不是 UTC 日：用户在 UTC+8 早上 7 点坐着，那属于"今天"。
    移动端 `localStats.dateKey()` 用的也是本地日期，两端必须同一天边界，
    否则导出的数据在两端会落在不同的 `date` 上。
    """
    start = datetime.strptime(day, "%Y-%m-%d").astimezone()  # naive → 按本地时区解释
    return _iso(start), _iso(start + timedelta(days=1))


def today_local() -> str:
    return datetime.now().astimezone().strftime("%Y-%m-%d")


async def rollup_daily(db) -> int:
    """把原始采样折成 `posture_daily`，只重算**样本数发生变化**的日期。

    返回被重算的天数。今天的样本数一直在变，所以每次调用都会重算今天 ——
    这是有意的（否则今天的归档永远是过期的），代价只有一天的量级。

    幂等：重复调用结果相同（同一天的重算结果一致）。
    """
    cursor = await db.execute(
        "SELECT p.day AS day, p.n AS n, COALESCE(d.sample_count, -1) AS stored "
        "FROM (SELECT date(timestamp, 'localtime') AS day, COUNT(*) AS n "
        "      FROM posture_score GROUP BY day) p "
        "LEFT JOIN posture_daily d ON d.date = p.day"
    )
    pending = [r for r in await cursor.fetchall() if r["day"] is not None and r["n"] != r["stored"]]

    stamp = _iso(datetime.now(timezone.utc))
    updated = 0
    for row in pending:
        day = row["day"]
        start_iso, end_iso = local_day_bounds_utc(day)
        rows = await db.execute(
            "SELECT head_angle, shoulder_diff, spine_angle, score FROM posture_score "
            "WHERE timestamp >= ? AND timestamp < ?",
            (start_iso, end_iso),
        )
        agg = aggregate_day(await rows.fetchall())
        await db.execute(
            "INSERT INTO posture_daily (date, sample_count, score_sum, min_score,"
            " head_bad_count, shoulder_bad_count, spine_bad_count, updated_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
            " ON CONFLICT(date) DO UPDATE SET"
            " sample_count=excluded.sample_count, score_sum=excluded.score_sum,"
            " min_score=excluded.min_score, head_bad_count=excluded.head_bad_count,"
            " shoulder_bad_count=excluded.shoulder_bad_count, spine_bad_count=excluded.spine_bad_count,"
            " updated_at=excluded.updated_at",
            (
                day,
                agg["sample_count"],
                agg["score_sum"],
                agg["min_score"],
                agg["head_bad_count"],
                agg["shoulder_bad_count"],
                agg["spine_bad_count"],
                stamp,
            ),
        )
        updated += 1

    if updated:
        await db.commit()
        logger.info("日聚合已更新 %d 天（最近：%s）", updated, pending[-1]["day"])
    return updated


async def prune_raw(db, keep_days: int = RETENTION_DAYS) -> int:
    """删除超出保留期的原始采样，返回删除条数。

    ⚠️ 只能在本轮 `rollup_daily` **之后**调用（见模块顶部说明）。
    保留边界是"本地今天往前数 keep_days 天的零点" —— 即保留最近
    `keep_days + 1` 个自然日（含今天），与 `RETENTION_DAYS = 30` 的直觉一致。
    """
    if keep_days <= 0:
        return 0
    cutoff_day = (datetime.now().astimezone() - timedelta(days=keep_days)).strftime("%Y-%m-%d")
    start_iso, _ = local_day_bounds_utc(cutoff_day)
    cursor = await db.execute("DELETE FROM posture_score WHERE timestamp < ?", (start_iso,))
    deleted = cursor.rowcount if cursor.rowcount and cursor.rowcount > 0 else 0
    await db.commit()
    if deleted:
        # VACUUM 不做：它需要重建整个文件，代价远大于它回收的空间；
        # SQLite 会把空闲页留给后续插入复用（SQLite 本就是复用空闲页的）。
        logger.info("已清理 %d 条超期原始采样（保留最近 %d 天）", deleted, keep_days)
    return deleted


async def retention_days(db) -> int:
    """用户设置的保留天数（settings 键 `retention_days`），非法/缺失时回落默认值。

    每次维护时读一次而不是缓存在内存里：设置页改完立刻生效，不需要重启后端。
    """
    try:
        cursor = await db.execute("SELECT value FROM settings WHERE key = ?", (SETTING_KEY,))
        row = await cursor.fetchone()
        if row is None:
            return RETENTION_DAYS
        return clamp_retention_days(row["value"])
    except Exception as e:
        logger.warning("读取 %s 失败，回落默认 %d 天：%s", SETTING_KEY, RETENTION_DAYS, e)
        return RETENTION_DAYS


async def maintain(db, keep_days: int | None = None) -> dict:
    """先聚合、后清理。启动时与后台定时任务都调用它。

    `keep_days=None`（默认）时读用户设置，避免调用方各自决定保留期。
    """
    days = keep_days if keep_days is not None else await retention_days(db)
    rolled = await rollup_daily(db)
    deleted = await prune_raw(db, days)
    return {"days_rolled_up": rolled, "samples_deleted": deleted, "keep_days": days}


def retention_summary_sync() -> dict:
    """同步读取存储与保留状态（给 API 用：不修改数据，只报告）。"""
    import sqlite3

    con = sqlite3.connect(DB_PATH)
    try:
        cur = con.execute("SELECT COUNT(*) FROM posture_score")
        raw_count = cur.fetchone()[0]
        cur = con.execute("SELECT COUNT(*), MIN(date), MAX(date) FROM posture_daily")
        days, first_day, last_day = cur.fetchone()
        cur = con.execute("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
        row = cur.fetchone()
        schema_version = row[0] if row else 0
        cur = con.execute("SELECT value FROM settings WHERE key = ?", (SETTING_KEY,))
        row = cur.fetchone()
        configured = clamp_retention_days(row[0]) if row else RETENTION_DAYS
    finally:
        con.close()

    try:
        db_bytes = os.path.getsize(DB_PATH)
    except OSError:
        db_bytes = 0

    return {
        "raw_samples": raw_count,
        "daily_rows": days or 0,
        "first_day": first_day,
        "last_day": last_day,
        "keep_days": configured,
        "default_keep_days": RETENTION_DAYS,
        "schema_version": schema_version,
        "db_bytes": db_bytes,
    }
