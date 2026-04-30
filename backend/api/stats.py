import logging
from fastapi import APIRouter
from db.database import get_db

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
        posture_avg = round(row["avg_score"], 1) if row["avg_score"] else 0

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

        expected_breaks = max(1, total_minutes // 30)
        completion_rate = round(min(100, (weekly_activities / expected_breaks) * 100), 1) if expected_breaks > 0 else 0

        # Trend: daily average score
        cursor = await db.execute(
            "SELECT date(timestamp) as day, AVG(score) as avg_score "
            "FROM posture_score WHERE timestamp >= date('now', '-7 days') "
            "GROUP BY day ORDER BY day"
        )
        trend = [{"day": r["day"], "avg_score": round(r["avg_score"], 1)} for r in await cursor.fetchall()]

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
        cursor = await db.execute(
            "SELECT AVG(score) as avg_score FROM posture_score "
            "WHERE timestamp >= date('now', '-1 days')"
        )
        row = await cursor.fetchone()
        today_avg = round(row["avg_score"], 1) if row["avg_score"] else 0

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
        }
    finally:
        await db.close()
