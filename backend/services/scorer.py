import logging
from config import HEAD_TILT_THRESHOLD, SHOULDER_DIFF_THRESHOLD, SPINE_ANGLE_THRESHOLD

logger = logging.getLogger("neckguardian.scorer")

DEDUCTION_RATE = 0.7


def compute_score(head_angle: float, shoulder_diff: float, spine_angle: float) -> dict:
    head_excess = max(0, head_angle - HEAD_TILT_THRESHOLD)
    shoulder_excess = max(0, shoulder_diff - SHOULDER_DIFF_THRESHOLD)
    spine_excess = max(0, spine_angle - SPINE_ANGLE_THRESHOLD)

    head_deduction = min(35, head_excess * DEDUCTION_RATE)
    shoulder_deduction = min(25, shoulder_excess * DEDUCTION_RATE)
    spine_deduction = min(25, spine_excess * DEDUCTION_RATE)

    total_deduction = head_deduction + shoulder_deduction + spine_deduction
    score = max(20, min(100, round(100 - total_deduction)))

    issues = []

    if head_excess > 0:
        if head_excess > 12:
            issues.append("头部严重侧倾")
        elif head_excess > 6:
            issues.append("头部明显侧倾")
        else:
            issues.append("头部轻微侧倾")

    if shoulder_excess > 0:
        if shoulder_excess > 10:
            issues.append("肩部严重不平衡")
        elif shoulder_excess > 5:
            issues.append("肩部明显不平衡")
        else:
            issues.append("肩部略不平衡")

    if spine_excess > 0:
        if spine_excess > 16:
            issues.append("脊柱严重倾斜")
        elif spine_excess > 8:
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
