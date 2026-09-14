"""DeepSeek 大模型配置解析。

优先级：数据库设置（用户在应用内配置） > 环境变量（部署时注入的默认值）。

设计要点：
- 用户在设置页填写的 API Key 等会写入 settings 表，应用重启后依然生效。
- 未在应用内配置时，回退到环境变量，便于部署场景免配置。
- API Key 属于敏感信息：接口返回时做掩码处理，绝不回传明文。
"""
import logging
from dataclasses import dataclass

from db.database import get_db
from config import (
    DEEPSEEK_API_KEY,
    DEEPSEEK_BASE_URL,
    DEEPSEEK_MODEL,
)

logger = logging.getLogger("neckguardian.ai.config")

# settings 表中与 AI 相关的键
KEY_API_KEY = "deepseek_api_key"
KEY_BASE_URL = "deepseek_base_url"
KEY_MODEL = "deepseek_model"
KEY_ENABLED = "ai_enabled"


@dataclass
class AIConfig:
    api_key: str
    base_url: str
    model: str
    enabled: bool

    @property
    def usable(self) -> bool:
        """是否具备调用大模型的条件（已启用且已配置 Key）。"""
        return self.enabled and bool(self.api_key)


def _mask(key: str) -> str:
    """掩码 API Key，仅保留首尾少量字符用于辨识。"""
    if not key:
        return ""
    if len(key) <= 8:
        return "*" * len(key)
    return f"{key[:4]}{'*' * 6}{key[-4:]}"


async def _read_settings() -> dict:
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT key, value FROM settings WHERE key IN (?, ?, ?, ?)",
            (KEY_API_KEY, KEY_BASE_URL, KEY_MODEL, KEY_ENABLED),
        )
        rows = await cursor.fetchall()
        return {r["key"]: r["value"] for r in rows}
    finally:
        await db.close()


async def get_ai_config() -> AIConfig:
    """解析当前生效的 AI 配置（DB 覆盖 env）。"""
    settings = await _read_settings()

    api_key = (settings.get(KEY_API_KEY) or "").strip() or DEEPSEEK_API_KEY
    base_url = (settings.get(KEY_BASE_URL) or "").strip() or DEEPSEEK_BASE_URL
    model = (settings.get(KEY_MODEL) or "").strip() or DEEPSEEK_MODEL

    enabled_raw = settings.get(KEY_ENABLED)
    # 未显式设置 ai_enabled 时，若存在 Key 则默认启用
    if enabled_raw is None:
        enabled = bool(api_key)
    else:
        enabled = enabled_raw == "true"

    return AIConfig(api_key=api_key, base_url=base_url.rstrip("/"), model=model, enabled=enabled)


async def get_ai_config_masked() -> dict:
    """返回可安全下发给前端的配置（Key 掩码）。"""
    cfg = await get_ai_config()
    return {
        "enabled": cfg.enabled,
        "has_api_key": bool(cfg.api_key),
        "api_key_masked": _mask(cfg.api_key),
        "base_url": cfg.base_url,
        "model": cfg.model,
        "usable": cfg.usable,
    }
