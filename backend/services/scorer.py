import logging

from config import HEAD_TILT_THRESHOLD, SHOULDER_DIFF_THRESHOLD, SPINE_ANGLE_THRESHOLD

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


def compute_score(head_angle: float, shoulder_diff: float, spine_angle: float) -> dict:
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
