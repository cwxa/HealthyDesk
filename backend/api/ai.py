import logging
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.ai_advisor import get_ai_suggestion, analyze_posture, test_connection
from services.ai_config import get_ai_config_masked, KEY_API_KEY, KEY_BASE_URL, KEY_MODEL, KEY_ENABLED
from services.fallback import get_fallback_suggestions
from db.database import get_db
from config import AVAILABLE_MODELS

logger = logging.getLogger("neckguardian.api.ai")
router = APIRouter(tags=["ai"])


class SuggestionRequest(BaseModel):
    head_angle: float
    shoulder_diff: float
    spine_angle: float
    history_avg: float
    issues: list[str] = Field(default_factory=list)


class AnalyzeRequest(BaseModel):
    head_angle: float | None = None
    shoulder_diff: float | None = None
    spine_angle: float | None = None
    score: int | None = None
    issues: list[str] = Field(default_factory=list)
    today_avg: float | None = None
    weekly_avg: float | None = None
    today_activities: int | None = None
    completion_rate: float | None = None
    daily_minutes: float | None = None


class AIConfigUpdate(BaseModel):
    enabled: bool | None = None
    api_key: str | None = None        # 为空表示不修改
    base_url: str | None = None
    model: str | None = None


async def _upsert_settings(items: dict[str, str]) -> None:
    db = await get_db()
    try:
        for key, value in items.items():
            await db.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=?",
                (key, value, value),
            )
        await db.commit()
    finally:
        await db.close()


@router.get("/ai/config")
async def read_ai_config():
    """读取当前 AI 配置（API Key 掩码返回）。"""
    cfg = await get_ai_config_masked()
    cfg["available_models"] = AVAILABLE_MODELS
    return cfg


@router.put("/ai/config")
async def update_ai_config(req: AIConfigUpdate):
    """更新 AI 配置。api_key 留空表示保持原值不变。"""
    updates: dict[str, str] = {}

    if req.enabled is not None:
        updates[KEY_ENABLED] = "true" if req.enabled else "false"
    # 仅当明确传入非空字符串时才覆盖 Key，避免前端回传掩码把真实 Key 覆盖掉
    if req.api_key is not None and req.api_key.strip():
        updates[KEY_API_KEY] = req.api_key.strip()
    if req.base_url is not None:
        updates[KEY_BASE_URL] = req.base_url.strip()
    if req.model is not None and req.model.strip():
        updates[KEY_MODEL] = req.model.strip()

    if updates:
        await _upsert_settings(updates)
        logger.info("AI config updated: %s", list(updates.keys()))

    return await get_ai_config_masked()


@router.post("/ai/test")
async def test_ai_connection():
    """测试与 DeepSeek 服务的连通性。"""
    return await test_connection()


@router.post("/ai/suggestion")
async def get_suggestion(req: SuggestionRequest):
    """实时轻量建议：命中大模型返回 AI 结果，否则降级到本地建议。"""
    posture_data = {
        "head_angle": req.head_angle,
        "shoulder_diff": req.shoulder_diff,
        "spine_angle": req.spine_angle,
        "history_avg": req.history_avg,
    }
    ai_result = await get_ai_suggestion(posture_data)
    if ai_result:
        return {"source": "ai", "suggestion": ai_result}
    fallback = get_fallback_suggestions(req.issues)
    return {"source": "fallback", "suggestions": fallback}


@router.post("/ai/analyze")
async def analyze(req: AnalyzeRequest):
    """综合肩颈分析（含近期使用数据），供仪表盘 AI 分析面板使用。"""
    cfg = await get_ai_config_masked()
    if not cfg["usable"]:
        return {
            "source": "unavailable",
            "error": "AI 未启用或未配置 API Key，请在设置中配置 DeepSeek。",
        }

    report = await analyze_posture(req.model_dump())
    if report:
        return {"source": "ai", "report": report, "model": cfg["model"]}
    return {
        "source": "error",
        "error": "大模型调用失败，请检查网络或 API Key 后重试。",
    }
