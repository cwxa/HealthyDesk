import logging

from config import HEAD_TILT_THRESHOLD, SHOULDER_DIFF_THRESHOLD, SPINE_ANGLE_THRESHOLD
from services.rounding import round_int, round_1

logger = logging.getLogger("neckguardian.scorer")

# ---------------------------------------------------------------------------
# 评分模型
#
# 唯一需要记住的规则：
#     出现任何姿态提醒（issues 非空）  ⟺  分数 < 80
#
# 为此把扣分与提醒的三档**严格绑定**：只要某项超标（excess > 0），该项至少扣
# MILD_BASE 分，所以单项轻微超标就已经落到 80 以下。
#
# 旧公式「扣分 = 超量 × 0.7」在这一点上是自相矛盾的：头部偏 7° 会提醒
# 「头部轻微侧倾」，却只扣 1.4 分仍是 99 分；即使「头部严重侧倾」（超 12°）
# 也只扣 8.4 分 → 92 分，于是出现「提醒了但分数极高」。
#
# 阈值内另留一段「预警区」：接近阈值时轻微扣分（每项最多 WARN_ZONE_MAX 分），
# 避免「刚好没超标 = 100 分、刚超标 = 78 分」的突变。三项都压在预警区末端
# 也只扣 9.6 分（≥ 90 分），仍属「良好」，与「无提醒」一致。
# ---------------------------------------------------------------------------

WARN_ZONE_RATIO = 0.6   # 超过阈值的该比例后进入预警区
WARN_ZONE_MAX = 6.0     # 预警区每项最多扣分（三项合计 9.6，仍 ≥ 90 分）

# 叠加权重：只把最差的一项算满，其余两项按此权重递减叠加。
# 三项直接相加会过度惩罚 —— 三个指标都来自同一组 landmark、彼此强相关，
# 坐姿稍差时往往同时轻微超标，直接相加会让「三项都只是轻微」掉到 20 多分，
# 用户会觉得「我明明坐得还行，怎么才 27 分」。
SECONDARY_WEIGHT = 0.3

MILD_BASE, MILD_MAX = 22.0, 28.0            # 轻微档：单项 78 → 72 分
MODERATE_BASE, MODERATE_MAX = 34.0, 46.0    # 明显档：单项 66 → 54 分
SEVERE_BASE, SEVERE_MAX = 52.0, 65.0        # 严重档：单项 48 → 35 分

SCORE_MIN, SCORE_MAX = 20, 100

# 每项指标的档位边界：超出阈值多少算「明显 / 严重」。
# ⚠️ 必须与下方 issues 的分档判断使用同一组常量，否则「有提醒 ⟺ 分数 < 80」会被破坏。
HEAD_MILD_HI, HEAD_MODERATE_HI = 6.0, 12.0
SHOULDER_MILD_HI, SHOULDER_MODERATE_HI = 5.0, 10.0
SPINE_MILD_HI, SPINE_MODERATE_HI = 8.0, 16.0


def metric_deduction(value: float, threshold: float, mild_hi: float, moderate_hi: float) -> float:
    """单项扣分（分段与 issues 的三档严格一致）。

    公开（非 `_` 前缀）是有意的：除总分合成外，`services/part_health.py` 的
    「部位健康度」也复用它 —— 部位健康度 = 100 − 本函数结果的时间平均。
    必须共用同一个函数，否则会出现「部位显示良好、却提醒该部位」的自相矛盾。
    """
    excess = value - threshold
    if excess <= 0:
        # 未超标：仅在接近阈值时轻微扣分
        zone_start = threshold * WARN_ZONE_RATIO
        if value <= zone_start:
            return 0.0
        return WARN_ZONE_MAX * (value - zone_start) / (threshold - zone_start)
    if excess <= mild_hi:
        return MILD_BASE + (MILD_MAX - MILD_BASE) * (excess / mild_hi)
    if excess <= moderate_hi:
        return MODERATE_BASE + (MODERATE_MAX - MODERATE_BASE) * (
            (excess - mild_hi) / (moderate_hi - mild_hi)
        )
    return SEVERE_BASE + min(
        SEVERE_MAX - SEVERE_BASE,
        (SEVERE_MAX - SEVERE_BASE) * ((excess - moderate_hi) / moderate_hi),
    )


