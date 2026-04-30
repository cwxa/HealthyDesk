import asyncio
import base64
import json
import logging
from datetime import datetime
from typing import Optional
import cv2
import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services.pose_detector import pose_detector
from services.scorer import compute_score

logger = logging.getLogger("neckguardian.ws")
router = APIRouter()

active_connections: list[WebSocket] = []

EMA_ALPHA = 0.35  # smoothing factor: higher = faster response, lower = more stable


class PoseSmoother:
    """Exponential moving average for pose metrics — reduces frame-to-frame jitter."""

    def __init__(self, alpha: float = EMA_ALPHA):
        self.alpha = alpha
        self._values: Optional[dict] = None

    def update(self, metrics: dict) -> dict:
        if self._values is None:
            self._values = {k: v for k, v in metrics.items() if isinstance(v, (int, float))}
            return dict(self._values)

        smoothed = {}
        for k, v in metrics.items():
            if isinstance(v, (int, float)) and k in self._values:
                smoothed[k] = round(self.alpha * v + (1 - self.alpha) * self._values[k], 2)
                self._values[k] = smoothed[k]
            else:
                smoothed[k] = v
        return smoothed

    def reset(self):
        self._values = None


@router.websocket("/ws/camera")
async def camera_websocket(ws: WebSocket):
    await ws.accept()
    active_connections.append(ws)
    logger.info("Camera WebSocket client connected")

    if not pose_detector.initialized:
        ok = pose_detector.initialize()
        if not ok:
            await ws.send_json({"type": "error", "message": "MediaPipe initialization failed"})
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
    disconnected = []
    for ws in active_connections:
        try:
            await ws.send_json({"type": "reminder", "message": "该活动一下了！"})
        except Exception:
            disconnected.append(ws)
    for ws in disconnected:
        if ws in active_connections:
            active_connections.remove(ws)
