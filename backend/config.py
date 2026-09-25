import os

APP_VERSION = "1.6.1"

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
# 用户可在设置页覆盖（settings 键 `retention_days`），取值被 clamp 到下面这个区间。
# 前端同值常量：src/platform/dailyAgg.ts（由 verify-daily-agg.mjs / verify-export-format.mjs 对拍）。
RETENTION_DAYS = 30
MIN_RETENTION_DAYS = 7
MAX_RETENTION_DAYS = 365
# 后台维护（聚合 + 清理）的执行间隔，分钟。
MAINTENANCE_INTERVAL_MINUTES = 30


def clamp_retention_days(value) -> int:
    """把用户填的保留天数收敛到合法区间。

    🔴 单点定义：桌面端（retention.py）与移动端（dailyAgg.ts）都要走同一套上下界，
    否则会出现"电脑保留 30 天、手机保留 1 天"——而 1 天就把历史删干净了。

    规则（与 TS 侧逐条对齐，每一处差异都实测过）：

    - 布尔值 → 回落默认值。**不能**让 `int(True)` 生效：Python 里 `int(True) == 1`，
      而 JS 的 `parseInt(String(true))` 是 NaN，两端会给出 7 与 30 两个不同答案。
    - 浮点 → 向零取整（`int(30.9) == 30`，与 JS 的 `Math.trunc` 一致）。
    - 字符串 → **只认纯整数**（`^[+-]?\\d+$`）。用 `int()` 的宽松解析会让 `" 45 "`
      通过而 `"45.0"` 抛错，JS 的 `parseInt` 则两者都通过 —— 又是一个分叉点。
    - 其它（None / 对象）→ 回落默认值。
    - 非法输入一律回落**默认值 30**（不是最小值）：填错不该导致最多数据被删。
    """
    import math
    import re

    if isinstance(value, bool):
        return RETENTION_DAYS
    if isinstance(value, int):
        n = value
    elif isinstance(value, float):
        if not math.isfinite(value):
            return RETENTION_DAYS
        n = int(value)
    elif isinstance(value, str):
        s = value.strip()
        if not re.match(r"^[+-]?\d+$", s):
            return RETENTION_DAYS
        n = int(s)
    else:
        return RETENTION_DAYS

    if n < MIN_RETENTION_DAYS:
        return MIN_RETENTION_DAYS
    if n > MAX_RETENTION_DAYS:
        return MAX_RETENTION_DAYS
    return n

# 可选的 DeepSeek 模型（前端下拉展示；也允许用户手动填写其它模型名）
AVAILABLE_MODELS = ["deepseek-chat", "deepseek-reasoner"]
