import math
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
        try:
            results = self.pose.process(image)
            if not results.pose_landmarks:
                return None

            landmarks = results.pose_landmarks.landmark
            h, w = image.shape[:2]

            # Visibility check — skip if key landmarks are uncertain
            vis = {i: landmarks[i].visibility for i in CHECK_LANDMARKS}
            min_vis = min(vis.values())
            if min_vis < MIN_VISIBILITY:
                logger.debug("Low visibility: min=%.2f, skipping frame", min_vis)
                return None

            head_angle = _compute_head_tilt_angle(
                landmarks[LEFT_EAR], landmarks[RIGHT_EAR]
            )

            shoulder_diff = _compute_shoulder_ratio(
                landmarks[LEFT_SHOULDER], landmarks[RIGHT_SHOULDER]
            )

            spine_angle = _compute_spine_angle(
                landmarks[LEFT_SHOULDER], landmarks[RIGHT_SHOULDER],
                landmarks[LEFT_HIP], landmarks[RIGHT_HIP]
            )

            return {
                "head_angle": round(head_angle, 2),
                "shoulder_diff": round(shoulder_diff, 2),
                "spine_angle": round(spine_angle, 2),
                "visibility": round(min_vis, 3),
                "landmarks": {
                    "nose": _point(landmarks[NOSE], w, h),
                    "left_ear": _point(landmarks[LEFT_EAR], w, h),
                    "right_ear": _point(landmarks[RIGHT_EAR], w, h),
                    "left_shoulder": _point(landmarks[LEFT_SHOULDER], w, h),
                    "right_shoulder": _point(landmarks[RIGHT_SHOULDER], w, h),
                },
            }
        except Exception as e:
            logger.error("Pose processing error: %s", e)
            return None

    def release(self):
        if self.pose:
            self.pose.close()
            self._initialized = False


def _point(landmark, w, h):
    return {"x": round(landmark.x * w, 1), "y": round(landmark.y * h, 1)}


def _compute_head_tilt_angle(left_ear, right_ear) -> float:
    """Head lateral tilt: angle of the ear-to-ear line relative to horizontal.
    Pure 2D metric — no Z-depth involved. Reliable from a front-facing camera.
    Note: in the raw (unmirrored) frame, the person's left ear is on the RIGHT
    side of the image (larger x), so right_ear.x < left_ear.x in image coords."""
    dx = abs(right_ear.x - left_ear.x)  # horizontal ear separation
    dy = abs(right_ear.y - left_ear.y)  # vertical ear difference

    # Sanity: ears must be reasonably separated horizontally
    if dx < 0.03:
        return 0.0

    angle = math.degrees(math.atan2(dy, dx))

    # Beyond 30° is physiologically unlikely for head tilt — tracking error
    if angle > 30:
        return 0.0

    return angle


def _compute_shoulder_ratio(left_shoulder, right_shoulder) -> float:
    """Shoulder height difference as percentage of shoulder width.
    Distance-invariant — same value whether close or far from camera."""
    shoulder_width = abs(left_shoulder.x - right_shoulder.x)
    if shoulder_width < 0.01:
        return 0.0
    dy = abs(left_shoulder.y - right_shoulder.y)
    return (dy / shoulder_width) * 100


def _compute_spine_angle(left_shoulder, right_shoulder, left_hip, right_hip) -> float:
    shoulder_mid_x = (left_shoulder.x + right_shoulder.x) / 2
    shoulder_mid_y = (left_shoulder.y + right_shoulder.y) / 2
    hip_mid_x = (left_hip.x + right_hip.x) / 2
    hip_mid_y = (left_hip.y + right_hip.y) / 2
    dx = hip_mid_x - shoulder_mid_x
    dy = hip_mid_y - shoulder_mid_y
    if dy < 0.001:
        return 90.0
    return abs(math.degrees(math.atan2(dx, dy)))


pose_detector = PoseDetector()
