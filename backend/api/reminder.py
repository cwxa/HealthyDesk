import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from services.scheduler import end_break_session, snooze_break, get_reminder_status

logger = logging.getLogger("neckguardian.api.reminder")
router = APIRouter(tags=["reminder"])


class SnoozeRequest(BaseModel):
    minutes: int = 5


@router.post("/reminder/end")
async def reminder_end():
    end_break_session()
    return {"status": "ok"}


@router.post("/reminder/snooze")
async def reminder_snooze(req: SnoozeRequest):
    if req.minutes < 1 or req.minutes > 60:
        raise HTTPException(status_code=400, detail="Snooze minutes must be between 1 and 60")
    snooze_break(req.minutes)
    return {"status": "ok", "minutes": req.minutes}


@router.get("/reminder/status")
async def reminder_status():
    return get_reminder_status()
