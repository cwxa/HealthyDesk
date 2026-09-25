import asyncio
import base64
import json
import logging
import cv2
import numpy as np
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from services.pose_detector import pose_detector
from services.scorer import MODE_EXERCISE, MODE_MONITOR, compute_score
from services.scheduler import record_break
# 平滑器单独成模块（要参与双端等价性验证，见 backend/services/smoother.py 顶部说明）
from services.smoother import PoseSmoother
# 🔴 帧的时间戳必须是 UTC 契约格式，**不能**用 `datetime.now().isoformat()`：
# 那会写成本地时间且不带时区标记，而前端会把它原样写进 posture_score，
# 按天查询都走 SQLite 的 `date(timestamp,'localtime')`（假定输入是 UTC）
# → 偏移被再减一次，本地 16:00 后的采样全部落到"次日"。详见 services/timefmt.py。
from services.timefmt import now_iso_ms

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
    last_mode = MODE_MONITOR

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
                    # 评分模式由前端随帧带上：桌面端的评分在**这里**算，
                    # 后端必须知道用户此刻是在「静息坐姿」还是「正在做康复动作」。
                    # 不分模式时，用户把颈部侧屈做到 20° 会被判「头部严重侧倾」——
                    # 康复动作本就要求偏离中立位，静息判定用在运动中是反的。
                    # 只认 'exercise'，其余（含旧版前端不带该字段）一律回落静息态，
                    # 与分通道前的行为完全一致。
                    mode = msg.get("mode")
                    if mode != MODE_EXERCISE:
                        mode = MODE_MONITOR

                    if mode != last_mode:
                        # 切换模式时清空平滑状态：EMA 是跨帧的，不清空就会拿
                        # 「运动中」的平滑值去评「静息态」（或反过来），
                        # 表现为切换后约 1 秒内的虚假报警。
                        smoother.reset()
                        last_mode = mode

                    scored = compute_score(
                        smoothed["head_angle"],
                        smoothed["shoulder_diff"],
                        smoothed["spine_angle"],
                        mode=mode,
                    )
                    response = {
                        "type": "pose",
                        "timestamp": now_iso_ms(),
                        **scored,
                        "visibility": pose_result.get("visibility", 1.0),
                        "landmarks": pose_result["landmarks"],
                    }
                else:
                    # Pose lost — reset smoother so stale values don't persist
                    smoother.reset()
                    response = {"type": "no_pose", "timestamp": now_iso_ms(), "message": "No pose detected"}

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
