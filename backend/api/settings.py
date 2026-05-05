import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from db.database import get_db
from services.scheduler import reload_reminder_interval

logger = logging.getLogger("neckguardian.api.settings")
router = APIRouter(tags=["settings"])


class SettingItem(BaseModel):
    key: str
    value: str


@router.get("/settings")
async def get_all_settings():
    db = await get_db()
    try:
        cursor = await db.execute("SELECT key, value FROM settings")
        rows = await cursor.fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        await db.close()


@router.get("/settings/{key}")
async def get_setting(key: str):
    db = await get_db()
    try:
        cursor = await db.execute("SELECT value FROM settings WHERE key=?", (key,))
        row = await cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail=f"Setting '{key}' not found")
        return {"key": key, "value": row["value"]}
    finally:
        await db.close()


@router.put("/settings")
async def update_setting(item: SettingItem):
    db = await get_db()
    try:
        if item.key == "reminder_interval":
            try:
                interval = int(item.value)
                if interval < 2:
                    raise HTTPException(status_code=400, detail="提醒间隔最少为2分钟")
            except ValueError:
                raise HTTPException(status_code=400, detail="提醒间隔必须是有效的数字")
        
        await db.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=?",
            (item.key, item.value, item.value),
        )
        await db.commit()
        logger.info("Setting updated: %s=%s", item.key, item.value)
        if item.key == "reminder_interval":
            await reload_reminder_interval()
        return {"status": "ok", "key": item.key, "value": item.value}
    finally:
        await db.close()
