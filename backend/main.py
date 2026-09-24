import asyncio
import logging
import sys
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

sys.path.insert(0, os.path.dirname(__file__))

from config import BACKEND_PORT, APP_VERSION, MAINTENANCE_INTERVAL_MINUTES
from db.database import init_db, get_db
from services.scheduler import start_scheduler, stop_scheduler, set_remind_callback, _init_interval
from services.retention import maintain
from api.posture import router as posture_router
from api.stats import router as stats_router
from api.settings import router as settings_router
from api.ai import router as ai_router
from api.activity import router as activity_router
from api.reminder import router as reminder_router
from ws.camera_ws import router as ws_router, notify_reminder

log_level = logging.DEBUG if os.getenv("NECKGUARDIAN_DEBUG") else logging.INFO
logging.basicConfig(
    level=log_level,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("neckguardian")


async def _run_maintenance() -> dict | None:
    """做一次「先聚合、后清理」。任何异常都不应冒泡影响启动或后台循环。"""
    try:
        db = await get_db()
        try:
            result = await maintain(db)
            if result["days_rolled_up"] or result["samples_deleted"]:
                logger.info("数据维护：%s", result)
            else:
                logger.debug("数据维护：无需变更")
            return result
        finally:
            await db.close()
    except Exception as e:
        logger.error("数据维护失败：%s", e)
        return None


async def _maintenance_loop():
    """周期维护。原始采样只增不删曾让库按 1.9 万条/天膨胀（见 services/retention.py）。"""
    while True:
        await asyncio.sleep(MAINTENANCE_INTERVAL_MINUTES * 60)
        await _run_maintenance()


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("NeckGuardian backend starting...")
    os.makedirs(os.path.join(os.path.dirname(__file__), "data"), exist_ok=True)
    await init_db()
    # 启动即做一次：把上次退出后积累的采样补进归档并清掉超期原始数据。
    await _run_maintenance()
    maintenance_task = asyncio.create_task(_maintenance_loop())
    await _init_interval()
    set_remind_callback(notify_reminder)
    start_scheduler()
    logger.info(f"Backend ready on port {BACKEND_PORT}")
    yield
    logger.info("NeckGuardian backend shutting down...")
    maintenance_task.cancel()
    try:
        await maintenance_task
    except asyncio.CancelledError:
        pass
    stop_scheduler()


app = FastAPI(title="NeckGuardian API", version=APP_VERSION, lifespan=lifespan)

# 仅允许本地前端（Vite 开发服务器）与打包后的 Electron 渲染进程
# （file:// 加载）调用 API，避免通配符来源。
ALLOWED_ORIGINS = [
    "http://127.0.0.1:5173",  # Vite 开发服务器
    "http://localhost:5173",
    "file://",                # Electron 打包后渲染进程
    "null",                   # 部分引擎中 file:// 页面发送的 Origin
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=["*"],
)

app.include_router(posture_router, prefix="/api")
app.include_router(stats_router, prefix="/api")
app.include_router(settings_router, prefix="/api")
app.include_router(ai_router, prefix="/api")
app.include_router(activity_router, prefix="/api")
app.include_router(reminder_router, prefix="/api")
app.include_router(ws_router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": APP_VERSION}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=BACKEND_PORT, log_level="info")
