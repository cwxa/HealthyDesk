import aiosqlite
import logging
import os
from config import DB_PATH

logger = logging.getLogger("neckguardian.db")

DB_DIR = os.path.dirname(DB_PATH)


async def get_db():
    os.makedirs(DB_DIR, exist_ok=True)
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db


async def init_db():
    os.makedirs(DB_DIR, exist_ok=True)
    db = await aiosqlite.connect(DB_PATH)
    await db.executescript("""
        CREATE TABLE IF NOT EXISTS usage_record (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL UNIQUE,
            usage_minutes INTEGER NOT NULL DEFAULT 0,
            break_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS posture_score (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            head_angle REAL NOT NULL,
            shoulder_diff REAL NOT NULL,
            spine_angle REAL NOT NULL,
            score INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS activity_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            activity_type TEXT NOT NULL DEFAULT 'exercise',
            exercise_count INTEGER NOT NULL DEFAULT 0,
            duration_sec INTEGER NOT NULL DEFAULT 0,
            avg_score INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        INSERT OR IGNORE INTO settings (key, value) VALUES ('reminder_interval', '30');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('ai_enabled', 'false');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('auto_start', 'false');
        INSERT OR IGNORE INTO settings (key, value) VALUES ('voice_enabled', 'true');
    """)
    await db.commit()
    await db.close()
    logger.info("Database initialized at %s", DB_PATH)
