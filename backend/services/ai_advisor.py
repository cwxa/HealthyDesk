import logging
import httpx

from config import (
    HEAD_TILT_THRESHOLD,
    SHOULDER_DIFF_THRESHOLD,
    SPINE_ANGLE_THRESHOLD,
)
from services.ai_config import AIConfig, get_ai_config

logger = logging.getLogger("neckguardian.ai")

SYSTEM_PROMPT = (
    "你是一位专业的职业健康与肩颈康复顾问，擅长根据人体姿态检测数据分析久坐人群的"
    "肩颈问题。请用简体中文回答，语言专业但亲切易懂，给出可立即执行的具体建议。"
)


async def _chat(cfg: AIConfig, system: str, user: str, max_tokens: int = 600,
                temperature: float = 0.7, timeout: float = 20.0) -> str:
    """统一的 DeepSeek Chat Completions 调用。失败返回空字符串。"""
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(
                f"{cfg.base_url}/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {cfg.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": cfg.model,
                    "messages": [
                        {"role": "system", "content": system},
                        {"role": "user", "content": user},
                    ],
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                },
            )
            if resp.status_code == 200:
                data = resp.json()
                return data["choices"][0]["message"]["content"].strip()
            logger.warning("DeepSeek API status %d: %s", resp.status_code, resp.text[:200])
            return ""
    except Exception as e:
        logger.warning("DeepSeek API call failed: %s", e)
        return ""


async def test_connection() -> dict:
    """测试连通性：发一条极短的请求，验证 Key/BaseURL/模型是否可用。"""
    cfg = await get_ai_config()
    if not cfg.api_key:
        return {"ok": False, "error": "未配置 API Key"}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{cfg.base_url}/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {cfg.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": cfg.model,
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 5,
                },
            )
            if resp.status_code == 200:
                return {"ok": True, "model": cfg.model}
            if resp.status_code == 401:
                return {"ok": False, "error": "API Key 无效或已过期（401）"}
            if resp.status_code == 402:
                return {"ok": False, "error": "账户余额不足（402）"}
            if resp.status_code == 404:
                return {"ok": False, "error": f"模型不存在：{cfg.model}（404）"}
            return {"ok": False, "error": f"请求失败（{resp.status_code}）：{resp.text[:120]}"}
    except httpx.ConnectError:
        return {"ok": False, "error": "无法连接到 DeepSeek 服务，请检查网络或 Base URL"}
    except httpx.TimeoutException:
        return {"ok": False, "error": "请求超时，请检查网络"}
    except Exception as e:
        return {"ok": False, "error": f"调用异常：{e}"}


async def analyze_posture(data: dict) -> str:
    """基于完整姿态与使用数据，生成一次综合的肩颈健康分析。"""
    cfg = await get_ai_config()
    if not cfg.usable:
        return ""

    prompt = _build_analysis_prompt(data)
    text = await _chat(cfg, SYSTEM_PROMPT, prompt, max_tokens=800, temperature=0.6)
    if text:
        logger.info("AI posture analysis generated (%d chars)", len(text))
    return text


async def get_ai_suggestion(posture_data: dict) -> str:
    """实时单条建议（用于活动页面的轻量提示），保留原有兼容行为。"""
    cfg = await get_ai_config()
    if not cfg.usable:
        return ""

    prompt = _build_prompt(posture_data)
    return await _chat(cfg, SYSTEM_PROMPT, prompt, max_tokens=300, temperature=0.7)


def _fmt(v, unit: str = "") -> str:
    """安全格式化数值。"""
    try:
        return f"{float(v):.1f}{unit}"
    except (TypeError, ValueError):
        return "未知"


def _build_prompt(data: dict) -> str:
    return (
        f"用户的实时姿态检测数据如下：\n"
        f"- 头部侧倾角度: {_fmt(data.get('head_angle'), '°')}（正常应小于{HEAD_TILT_THRESHOLD:g}°）\n"
        f"- 肩部高度差: {_fmt(data.get('shoulder_diff'), '%')}（正常应小于{SHOULDER_DIFF_THRESHOLD:g}%）\n"
        f"- 脊柱倾斜角度: {_fmt(data.get('spine_angle'), '°')}（正常应小于{SPINE_ANGLE_THRESHOLD:g}°）\n"
        f"- 历史平均评分: {data.get('history_avg', 0)}分（满分100）\n\n"
        f"请用 100 字以内给出当前最值得优先改善的一条建议。"
    )


def _build_analysis_prompt(data: dict) -> str:
    issues = data.get("issues") or []
    issues_text = "、".join(issues) if issues else "本次未检测到明显问题"

    return (
        "请基于以下一位久坐办公用户的肩颈健康数据，生成一份结构化的分析报告：\n\n"
        "【实时姿态指标】\n"
        f"- 头部侧倾角: {_fmt(data.get('head_angle'), '°')}（阈值 {HEAD_TILT_THRESHOLD:g}°）\n"
        f"- 肩部高度差: {_fmt(data.get('shoulder_diff'), '%')}（阈值 {SHOULDER_DIFF_THRESHOLD:g}%）\n"
        f"- 脊柱倾斜角: {_fmt(data.get('spine_angle'), '°')}（阈值 {SPINE_ANGLE_THRESHOLD:g}°）\n"
        f"- 当前姿态评分: {data.get('score', '未知')} 分\n"
        f"- 本次检测到的问题: {issues_text}\n\n"
        "【近期使用与习惯】\n"
        f"- 今日平均评分: {data.get('today_avg', '未知')} 分\n"
        f"- 本周平均评分: {data.get('weekly_avg', '未知')} 分\n"
        f"- 今日活动次数: {data.get('today_activities', '未知')} 次\n"
        f"- 本周活动完成率: {data.get('completion_rate', '未知')} %\n"
        f"- 日均使用时长: {data.get('daily_minutes', '未知')} 分钟\n\n"
        "请按以下结构输出（使用 Markdown，不要使用一级标题）：\n"
        "## 整体评估\n用 2-3 句概括当前肩颈健康状况与主要风险。\n"
        "## 问题分析\n结合数据指出 2-3 个最突出的问题及其可能的成因。\n"
        "## 改善建议\n给出 3-4 条具体、可当天执行的动作或习惯调整（工作姿势、拉伸、作息等）。\n"
        "## 今日行动\n用一句话给出今天最该做的一件小事。\n"
    )
