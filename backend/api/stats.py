import logging
import time

from fastapi import APIRouter
from db.database import get_db
from config import REMINDER_INTERVAL_MINUTES
from services.part_health import compute_part_health
from services.daily_agg import daily_avg_score
from services.retention import rollup_daily
# 统一取整口径：内置 round() 基于精确二进制值，JS 侧无法复刻，
# 会在平局点上让手机与电脑显示不同的数字（见 services/rounding.py）。
from services.rounding import round_1, round_int

logger = logging.getLogger("neckguardian.api.stats")
router = APIRouter(tags=["stats"])

# ---------------------------------------------------------------------------
# 日期口径（两端必须一致，见 ROADMAP 需求 4）
#
# 此前这里混用了两种"今天"：
#   - `timestamp >= date('now')`            → UTC 零点到现在的滚动窗口
#   - 移动端 `dateKey(ts) === 今天`          → **本地**自然日
# 在 UTC+8，凌晨 0–8 点这两个口径会落在不同的一天上，同一张卡片里两个「今日」
# 也会互相打架。现统一为**本地自然日**：`date(<ts>, 'localtime')`。
#
# 同样的原因，按天分组也必须用本地日 —— 否则趋势图的 day 键与移动端对不上，
# 导出的数据在两端会落到不同的 date 上。
# ---------------------------------------------------------------------------
LOCAL_DAY = "date({col}, 'localtime')"
TODAY = "date('now', 'localtime')"

# 归档刷新节流：`rollup_daily` 要对原始表做一次分组统计，不宜每次请求都跑。
_ROLLUP_MIN_INTERVAL_SEC = 60.0
_last_rollup_at = 0.0


async def _ensure_daily_fresh(db) -> None:
    """保证本次读取前 `posture_daily` 是新的（带节流）。

    为什么必须在读之前刷新，而不是只靠定时任务：今天的归档在一天之内一直在变，
    若只靠 30 分钟一次的定时任务，用户在 Dashboard 上会看到"今天的均分"停在
    半小时前 —— 而「用户看到的数字必须是当前数据算出来的」是本项目的铁律。
    """
    global _last_rollup_at
    now = time.monotonic()
    if now - _last_rollup_at < _ROLLUP_MIN_INTERVAL_SEC:
        return
    _last_rollup_at = now
    try:
        await rollup_daily(db)
    except Exception as e:  # 归档失败不应让统计接口整体失败
        logger.error("日聚合刷新失败：%s", e)


async def _daily_rows(db, since_expr: str):
    """取窗口内的归档行（精确量）。"""
    cursor = await db.execute(
        "SELECT date, sample_count, score_sum, min_score,"
        " head_bad_count, shoulder_bad_count, spine_bad_count"
        " FROM posture_daily WHERE date >= ? ORDER BY date",
        (since_expr,),
    )
    return await cursor.fetchall()


def _windowed_avg(rows) -> float:
    """窗口内的加权均分 = Σscore_sum / Σsample_count。

    由归档行现算而不是再查一次原始表：这样「趋势里的某天」与「周均分」必然同源，
    不会出现"趋势图上是 88.2、周均分算出 88.4"这种没法解释的差。
    """
    total = 0.0
    count = 0
    for r in rows:
        n = int(r["sample_count"])
        if n <= 0:
            continue
        total += float(r["score_sum"])
        count += n
    return round_1(total / count) if count > 0 else 0


