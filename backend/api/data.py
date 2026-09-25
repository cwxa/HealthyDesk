"""数据管理 API（ROADMAP 需求 4）：存储用量、导出、导入、一键清除。

## 为什么这些接口存在

移动端的数据是"卸载即清除"，桌面端的数据在安装目录 —— 用户此前**没有任何出路**。
加上原始采样只增不删，用户唯一能做的就是等着库变大。这组接口把三件事补齐：
看得见（用量）、拿得走（导出）、清得掉（清除）。

## 三个语义决定

1. **导入 = 覆盖**（数据表先清空再写入）。合并去重需要定义"同一个采样"的同一性，
   而时间戳重复在真实数据里并不罕见（重放、时钟回拨），猜错就是静默改数据。
   覆盖是可预期而且可验证的（round-trip 逐字段相等）。设置表例外，见下。
2. **设置表用 upsert，不清空**。恢复备份不该把本机已有的 DeepSeek API Key 抹掉；
   而清空一次再写回来，等于把"备份文件里没有的设置项"删了。
3. **校验失败也返回 HTTP 200**，把具体**错误码**放在响应体里。HTTP 层不是这个语义的
   载体（它不是"资源不存在/无权限"），而界面需要拿到确切的码才能给出有用的提示
   （"文件版本不支持"和"这不是 NeckGuardian 的备份文件"是两种完全不同的处置）。
"""

import logging
from typing import Any

from fastapi import APIRouter, Body, HTTPException
from db.database import get_db
from services.export_format import (
    TABLE_FIELDS,
    TABLE_ORDER,
    build_daily_csv,
    build_export,
    validate_export,
)
from services.retention import maintain, retention_summary_sync
from config import APP_VERSION
from db.migrations import LATEST_VERSION

logger = logging.getLogger("neckguardian.api.data")
router = APIRouter(tags=["data"])

# 导入/清除**不碰** settings：它是配置不是数据（且含 API Key 等凭据）。
# 「一键清除」的界面文案必须与此一致，不能让用户以为连设置也清了。
DATA_TABLES = ("posture_score", "posture_daily", "usage_record", "activity_log")


@router.get("/data/status")
async def data_status():
    """存储用量与保留状态（同步读，不修改数据）。"""
    try:
        return retention_summary_sync()
    except Exception as e:
        logger.error("读取存储状态失败：%s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/data/export")
async def export_data():
    """导出全部数据。返回 `{"bundle": <写入文件的内容>, "skipped": {...}}`。

    界面把 `bundle` 序列化后写成文件；`skipped` 只是展示用的诊断信息。
    """
    db = await get_db()
    try:
        tables = {}
        for table in TABLE_ORDER:
            cursor = await db.execute(f"SELECT * FROM {table}")
            tables[table] = [dict(r) for r in await cursor.fetchall()]
        return build_export(
            tables,
            app_version=APP_VERSION,
            schema_version=LATEST_VERSION,
            exported_at=_now_iso(),
        )
    finally:
        await db.close()


@router.get("/data/export.csv")
async def export_daily_csv():
    """每日汇总 CSV（给人看的那一份）。"""
    db = await get_db()
    try:
        cursor = await db.execute(
            "SELECT date, sample_count, score_sum, min_score,"
            " head_bad_count, shoulder_bad_count, spine_bad_count FROM posture_daily ORDER BY date"
        )
        return {"csv": build_daily_csv([dict(r) for r in await cursor.fetchall()])}
    finally:
        await db.close()


@router.post("/data/maintain")
async def maintain_now():
    """立即执行一次维护（日聚合 → 保留期清理），返回本次处理量。

    存在理由：后台维护 30 分钟一轮，用户改完「保留天数」要等下一轮才看得到变化，
    自然会认为设置没生效。界面在改完设置后直接调它，立刻刷新用量。
    顺序由 `services.retention.maintain` 固定（先聚合后清理），这里不再重复。
    """
    db = await get_db()
    try:
        result = await maintain(db)
        logger.info("手动维护完成：%s", result)
        return {"ok": True, **result}
    finally:
        await db.close()


@router.post("/data/import")
async def import_data(payload: Any = Body(...)):
    """导入一个导出包。**覆盖**数据表（设置表 upsert）。

    🔴 形参类型必须是 `Any`，**不能**写 `dict`。写成 `dict` 时 FastAPI 会在进路由前
    就抛 422，`validate_export` 的 `not_an_object` 分支**永远走不到** —— 而移动端会正常
    返回该错误码，两端行为就分叉了（本项目的对拍脚本抓不到，因为它是 HTTP 层的差异）。
    校验失败一律 HTTP 200 + 错误码，见模块顶部第 3 条。
    """
    result = validate_export(payload)
    if not result["ok"]:
        logger.warning("导入被拒：%s", result["error"])
        return {"ok": False, "error": result["error"], "imported": {}, "skipped": {}}

    bundle = result["bundle"]
    imported: dict = {}
    db = await get_db()
    try:
        for table in DATA_TABLES:
            await db.execute(f"DELETE FROM {table}")
            rows = bundle["tables"][table]
            await _insert_rows(db, table, rows)
            imported[table] = len(rows)

        # 设置项用 upsert：文件的删不掉本机已有的（尤其是没被导出的密钥）
        setting_rows = bundle["tables"]["settings"]
        for row in setting_rows:
            await db.execute(
                "INSERT INTO settings (key, value) VALUES (?, ?)"
                " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (row["key"], row["value"]),
            )
        imported["settings"] = len(setting_rows)

        await db.commit()
        logger.info("导入完成：%s（跳过 %s）", imported, result["skipped"])
        return {"ok": True, "error": None, "imported": imported, "skipped": result["skipped"]}
    except Exception as e:
        await db.rollback()
        logger.error("导入失败：%s", e)
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await db.close()


@router.post("/data/clear")
async def clear_data():
    """清除全部**健康数据**（原始采样 / 归档 / 使用记录 / 活动记录）。

    保留设置表 —— 包含 API Key 等凭据，用户点"清除数据"不该顺带丢掉它们。
    界面文案与此一致（见 services/export_format.py 的 SECRET_SETTING_KEYS）。
    """
    db = await get_db()
    try:
        cleared: dict = {}
        for table in DATA_TABLES:
            cursor = await db.execute(f"SELECT COUNT(*) AS n FROM {table}")
            cleared[table] = (await cursor.fetchone())["n"]
            await db.execute(f"DELETE FROM {table}")
        await db.commit()
        logger.info("已清除全部健康数据：%s", cleared)
        return {"ok": True, "cleared": cleared}
    finally:
        await db.close()


async def _insert_rows(db, table: str, rows: list) -> None:
    if not rows:
        return
    columns = [name for name, _ in TABLE_FIELDS[table]]
    placeholders = ", ".join("?" for _ in columns)
    sql = f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})"
    await db.executemany(sql, [[row[c] for c in columns] for row in rows])


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
