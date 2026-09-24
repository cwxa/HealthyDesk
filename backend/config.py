import os

APP_VERSION = "1.4.0"

BACKEND_PORT = int(os.getenv("NECKGUARDIAN_PORT", "18920"))
DB_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data", "neckguardian.db")

# ---- DeepSeek 大模型 ----
# 环境变量作为「默认值」；用户可在设置页覆盖（写库），优先级：数据库 > 环境变量。
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = os.getenv("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEEPSEEK_MODEL = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")
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

# 提醒间隔的合法范围（settings 校验、前端输入、scheduler 读取共用同一来源）
MIN_REMINDER_INTERVAL = 2
MAX_REMINDER_INTERVAL = 120

# ---- 数据保留（ROADMAP 需求 4）----
# 原始姿态采样保留天数，超期后只保留 posture_daily 的日聚合（见 services/retention.py）。
# 🔴 必须 >= 任何展示窗口（当前最大是周报的 7 天），否则图表会缺口。
# 前端同值常量：src/platform/dailyAgg.ts :: RETENTION_DAYS（由 verify-daily-agg.mjs 对拍）。
RETENTION_DAYS = 30
# 后台维护（聚合 + 清理）的执行间隔，分钟。
MAINTENANCE_INTERVAL_MINUTES = 30

# 可选的 DeepSeek 模型（前端下拉展示；也允许用户手动填写其它模型名）
AVAILABLE_MODELS = ["deepseek-chat", "deepseek-reasoner"]
