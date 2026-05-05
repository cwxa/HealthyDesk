import asyncio
import logging
from datetime import datetime, date, timedelta
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from db.database import get_db
from config import REMINDER_INTERVAL_MINUTES

logger = logging.getLogger("neckguardian.scheduler")

_scheduler: AsyncIOScheduler = None
_accumulated_minutes = 0
_last_tick: datetime = None
_on_remind_callback = None
_break_active = False
_pending_reminder = False
_forced_reminder_at: datetime = None
_last_triggered: datetime = None
_reminder_interval = REMINDER_INTERVAL_MINUTES
_startup_triggered = False
_startup_reminder_active = False  # Flag for mandatory startup reminder


def set_remind_callback(cb):
    global _on_remind_callback
    _on_remind_callback = cb


async def _init_interval() -> int:
    """Initialize reminder interval from database on startup."""
    global _reminder_interval
    try:
        db = await get_db()
        cursor = await db.execute("SELECT value FROM settings WHERE key='reminder_interval'")
        row = await cursor.fetchone()
        await db.close()
        if row:
            val = int(row["value"])
            if val >= 2:
                _reminder_interval = val
                logger.info("Loaded reminder_interval from database: %d", _reminder_interval)
                return _reminder_interval
    except Exception as e:
        logger.warning("Failed to load reminder_interval: %s", e)
    logger.info("Using default reminder_interval: %d", _reminder_interval)
    return _reminder_interval


async def _load_reminder_interval() -> int:
    global _reminder_interval
    try:
        db = await get_db()
        cursor = await db.execute("SELECT value FROM settings WHERE key='reminder_interval'")
        row = await cursor.fetchone()
        await db.close()
        if row:
            val = int(row["value"])
            if val >= 2:
                _reminder_interval = val
    except Exception as e:
        logger.warning("Failed to load reminder_interval: %s", e)
    return _reminder_interval


async def reload_reminder_interval():
    """Called when settings change — re-read interval and reset timer."""
    global _accumulated_minutes, _break_active
    old = _reminder_interval
    await _load_reminder_interval()
    if _reminder_interval != old:
        _accumulated_minutes = 0
        _break_active = False
        logger.info("Reminder interval changed: %d → %d min", old, _reminder_interval)


def start_scheduler():
    global _scheduler, _last_tick, _startup_triggered, _break_active, _pending_reminder, _accumulated_minutes, _startup_reminder_active
    _scheduler = AsyncIOScheduler()
    _scheduler.add_job(_minute_tick, "interval", minutes=1, id="usage_tick")
    _scheduler.start()
    _last_tick = datetime.now()
    _startup_triggered = False  # Reset to ensure mandatory startup reminder triggers
    _startup_reminder_active = False  # Reset startup reminder state
    _break_active = False       # Reset break state
    _pending_reminder = False   # Reset pending reminder state
    _accumulated_minutes = 0    # Reset timer to start fresh
    logger.info("=== SCHEDULER STARTED ===")
    logger.info("Reminder interval: %d minutes", _reminder_interval)
    logger.info("All state variables reset, ready for mandatory startup reminder")
    
    # Schedule immediate reminder after a short delay to ensure everything is ready
    asyncio.create_task(_trigger_immediate_reminder())


async def _trigger_immediate_reminder():
    """Trigger an immediate reminder shortly after startup - this is mandatory."""
    global _break_active, _pending_reminder, _last_triggered, _startup_triggered, _on_remind_callback, _accumulated_minutes, _startup_reminder_active
    
    logger.info("Waiting 5 seconds for system initialization before mandatory startup reminder...")
    await asyncio.sleep(5)
    
    if _startup_triggered:
        logger.warning("Startup reminder already triggered, skipping duplicate")
        return
        
    _startup_triggered = True
    _startup_reminder_active = True  # Mark this as a mandatory startup reminder
    _break_active = True
    _pending_reminder = True
    _accumulated_minutes = 0  # Reset timer to ensure clean state after startup reminder
    _last_triggered = datetime.now()
    logger.info("=== MANDATORY STARTUP REMINDER TRIGGERED ===")
    logger.info("This is a FORCED startup reminder - user MUST complete the activity")
    logger.info("Break session activated, timer reset to 0")
    
    if _on_remind_callback:
        logger.debug("Calling remind callback to notify frontend")
        await _on_remind_callback()


def stop_scheduler():
    global _scheduler
    if _scheduler:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("Scheduler stopped")


