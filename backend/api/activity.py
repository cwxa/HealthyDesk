import logging
from datetime import datetime
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from db.database import get_db

logger = logging.getLogger("neckguardian.api.activity")
router = APIRouter(tags=["activity"])


class ActivityRecord(BaseModel):
    timestamp: str
    activity_type: str = "exercise"
    exercise_count: int = 0
    duration_sec: int = 0
    avg_score: int = 0


@router.post("/activity/record")
async def record_activity(record: ActivityRecord):
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO activity_log (timestamp, activity_type, exercise_count, duration_sec, avg_score) "
            "VALUES (?, ?, ?, ?, ?)",
            (record.timestamp, record.activity_type, record.exercise_count,
             record.duration_sec, record.avg_score),
        )
        await db.commit()
        logger.debug("Activity recorded: type=%s score=%d", record.activity_type, record.avg_score)
        return {"status": "ok"}
    except Exception as e:
        logger.error("Failed to record activity: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await db.close()


@router.get("/activity/recent")
async def get_recent_activities(limit: int = 20):
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM activity_log ORDER BY timestamp DESC LIMIT ?",
            (limit,),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


@router.get("/activity/today-count")
async def get_today_activity_count():
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT COUNT(*) as count FROM activity_log "
            "WHERE timestamp >= date('now')"
        )
        row = await cursor.fetchone()
        return {"count": row["count"]}
    finally:
        await db.close()
