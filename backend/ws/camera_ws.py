import asyncio
import base64
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
import cv2
import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services.pose_detector import pose_detector
from services.scheduler import record_break
# 平滑器单独成模块（要参与双端等价性验证，见 backend/services/smoother.py 顶部说明）
from services.pose_session import PoseSession
# 🔴 帧的时间戳必须是 UTC 契约格式，**不能**用 `datetime.now().isoformat()`：
# 那会写成本地时间且不带时区标记，而前端会把它原样写进 posture_score，
# 按天查询都走 SQLite 的 `date(timestamp,'localtime')`（假定输入是 UTC）
# → 偏移被再减一次，本地 16:00 后的采样全部落到"次日"。详见 services/timefmt.py。

logger = logging.getLogger("neckguardian.ws")
router = APIRouter()

active_connections: list[WebSocket] = []
# 单摄像头所有权与单工作线程，避免跨会话交错跟踪及阻塞 HTTP 事件循环。
pose_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="pose-worker")


@router.websocket("/ws/camera")
async def camera_websocket(ws: WebSocket):
    await ws.accept()
    if active_connections:
        logger.warning("Camera session rejected: another session owns the detector")
        await ws.send_json({"type": "error", "message": "摄像头识别已被另一个会话占用"})
        await ws.close()
        return
    active_connections.append(ws)
    loop = asyncio.get_running_loop()
    session = PoseSession()
    logger.info("Camera session started")
    try:
        # 所有模型操作按同一工作线程顺序执行，包括断开后的释放。
        ok = await loop.run_in_executor(pose_worker, pose_detector.initialize)
        if not ok:
            await ws.send_json({"type": "error", "message": "人体姿态模型初始化失败，无法进行姿势检测"})
            await ws.close()
            return
        await ws.send_json({"type": "ready", "message": "MediaPipe ready"})
        while True:
            data = await ws.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                logger.warning("Invalid camera message: malformed JSON")
                continue
            if not isinstance(msg, dict):
                continue
            if msg.get("type") == "frame":
                started_at = time.perf_counter()
                pose, decode_ms, infer_ms = await loop.run_in_executor(pose_worker, _process_frame, msg)
                # 评分模式由前端随帧带上：桌面端必须知道静息/运动上下文。
                # 切换模式先重置 EMA 再更新，首帧不会继承旧模式。
                response = session.process(pose, msg.get("mode"), time.monotonic() * 1000)
                response.update({k: msg[k] for k in ("session_id", "frame_id", "captured_at") if k in msg})
                await ws.send_json(response)
                logger.debug("Camera frame processed: session_id=%s frame_id=%s mode=%s type=%s decode_ms=%.2f infer_ms=%.2f total_ms=%.2f",
                             msg.get("session_id"), msg.get("frame_id"), response["mode"], response["type"],
                             decode_ms, infer_ms, (time.perf_counter() - started_at) * 1000)
            elif msg.get("type") == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        logger.info("Camera WebSocket client disconnected")
    except Exception:
        logger.exception("Camera WebSocket session failed")
    finally:
        await loop.run_in_executor(pose_worker, pose_detector.release)
        if ws in active_connections:
            active_connections.remove(ws)
        logger.info("Camera session stopped")


def _process_frame(msg):
    started_at = time.perf_counter()
    frame = _decode_frame(msg)
    decoded_at = time.perf_counter()
    pose = pose_detector.process_frame(frame) if frame is not None else {"error": "decode_error"}
    return pose, (decoded_at - started_at) * 1000, (time.perf_counter() - decoded_at) * 1000


def _decode_frame(msg: dict):
    try:
        base64_str = msg.get("data", "")
        if base64_str.startswith("data:image"):
            base64_str = base64_str.split(",", 1)[1]
        # 限制消息体积；每个合法帧均返回结果，使前端在途帧可以释放。
        if not isinstance(base64_str, str) or len(base64_str) > 4_000_000:
            logger.warning("Camera frame rejected: invalid payload size or type")
            return None
        img_bytes = base64.b64decode(base64_str, validate=True)
        np_arr = np.frombuffer(img_bytes, dtype=np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if frame is None:
            return None
        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        # 保留输入宽高比，禁止将竖屏或 16:9 画面拉伸成 4:3。
        h, w = frame.shape[:2]
        scale = min(1.0, 640 / max(w, h))
        if scale < 1:
            frame = cv2.resize(frame, (max(1, round(w * scale)), max(1, round(h * scale))))
        return frame
    except Exception as e:
        logger.warning("Frame decode failed: error=%s", e)
        return None


async def notify_reminder():
    """提醒事件回调。

    提醒弹窗/系统通知统一走 Electron 主进程轮询 /api/reminder/status，
    WebSocket 仅负责姿态数据（前端不再消费 'reminder' 消息）。
    此处只记录一次休息计数，避免「用广播的壳做计数的活」的误导性代码。
    """
    await record_break()
