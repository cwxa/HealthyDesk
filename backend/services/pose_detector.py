import time
from services.pose_geometry import measure_pose, METRIC_VERSION, head_tilt_angle, shoulder_ratio, spine_angle
import logging
from typing import Optional
import numpy as np

logger = logging.getLogger("neckguardian.pose")

LEFT_EAR = 7
RIGHT_EAR = 8
LEFT_SHOULDER = 11
RIGHT_SHOULDER = 12
LEFT_HIP = 23
RIGHT_HIP = 24
NOSE = 0

MIN_VISIBILITY = 0.5
# Only upper-body landmarks — hips often near frame edge with low visibility
CHECK_LANDMARKS = [NOSE, LEFT_EAR, RIGHT_EAR, LEFT_SHOULDER, RIGHT_SHOULDER]


class PoseDetector:
    def __init__(self):
        self.mp_pose = None
        self.mp_drawing = None
        self.pose = None
        self._initialized = False

    def initialize(self) -> bool:
        try:
            import mediapipe as mp
            self.mp_pose = mp.solutions.pose
            self.mp_drawing = mp.solutions.drawing_utils
            self.pose = self.mp_pose.Pose(
                static_image_mode=False,
                model_complexity=1,
                smooth_landmarks=True,
                min_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            self._initialized = True
            logger.info("MediaPipe Pose initialized successfully")
            return True
        except Exception as e:
            logger.error("Failed to initialize MediaPipe: %s", e)
            self._initialized = False
            return False

    @property
    def initialized(self) -> bool:
        return self._initialized

    def process_frame(self, image: np.ndarray) -> Optional[dict]:
        if not self._initialized:
            return None
        started_at = time.perf_counter()
        try:
            results = self.pose.process(image)
            if not results.pose_landmarks:
                return None

            landmarks = results.pose_landmarks.landmark
            h, w = image.shape[:2]

            # 原检查仅覆盖上半身；现在每个指标单独检查其依赖关键点。
            measured = measure_pose(landmarks, w, h)
            valid = [q["confidence"] for q in measured["quality"].values() if q["valid"]]
            logger.debug("Pose measured: dimensions=%dx%d complete=%s quality=%s elapsed_ms=%.2f",
                         w, h, measured["complete"], measured["quality"], (time.perf_counter() - started_at) * 1000)
            return {
                **measured["metrics"],
                "quality": measured["quality"],
                "complete": measured["complete"],
                "metric_version": METRIC_VERSION,
                "frame_width": w,
                "frame_height": h,
                "visibility": round(min(valid, default=0) * 1000) / 1000,
                "landmarks": {
                    "nose": _point(landmarks[NOSE], w, h),
                    "left_ear": _point(landmarks[LEFT_EAR], w, h),
                    "right_ear": _point(landmarks[RIGHT_EAR], w, h),
                    "left_shoulder": _point(landmarks[LEFT_SHOULDER], w, h),
                    "right_shoulder": _point(landmarks[RIGHT_SHOULDER], w, h),
                },
            }
        except Exception as e:
            logger.exception("Pose processing failed: elapsed_ms=%.2f error=%s", (time.perf_counter() - started_at) * 1000, e)
            return {"error": "inference_error"}

    def release(self):
        if self.pose:
            self.pose.close()
            self._initialized = False
            self.pose = None
            logger.info("Pose detector released")


def _point(landmark, w, h):
    return {"x": round(landmark.x * w, 1), "y": round(landmark.y * h, 1)}


def _compute_head_tilt_angle(left_ear, right_ear) -> float:
    """Head lateral tilt: angle of the ear-to-ear line relative to horizontal.
    Pure 2D metric — no Z-depth involved. Reliable from a front-facing camera.
    Note: in the raw (unmirrored) frame, the person's left ear is on the RIGHT
    side of the image (larger x), so right_ear.x < left_ear.x in image coords."""
    # v2：异常几何返回 None，超过 30° 不再清零；用像素比例计算。
    return head_tilt_angle(left_ear, right_ear)



def _compute_shoulder_ratio(left_shoulder, right_shoulder) -> float:
    """Shoulder height difference as percentage of shoulder width.
    Distance-invariant — same value whether close or far from camera."""
    return shoulder_ratio(left_shoulder, right_shoulder)



def _compute_spine_angle(left_shoulder, right_shoulder, left_hip, right_hip) -> float:
    return spine_angle(left_shoulder, right_shoulder, left_hip, right_hip)



pose_detector = PoseDetector()
