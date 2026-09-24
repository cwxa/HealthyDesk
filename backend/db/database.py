import aiosqlite
import logging
import os
from config import DB_PATH
from db.migrations import apply_migrations, current_version, LATEST_VERSION

logger = logging.getLogger("neckguardian.db")

DB_DIR = os.path.dirname(DB_PATH)


async def get_db():
    os.makedirs(DB_DIR, exist_ok=True)
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    return db


async def init_db():
    """建库 / 升级到最新 schema。

    结构定义与版本演进全部在 `db/migrations.py`，这里只负责调用 ——
    ⚠️ 不要把建表 SQL 挪回本文件：此前正是因为它写成一串
    `CREATE TABLE IF NOT EXISTS`，导致加字段静默失败（表已存在就整条跳过）。
    """
    os.makedirs(DB_DIR, exist_ok=True)
    db = await aiosqlite.connect(DB_PATH)
    db.row_factory = aiosqlite.Row
    try:
        version = await apply_migrations(db)
        logger.info("Database initialized at %s (schema v%d)", DB_PATH, version)
    finally:
        await db.close()


__all__ = ["get_db", "init_db", "current_version", "LATEST_VERSION", "DB_DIR"]
