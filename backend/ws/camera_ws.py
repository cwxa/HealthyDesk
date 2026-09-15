import asyncio
import base64
import json
import logging
from datetime import datetime
import cv2
import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services.pose_detector import pose_detector
from services.scorer import compute_score
from services.scheduler import record_break
# 平滑器单独成模块（要参与双端等价性验证，见 backend/services/smoother.py 顶部说明）
from services.smoother import PoseSmoother

logger = logging.getLogger("neckguardian.ws")
router = APIRouter()

active_connections: list[WebSocket] = []


@router.websocket("/ws/camera")
async def camera_websocket(ws: WebSocket):
    await ws.accept()
    active_connections.append(ws)
    logger.info("Camera WebSocket client connected")

    if not pose_detector.initialized:
        ok = pose_detector.initialize()
        if not ok:
            logger.error("MediaPipe initialization failed — closing WebSocket")
            await ws.send_json({
                "type": "error",
                "message": "人体姿态模型初始化失败，无法进行姿势检测",
            })
            await ws.close()
            if ws in active_connections:
                active_connections.remove(ws)
            return
        else:
            await ws.send_json({"type": "ready", "message": "MediaPipe ready"})

    smoother = PoseSmoother()

    try:
        while True:
            data = await ws.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue

            if msg.get("type") == "frame":
                frame_data = _decode_frame(msg)
                if frame_data is None:
                    continue

                pose_result = pose_detector.process_frame(frame_data)
                if pose_result:
                    smoothed = smoother.update({
                        "head_angle": pose_result["head_angle"],
                        "shoulder_diff": pose_result["shoulder_diff"],
                        "spine_angle": pose_result["spine_angle"],
                    })
                    scored = compute_score(
                        smoothed["head_angle"],
                        smoothed["shoulder_diff"],
                        smoothed["spine_angle"],
                    )
                    response = {
                        "type": "pose",
                        "timestamp": datetime.now().isoformat(),
                        **scored,
                        "visibility": pose_result.get("visibility", 1.0),
                        "landmarks": pose_result["landmarks"],
                    }
                else:
                    # Pose lost — reset smoother so stale values don't persist
                    smoother.reset()
                    response = {"type": "no_pose", "timestamp": datetime.now().isoformat(), "message": "No pose detected"}

                await ws.send_json(response)

            elif msg.get("type") == "ping":
                await ws.send_json({"type": "pong"})

    except WebSocketDisconnect:
        logger.info("Camera WebSocket client disconnected")
    except Exception as e:
        logger.error("WebSocket error: %s", e)
    finally:
        if ws in active_connections:
            active_connections.remove(ws)


def _decode_frame(msg: dict):
    try:
        base64_str = msg.get("data", "")
        if base64_str.startswith("data:image"):
            base64_str = base64_str.split(",", 1)[1]
        img_bytes = base64.b64decode(base64_str)
        np_arr = np.frombuffer(img_bytes, dtype=np.uint8)
        frame = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
        if frame is None:
            return None
        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        frame = cv2.resize(frame, (640, 480))
        return frame
    except Exception as e:
        logger.error("Frame decode error: %s", e)
        return None


async def notify_reminder():
    """提醒事件回调。

    提醒弹窗/系统通知统一走 Electron 主进程轮询 /api/reminder/status，
    WebSocket 仅负责姿态数据（前端不再消费 'reminder' 消息）。
    此处只记录一次休息计数，避免「用广播的壳做计数的活」的误导性代码。
    """
    await record_break()
