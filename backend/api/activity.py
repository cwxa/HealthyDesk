import logging
from datetime import datetime
from typing import Optional

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
    # 逐动作明细：**规范 JSON 文本**（见 services/exercise_quality.serialize_action_scores）。
    #
    # 为什么是 str 而不是结构化字段：导出格式的字段类型只有 num / str 两态，
    # 声明成结构化类型会迫使导入端**重新序列化**，"导出→导入→再导出必须是同一个文件"
    # 就不再由构造保证。存成文本后它全程是不透明数据。
    # 缺省 None 有两个来源，界面都要当成"没有这份数据"：老客户端不带该字段；
    # 老记录（迁移 5 之前写入的行）该列为 NULL。
    action_scores: Optional[str] = None


@router.post("/activity/record")
async def record_activity(record: ActivityRecord):
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO activity_log"
            " (timestamp, activity_type, exercise_count, duration_sec, avg_score, action_scores) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (record.timestamp, record.activity_type, record.exercise_count,
             record.duration_sec, record.avg_score, record.action_scores),
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