async def _minute_tick():
    global _accumulated_minutes, _last_tick, _break_active, _pending_reminder, _forced_reminder_at, _last_triggered, _startup_reminder_active
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

        # During mandatory startup reminder, skip timer increment until activity is completed
        if not _startup_reminder_active:
            _accumulated_minutes += 1
        
        interval = _reminder_interval
        
        # Log every tick for debugging
        if _accumulated_minutes % 5 == 0 or _accumulated_minutes <= 3:
            logger.info("Tick: accumulated=%d/%d min, break_active=%s, startup_reminder=%s, pending=%s",
                        _accumulated_minutes, interval, _break_active, _startup_reminder_active, _pending_reminder)

        # Check forced reminder (snooze override) - only allowed after startup reminder is done
        if _forced_reminder_at and now >= _forced_reminder_at and not _startup_reminder_active:
            _forced_reminder_at = None
            _accumulated_minutes = 0
            _break_active = True
            _pending_reminder = True
            _last_triggered = now
            logger.info("=== FORCED REMINDER TRIGGERED (after snooze) ===")
            if _on_remind_callback:
                await _on_remind_callback()
        elif _accumulated_minutes >= interval and not _break_active and not _startup_reminder_active:
            _accumulated_minutes = 0
            _break_active = True
            _pending_reminder = True
            _last_triggered = now
            logger.info("=== REGULAR REMINDER TRIGGERED after %d minutes ===", interval)
            logger.info("Setting pending=True, last_triggered=%s", _last_triggered.isoformat())
            if _on_remind_callback:
                logger.info("Calling WebSocket remind callback")
                await _on_remind_callback()
            else:
                logger.warning("No WebSocket callback set - reminder will only be detected by polling")

    except Exception as e:
        logger.error("Scheduler tick error: %s", e)
    finally:
        await db.close()


def end_break_session():
    """End the current break session and reset timer for next reminder.
    
    This function is called when:
    1. User completes the exercise activity
    2. User manually ends the break session
    
    Critical behavior:
    - Resets the accumulated minutes timer to 0 to start fresh count for next reminder
    - Clears the startup reminder flag if this was a mandatory startup activity
    - Ensures continuous timing for the next reminder cycle
    """
    global _break_active, _accumulated_minutes, _pending_reminder, _forced_reminder_at, _startup_reminder_active
    
    was_startup_reminder = _startup_reminder_active
    prev_break_active = _break_active
    
    _break_active = False
    _accumulated_minutes = 0  # Critical: Reset timer to start counting from 0 for next reminder
    _pending_reminder = False
    _forced_reminder_at = None
    _startup_reminder_active = False  # Clear startup reminder flag - activity completed
    
    logger.info("=== BREAK SESSION ENDED ===")
    logger.info("Previous break active state: %s", prev_break_active)
    logger.info("Was startup reminder: %s", was_startup_reminder)
    logger.info("Timer reset to 0, next reminder will trigger after %d minutes", _reminder_interval)
    logger.info("Continuous timing started for next reminder cycle")


def snooze_break(minutes: int = 5):
    """Snooze the reminder for specified minutes and reset timer.
    
    Note: Snooze is NOT allowed during mandatory startup reminder.
    The startup reminder must be completed by the user.
    """
    global _break_active, _accumulated_minutes, _pending_reminder, _forced_reminder_at, _startup_reminder_active
    
    if _startup_reminder_active:
        logger.warning("Snooze attempted during mandatory startup reminder - IGNORED")
        logger.warning("User must complete the startup activity before snoozing is allowed")
        return
        
    _break_active = False
    _accumulated_minutes = 0  # Reset timer since snooze creates a forced reminder
    _pending_reminder = False
    _forced_reminder_at = datetime.now() + timedelta(minutes=minutes)
    logger.info("=== REMINDER SNOOZED ===")
    logger.info("Snooze duration: %d minutes", minutes)
    logger.info("Forced reminder scheduled at: %s", _forced_reminder_at.isoformat())


def is_break_active() -> bool:
    return _break_active


def get_reminder_status() -> dict:
    now = datetime.now()
    if _pending_reminder:
        return {
            "pending": True, 
            "next_reminder": None, 
            "snooze_until": None, 
            "last_triggered": _last_triggered.isoformat() if _last_triggered else None,
            "is_startup_reminder": _startup_reminder_active,
            "break_active": _break_active
        }
    if _forced_reminder_at:
        return {
            "pending": False, 
            "next_reminder": _forced_reminder_at.isoformat(), 
            "snooze_until": _forced_reminder_at.isoformat(), 
            "last_triggered": _last_triggered.isoformat() if _last_triggered else None,
            "is_startup_reminder": False,
            "break_active": False
        }
    remaining = max(0, _reminder_interval - _accumulated_minutes)
    next_time = now + timedelta(minutes=remaining)
    return {
        "pending": False, 
        "next_reminder": next_time.isoformat(), 
        "snooze_until": None, 
        "last_triggered": _last_triggered.isoformat() if _last_triggered else None,
        "is_startup_reminder": False,
        "break_active": False
    }


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