# ---------------------------------------------------------------------------
# 运动态（exercise）通道
#
# 静息态问「你对称吗」，运动态问「这个动作做到位了吗」。
#
# 这不是措辞差异，而是**判定方向相反**：康复动作的定义就是"把头摆到非中立位"。
# 未分通道时的实测后果（用本文件真实函数跑出来）：
#
#     颈部左侧屈 8° / 12° / 20° / 30° → 75 / 64 / 45 / 35 分
#     且 issues 依次为「头部轻微/明显/严重侧倾」
#
# 而正常颈椎侧屈活动度约 45° —— 也就是说**用户把这个动作做到位，就必然被判
# 「头部严重侧倾」**，拿到 35–45 分，还会被语音批评（NeckActivity 的
# speakPostureIssue 此前没有 mode 判断），这条低分又被写进活动记录，
# 在 Dashboard 里渲染成一条红色记录。产品在惩罚用户做它要求做的事。
#
# 所以运动态用一套独立度量：只看「活动量」——各项相对各自阈值的倍数，取三者最大
# ——再映射到 0–100 的达成度。它**不产出任何静息类 issues 文案**（「侧倾」「不平衡」
# 「倾斜」在运动态是错的措辞），也不应触发语音批评（由前端保证）。
#
# 🔴 静息态不受任何影响：`compute_score(..., mode="monitor")` 与分通道前逐位相同，
#    由 scripts/verify-scoring.mjs 的 21 常量 + 80 用例 + 439 帧守住。
# ---------------------------------------------------------------------------

MODE_MONITOR = "monitor"
MODE_EXERCISE = "exercise"

EXERCISE_ACTIVITY_START = 1.0   # 活动量达到 1 倍阈值 = 有效活动的起点（达标线）
EXERCISE_ACTIVITY_FULL = 4.0    # 达到 4 倍阈值 = 充分活动（满分）
EXERCISE_SCORE_BASE = 60.0      # 有效活动的基础分（与达标线同一处取值）


def exercise_activity(head_angle: float, shoulder_diff: float, spine_angle: float) -> float:
    """运动态活动量：三项相对各自静息阈值的倍数，取最大者。

    复用静息阈值当标尺（而不是另立一套"典型活动幅度"），是为了让「活动量 1.0」
    有明确含义：**该部位的偏离已经达到静息态的提醒线**，即"确实动起来了"。
    """
    return max(
        head_angle / HEAD_TILT_THRESHOLD,
        shoulder_diff / SHOULDER_DIFF_THRESHOLD,
        spine_angle / SPINE_ANGLE_THRESHOLD,
    )


def _exercise_score(head_angle: float, shoulder_diff: float, spine_angle: float) -> dict:
    activity = exercise_activity(head_angle, shoulder_diff, spine_angle)

    if activity >= EXERCISE_ACTIVITY_FULL:
        raw = float(SCORE_MAX)
    elif activity >= EXERCISE_ACTIVITY_START:
        raw = EXERCISE_SCORE_BASE + (SCORE_MAX - EXERCISE_SCORE_BASE) * (
            (activity - EXERCISE_ACTIVITY_START) / (EXERCISE_ACTIVITY_FULL - EXERCISE_ACTIVITY_START)
        )
    else:
        raw = EXERCISE_SCORE_BASE * (activity / EXERCISE_ACTIVITY_START)

    # 用 round_int（统一口径）而不是内置 round()：本通道是新加的，
    # 没有历史数值包袱，直接落在两端可精确复刻的口径上。
    score = max(0, min(SCORE_MAX, round_int(max(0.0, raw))))

    # ⚠️ 「达标与否」以**取整后的 score** 为准，而不是原始 activity：
    # activity = 0.999 时 raw = 59.94 → 取整成 60（正好落在达标线上），
    # 若换成用 activity 判定，就会出现「显示 60 分、却说幅度不足」的自相矛盾。
    # 这也延续了本项目那条更根本的约束 —— 用户看到的数字与系统判定必须同源。
    completed = score >= EXERCISE_SCORE_BASE
    issues = [] if completed else ["动作幅度不足，再大一点"]

    logger.debug(
        "Exercise score=%d | head=%.1f° shoulder_diff=%.1f spine=%.1f° | activity=%.2f",
        score, head_angle, shoulder_diff, spine_angle, activity,
    )
    return {
        "score": score,
        "issues": issues,
        "head_angle": head_angle,
        "shoulder_diff": shoulder_diff,
        "spine_angle": spine_angle,
        "mode": MODE_EXERCISE,
        "activity": round_1(activity),
        "completed": completed,
    }


