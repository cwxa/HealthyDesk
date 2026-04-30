import asyncio
import logging
import sys
import os
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

sys.path.insert(0, os.path.dirname(__file__))

from config import BACKEND_PORT
from db.database import init_db
from services.scheduler import start_scheduler, stop_scheduler
from api.posture import router as posture_router
from api.stats import router as stats_router
from api.settings import router as settings_router
from api.ai import router as ai_router
from api.activity import router as activity_router
from ws.camera_ws import router as ws_router

logging.basicConfig(
    level=logging.DEBUG,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler()],
)
logger = logging.getLogger("neckguardian")


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("NeckGuardian backend starting...")
    os.makedirs(os.path.join(os.path.dirname(__file__), "data"), exist_ok=True)
    await init_db()
    start_scheduler()
    logger.info(f"Backend ready on port {BACKEND_PORT}")
    yield
    logger.info("NeckGuardian backend shutting down...")
    stop_scheduler()


app = FastAPI(title="NeckGuardian API", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(posture_router, prefix="/api")
app.include_router(stats_router, prefix="/api")
app.include_router(settings_router, prefix="/api")
app.include_router(ai_router, prefix="/api")
app.include_router(activity_router, prefix="/api")
app.include_router(ws_router)


@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "1.0.0"}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=BACKEND_PORT, log_level="info")
