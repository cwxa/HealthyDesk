"""会话评分状态：先切模式再平滑，缺失指标不参与完整评分。"""
import logging
from services.scorer import MODE_MONITOR, MODE_EXERCISE, compute_score
from services.smoother import PoseSmoother
from services.pose_geometry import METRIC_VERSION
from services.timefmt import now_iso_ms

logger = logging.getLogger("neckguardian.pose.session")


class PoseSession:
    def __init__(self):
        self.smoother = PoseSmoother()
        self.mode = None

    def process(self, pose, mode=MODE_MONITOR, timestamp_ms=None):
        mode = MODE_EXERCISE if mode == MODE_EXERCISE else MODE_MONITOR
        if mode != self.mode:
            logger.info("Pose mode changed: previous=%s current=%s", self.mode, mode)
            self.smoother.reset()
            self.mode = mode
        base = {"timestamp": now_iso_ms(), "mode": mode, "metric_version": METRIC_VERSION}
        if not pose:
            self.smoother.reset()
            return {**base, "type": "no_pose", "reason": "no_person", "message": "No pose detected"}
        if pose.get("error"):
            self.smoother.reset()
            return {**base, "type": "no_pose", "reason": pose["error"], "message": "Frame processing failed"}
        metrics = {k: pose[k] for k in ("head_angle", "shoulder_diff", "spine_angle") if k in pose}
        smoothed = self.smoother.update(metrics, timestamp_ms)
        complete = len(smoothed) == 3
        scored = compute_score(**smoothed, mode=mode) if complete else smoothed
        kind = "pose" if complete else "partial_pose" if metrics else "no_pose"
        if not metrics:
            self.smoother.reset()
        return {**base, **scored, "type": kind, **({"reason": "invalid_measurement"} if not metrics else {}), **{k: pose[k] for k in (
            "visibility", "quality", "landmarks", "frame_width", "frame_height", "signed_metrics",
        ) if k in pose}}
