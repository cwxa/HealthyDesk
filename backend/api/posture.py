import logging
from datetime import datetime
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from db.database import get_db
from services.scorer import compute_score

logger = logging.getLogger("neckguardian.api.posture")
router = APIRouter(tags=["posture"])


class PostureRecord(BaseModel):
    timestamp: str
    head_angle: float
    shoulder_diff: float
    spine_angle: float
    score: int


@router.post("/posture/record")
async def record_posture(record: PostureRecord):
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO posture_score (timestamp, head_angle, shoulder_diff, spine_angle, score) VALUES (?, ?, ?, ?, ?)",
            (record.timestamp, record.head_angle, record.shoulder_diff, record.spine_angle, record.score),
        )
        await db.commit()
        logger.debug("Posture recorded: score=%d", record.score)
        return {"status": "ok"}
    except Exception as e:
        logger.error("Failed to record posture: %s", e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await db.close()


@router.get("/posture/history")
async def get_posture_history(limit: int = 100, offset: int = 0):
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT * FROM posture_score ORDER BY timestamp DESC LIMIT ? OFFSET ?",
            (limit, offset),
        )
        rows = await cursor.fetchall()
        return [dict(r) for r in rows]
    finally:
        await db.close()


@router.get("/posture/average")
async def get_posture_average(days: int = 7):
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT AVG(score) as avg_score, COUNT(*) as count "
            "FROM posture_score WHERE timestamp >= date('now', ?)",
            (f"-{days} days",),
        )
        row = await cursor.fetchone()
        avg = round(row["avg_score"], 1) if row["avg_score"] else 0
        return {"average_score": avg, "days": days, "count": row["count"]}
    finally:
        await db.close()


@router.get("/posture/trend")
async def get_posture_trend(days: int = 7):
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT date(timestamp) as day, AVG(score) as avg_score "
            "FROM posture_score WHERE timestamp >= date('now', ?) "
            "GROUP BY day ORDER BY day",
            (f"-{days} days",),
        )
        rows = await cursor.fetchall()
        return [{"day": r["day"], "avg_score": round(r["avg_score"], 1)} for r in rows]
    finally:
        await db.close()
