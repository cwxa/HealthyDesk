import os

BACKEND_PORT = int(os.getenv("NECKGUARDIAN_PORT", "18920"))
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "neckguardian.db")
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
AI_ENABLED = bool(DEEPSEEK_API_KEY)
CAMERA_WIDTH = 640
CAMERA_HEIGHT = 480
POSTURE_CHECK_DURATION = 60
REMINDER_INTERVAL_MINUTES = 30
LOW_SCORE_THRESHOLD = 60
CONSECUTIVE_LOW_COUNT = 3
HEAD_TILT_THRESHOLD = 5.0  # degrees, ear-line vs horizontal
SHOULDER_DIFF_THRESHOLD = 4.0  # percentage of shoulder width (distance-invariant)
SPINE_ANGLE_THRESHOLD = 10.0
