import logging
from fastapi import APIRouter
from pydantic import BaseModel
from services.ai_advisor import get_ai_suggestion
from services.fallback import get_fallback_suggestions

logger = logging.getLogger("neckguardian.api.ai")
router = APIRouter(tags=["ai"])


class SuggestionRequest(BaseModel):
    head_angle: float
    shoulder_diff: float
    spine_angle: float
    history_avg: float
    issues: list[str] = []


@router.post("/ai/suggestion")
async def get_suggestion(req: SuggestionRequest):
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
