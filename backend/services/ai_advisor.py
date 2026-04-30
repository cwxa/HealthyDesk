import logging
import httpx
from config import DEEPSEEK_API_KEY, DEEPSEEK_BASE_URL, AI_ENABLED

logger = logging.getLogger("neckguardian.ai")


async def get_ai_suggestion(posture_data: dict) -> str:
    if not AI_ENABLED:
        logger.info("AI disabled, using fallback suggestions")
        return ""

    prompt = _build_prompt(posture_data)
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{DEEPSEEK_BASE_URL}/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": "deepseek-chat",
                    "messages": [
                        {"role": "system", "content": "你是一个专业的肩颈健康顾问，根据用户的姿态数据提供个性化建议。请用中文回答，控制在100字以内。"},
                        {"role": "user", "content": prompt},
                    ],
                    "max_tokens": 300,
                    "temperature": 0.7,
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                suggestion = data["choices"][0]["message"]["content"].strip()
                logger.info("AI suggestion generated successfully")
                return suggestion
            else:
                logger.warning("AI API returned status %d", resp.status_code)
                return ""
    except Exception as e:
        logger.warning("AI API call failed: %s", e)
        return ""


def _build_prompt(data: dict) -> str:
    return (
        f"用户的姿态检测数据如下：\n"
        f"- 头部前倾角度: {data['head_angle']}°（正常应小于20°）\n"
        f"- 肩部高度差: {data['shoulder_diff']}像素\n"
        f"- 脊柱倾斜角度: {data['spine_angle']}°\n"
        f"- 历史平均评分: {data.get('history_avg', 0)}分\n\n"
        f"请根据以上数据，给出关于桌椅高度调整、显示器位置、放松动作的具体建议。"
    )