def compute_score(
    head_angle: float,
    shoulder_diff: float,
    spine_angle: float,
    mode: str = MODE_MONITOR,
) -> dict:
    """按模式分发。

    - `mode="monitor"`（默认）：静息坐姿评分，语义与历史版本**完全一致**。
    - `mode="exercise"`：运动态通道，语义是「这个动作做到位了吗」，见上方说明。

    不传 mode 时行为与旧签名逐位相同，因此所有既有调用点无需改动。
    """
    if mode == MODE_EXERCISE:
        return _exercise_score(head_angle, shoulder_diff, spine_angle)
    return _monitor_score(head_angle, shoulder_diff, spine_angle)


def _monitor_score(head_angle: float, shoulder_diff: float, spine_angle: float) -> dict:
    """静息态评分 —— 🔴 实现与返回结构必须与历史版本一字不变。"""
    head_excess = max(0, head_angle - HEAD_TILT_THRESHOLD)
    shoulder_excess = max(0, shoulder_diff - SHOULDER_DIFF_THRESHOLD)
    spine_excess = max(0, spine_angle - SPINE_ANGLE_THRESHOLD)

    # 先算三项各自的扣分，再「最差项算满 + 其余项按 SECONDARY_WEIGHT 递减叠加」。
    # 排序只用于把最大的排到前面；取值完全确定，两端结果一致。
    deductions = sorted(
        (
            metric_deduction(head_angle, HEAD_TILT_THRESHOLD, HEAD_MILD_HI, HEAD_MODERATE_HI),
            metric_deduction(shoulder_diff, SHOULDER_DIFF_THRESHOLD, SHOULDER_MILD_HI, SHOULDER_MODERATE_HI),
            metric_deduction(spine_angle, SPINE_ANGLE_THRESHOLD, SPINE_MILD_HI, SPINE_MODERATE_HI),
        ),
        reverse=True,
    )
    total_deduction = deductions[0] + SECONDARY_WEIGHT * (deductions[1] + deductions[2])
    score = max(SCORE_MIN, min(SCORE_MAX, round(SCORE_MAX - total_deduction)))

    issues = []

    if head_excess > 0:
        if head_excess > HEAD_MODERATE_HI:
            issues.append("头部严重侧倾")
        elif head_excess > HEAD_MILD_HI:
            issues.append("头部明显侧倾")
        else:
            issues.append("头部轻微侧倾")

    if shoulder_excess > 0:
        if shoulder_excess > SHOULDER_MODERATE_HI:
            issues.append("肩部严重不平衡")
        elif shoulder_excess > SHOULDER_MILD_HI:
            issues.append("肩部明显不平衡")
        else:
            issues.append("肩部略不平衡")

    if spine_excess > 0:
        if spine_excess > SPINE_MODERATE_HI:
            issues.append("脊柱严重倾斜")
        elif spine_excess > SPINE_MILD_HI:
            issues.append("脊柱明显倾斜")
        else:
            issues.append("脊柱轻微倾斜")

    logger.debug(
        "Pose score=%d | head=%.1f° shoulder_diff=%.1f spine=%.1f° | issues=%s",
        score, head_angle, shoulder_diff, spine_angle, issues,
    )
    return {
        "score": score,
        "issues": issues,
        "head_angle": head_angle,
        "shoulder_diff": shoulder_diff,
        "spine_angle": spine_angle,
    }
