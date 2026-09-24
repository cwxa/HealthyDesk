import logging
from fastapi import APIRouter
from db.database import get_db
from config import REMINDER_INTERVAL_MINUTES
from services.part_health import compute_part_health
# 统一取整口径：内置 round() 基于精确二进制值，JS 侧无法复刻，
# 会在平局点上让手机与电脑显示不同的数字（见 services/rounding.py）。
from services.rounding import round_1, round_int

logger = logging.getLogger("neckguardian.api.stats")
router = APIRouter(tags=["stats"])


@router.get("/stats/weekly")
async def get_weekly_report():
    db = await get_db()
    try:
        # Weekly posture score average
        cursor = await db.execute(
            "SELECT AVG(score) as avg_score "
            "FROM posture_score WHERE timestamp >= date('now', '-7 days')"
        )
        row = await cursor.fetchone()
        posture_avg = round_1(row["avg_score"]) if row["avg_score"] else 0

        # Weekly activity count from activity_log
        cursor = await db.execute(
            "SELECT COUNT(*) as count "
            "FROM activity_log WHERE timestamp >= date('now', '-7 days')"
        )
        row = await cursor.fetchone()
        weekly_activities = row["count"]

        # Weekly total exercise duration from activity_log
        cursor = await db.execute(
            "SELECT COALESCE(SUM(duration_sec), 0) as total_sec "
            "FROM activity_log WHERE timestamp >= date('now', '-7 days')"
        )
        row = await cursor.fetchone()
        total_exercise_sec = row["total_sec"]

        # Usage records
        cursor = await db.execute(
            "SELECT SUM(usage_minutes) as total_min, SUM(break_count) as total_breaks "
            "FROM usage_record WHERE date >= date('now', '-7 days')"
        )
        row = await cursor.fetchone()
        total_minutes = row["total_min"] or 0
        total_breaks = row["total_breaks"] or 0

        # 完成率 = 实际活动次数 / 应休息次数。
        # 应休息次数按使用时长与提醒间隔估算（此前固定按 30 分钟，
        # 且未考虑用户自定义间隔，导致数值失真）。
        expected_breaks = max(1, round_int(total_minutes / max(1, REMINDER_INTERVAL_MINUTES)))
        completion_rate = round_1(min(100, (weekly_activities / expected_breaks) * 100)) if expected_breaks > 0 else 0

        # Trend: daily average score
        cursor = await db.execute(
            "SELECT date(timestamp) as day, AVG(score) as avg_score "
            "FROM posture_score WHERE timestamp >= date('now', '-7 days') "
            "GROUP BY day ORDER BY day"
        )
        trend = [{"day": r["day"], "avg_score": round_1(r["avg_score"])} for r in await cursor.fetchall()]

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
        # Today's activity count
        cursor = await db.execute(
            "SELECT COUNT(*) as count FROM activity_log WHERE timestamp >= date('now')"
        )
        row = await cursor.fetchone()
        today_activities = row["count"]

        # Today's average posture score
        # 窗口是**自然日**（date('now')），与 today_activities 一致；此前写的是
        # date('now','-1 days')（滚动 24 小时），导致同一张卡片里两个「今日」口径不同，
        # 且与移动端 localStats 的自然日口径对不上 —— 两端会显示不同的"今日平均分"。
        cursor = await db.execute(
            "SELECT AVG(score) as avg_score FROM posture_score "
            "WHERE timestamp >= date('now')"
        )
        row = await cursor.fetchone()
        today_avg = round_1(row["avg_score"]) if row["avg_score"] else 0

        # 部位健康度：从三个分项字段真实聚合（此前 Dashboard 是编造的，见 part_health.py）
        # 与 today_avg 取同一窗口，卡片内各数值口径一致。
        cursor = await db.execute(
            "SELECT head_angle, shoulder_diff, spine_angle FROM posture_score "
            "WHERE timestamp >= date('now')"
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
