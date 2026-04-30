import asyncio
import logging
from datetime import datetime, date
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from db.database import get_db
from config import REMINDER_INTERVAL_MINUTES

logger = logging.getLogger("neckguardian.scheduler")

_scheduler: AsyncIOScheduler = None
_accumulated_minutes = 0
_last_tick: datetime = None
_on_remind_callback = None
_break_active = False


def set_remind_callback(cb):
    global _on_remind_callback
    _on_remind_callback = cb


def start_scheduler():
    global _scheduler, _last_tick
    _scheduler = AsyncIOScheduler()
    _scheduler.add_job(_minute_tick, "interval", minutes=1, id="usage_tick")
    _scheduler.start()
    _last_tick = datetime.now()
    logger.info("Scheduler started, reminder interval=%d min", REMINDER_INTERVAL_MINUTES)


def stop_scheduler():
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Scheduler stopped")


async def _minute_tick():
    global _accumulated_minutes, _last_tick, _break_active
    now = datetime.now()
    today_str = now.strftime("%Y-%m-%d")

    db = await get_db()
    try:
        cursor = await db.execute("SELECT usage_minutes FROM usage_record WHERE date=?", (today_str,))
        row = await cursor.fetchone()
        current = row["usage_minutes"] if row else 0
        new_total = current + 1
        await db.execute(
            "INSERT INTO usage_record (date, usage_minutes) VALUES (?, ?) "
            "ON CONFLICT(date) DO UPDATE SET usage_minutes=?",
            (today_str, new_total, new_total),
        )
        await db.commit()

        _accumulated_minutes += 1
        interval = REMINDER_INTERVAL_MINUTES
        if _accumulated_minutes >= interval and not _break_active:
            _accumulated_minutes = 0
            _break_active = True
            logger.info("Reminder triggered after %d minutes", interval)
            if _on_remind_callback:
                await _on_remind_callback()

    except Exception as e:
        logger.error("Scheduler tick error: %s", e)
    finally:
        await db.close()


def end_break_session():
    global _break_active, _accumulated_minutes
    _break_active = False
    _accumulated_minutes = 0
    logger.info("Break session ended, timer reset")


def is_break_active() -> bool:
    return _break_active


async def get_today_usage() -> dict:
    today_str = date.today().isoformat()
    db = await get_db()
    try:
        cursor = await db.execute("SELECT * FROM usage_record WHERE date=?", (today_str,))
        row = await cursor.fetchone()
        if row:
            return {"date": row["date"], "usage_minutes": row["usage_minutes"], "break_count": row["break_count"]}
        return {"date": today_str, "usage_minutes": 0, "break_count": 0}
    finally:
        await db.close()


async def record_break():
    today_str = date.today().isoformat()
    db = await get_db()
    try:
        await db.execute(
            "INSERT INTO usage_record (date, usage_minutes, break_count) VALUES (?, 0, 1) "
            "ON CONFLICT(date) DO UPDATE SET break_count=break_count+1",
            (today_str,),
        )
        await db.commit()
    finally:
        await db.close()