@router.get("/stats/weekly")
async def get_weekly_report():
    db = await get_db()
    try:
        await _ensure_daily_fresh(db)

        # 近 7 天（本地自然日）：today-7 .. today，共 8 个自然日。
        # 与移动端 localStats.withinDays(ts, 7)（本地零点起算）同一口径。
        cursor = await db.execute("SELECT date('now','localtime','-7 days') AS s")
        since = (await cursor.fetchone())["s"]

        daily = await _daily_rows(db, since)
        posture_avg = _windowed_avg(daily)

        # Weekly activity count / duration from activity_log（本地自然日窗口）
        cursor = await db.execute(
            f"SELECT COUNT(*) AS count, COALESCE(SUM(duration_sec), 0) AS total_sec"
            f" FROM activity_log WHERE {LOCAL_DAY.format(col='timestamp')} >= ?",
            (since,),
        )
        row = await cursor.fetchone()
        weekly_activities = row["count"]
        total_exercise_sec = row["total_sec"]

        # Usage records
        cursor = await db.execute(
            "SELECT SUM(usage_minutes) as total_min, SUM(break_count) as total_breaks "
            "FROM usage_record WHERE date >= ?",
            (since,),
        )
        row = await cursor.fetchone()
        total_minutes = row["total_min"] or 0
        total_breaks = row["total_breaks"] or 0

        # 完成率 = 实际活动次数 / 应休息次数。
        # 应休息次数按使用时长与提醒间隔估算（此前固定按 30 分钟，
        # 且未考虑用户自定义间隔，导致数值失真）。
        expected_breaks = max(1, round_int(total_minutes / max(1, REMINDER_INTERVAL_MINUTES)))
        completion_rate = round_1(min(100, (weekly_activities / expected_breaks) * 100)) if expected_breaks > 0 else 0

        # Trend: 每天的均分 —— 直接消费归档行，不再单独 GROUP BY 原始表
        # （那样是第二份实现，日期口径迟早会跟归档漂开）。
        trend = [{"day": r["date"], "avg_score": daily_avg_score(dict(r))} for r in daily]

        return {
            "posture_avg": posture_avg,
            "weekly_activities": weekly_activities,
            "total_exercise_sec": total_exercise_sec,
            "total_minutes": total_minutes,
            "total_breaks": total_breaks,
            "completion_rate": completion_rate,
            "trend": trend,
        }
    finally:
        await db.close()


@router.get("/stats/summary")
async def get_summary():
    db = await get_db()
    try:
        await _ensure_daily_fresh(db)

        cursor = await db.execute(
            f"SELECT COUNT(*) as count FROM activity_log WHERE {LOCAL_DAY.format(col='timestamp')} = {TODAY}"
        )
        row = await cursor.fetchone()
        today_activities = row["count"]

        # 今日均分：消费归档行（今天这一天）。归档里没有今天 → 今天还没有采样 → 0。
        cursor = await db.execute(
            "SELECT sample_count, score_sum FROM posture_daily WHERE date = " + TODAY
        )
        row = await cursor.fetchone()
        today_avg = daily_avg_score(dict(row)) if row else 0

        # 部位健康度：从三个分项字段真实聚合（此前 Dashboard 是编造的，见 part_health.py）。
        # ⚠️ 这一项**不能**从 posture_daily 推出来 —— 它是「单项扣分的时间平均」，
        # 而扣分随超出阈值的程度连续变化，无法由计数还原。所以读今天的原始行
        # （今天的原始采样永远不会被保留策略清掉，见 services/retention.py）。
        cursor = await db.execute(
            f"SELECT head_angle, shoulder_diff, spine_angle FROM posture_score "
            f"WHERE {LOCAL_DAY.format(col='timestamp')} = {TODAY}"
        )
        part_health = compute_part_health(await cursor.fetchall())

        # Latest activity score
        cursor = await db.execute(
            "SELECT avg_score FROM activity_log ORDER BY timestamp DESC LIMIT 1"
        )
        row = await cursor.fetchone()
        latest_score = row["avg_score"] if row else 0

        return {
            "today_activities": today_activities,
            "today_avg": today_avg,
            "latest_score": latest_score,
            "part_health": part_health,
        }
    finally:
        await db.close()


@router.get("/stats/daily")
async def get_daily_history(days: int = 30):
    """日粒度历史（归档层）。

    这是 `posture_daily` 存在的意义：原始采样只留最近 30 天，而这一层长期保留，
    所以「更长时间跨度的趋势」只能从这里取。返回全部**精确量**，
    派生量（均分、各问题占比）由调用方用同一套函数现算，不在这里预先取整。
    """
    days = max(1, min(365, int(days)))
    db = await get_db()
    try:
        await _ensure_daily_fresh(db)
        cursor = await db.execute(
            "SELECT date, sample_count, score_sum, min_score,"
            " head_bad_count, shoulder_bad_count, spine_bad_count"
            " FROM posture_daily WHERE date >= date('now','localtime', ?) ORDER BY date",
            (f"-{days} days",),
        )
        rows = await cursor.fetchall()
        return [
            {
                "date": r["date"],
                "sample_count": r["sample_count"],
                "score_sum": r["score_sum"],
                "min_score": r["min_score"],
                "head_bad_count": r["head_bad_count"],
                "shoulder_bad_count": r["shoulder_bad_count"],
                "spine_bad_count": r["spine_bad_count"],
                "avg_score": daily_avg_score(dict(r)),
            }
            for r in rows
        ]
    finally:
        await db.close()
