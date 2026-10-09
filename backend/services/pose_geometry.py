"""二维姿态测量：像素比例、逐指标质量与浏览器端严格对应。"""
import math

METRIC_VERSION = 2
MIN_VISIBILITY = 0.5
METRIC_POINTS = {
    "head_angle": (7, 8), "shoulder_diff": (11, 12), "spine_angle": (11, 12, 23, 24),
}


def head_tilt_angle(a, b, width=640, height=480):
    dx = abs(b.x - a.x)
    if dx < 0.03:
        return None
    # 可信的大幅侧屈保留，不再把超过 30° 的动作清零。
    return math.degrees(math.atan2(abs(b.y - a.y) * height, dx * width))


def shoulder_ratio(a, b, width=640, height=480):
    dx = abs(b.x - a.x)
    if dx < 0.01:
        return None
    return abs(b.y - a.y) * height / (dx * width) * 100


def spine_angle(a, b, c, d, width=640, height=480):
    dx = (c.x + d.x - a.x - b.x) / 2
    dy = (c.y + d.y - a.y - b.y) / 2
    if dy < 0.001:
        return None
    return abs(math.degrees(math.atan2(dx * width, dy * height)))


def measure_pose(points, width, height):
    metrics, signed_metrics, quality = {}, {}, {}
    dimensions_valid = math.isfinite(width) and math.isfinite(height) and width > 0 and height > 0
    functions = {"head_angle": head_tilt_angle, "shoulder_diff": shoulder_ratio, "spine_angle": spine_angle}
    for name, indices in METRIC_POINTS.items():
        p = [points[i] if i < len(points) else None for i in indices]
        confidence = min((getattr(v, "visibility", 0) if math.isfinite(getattr(v, "visibility", 0)) else 0) for v in p)
        reason = None
        if not dimensions_valid or any(v is None or not math.isfinite(v.x) or not math.isfinite(v.y) for v in p):
            reason = "non_finite"
        elif any(v.x < 0 or v.x > 1 or v.y < 0 or v.y > 1 for v in p):
            reason = "out_of_frame"
        elif confidence < MIN_VISIBILITY:
            reason = "low_visibility"
        # Solutions 的 presence 未赋值时 protobuf 返回 0；仅检查确实存在的字段。
        elif any((v.HasField("presence") if hasattr(v, "HasField") else hasattr(v, "presence")) and
                 (not math.isfinite(v.presence) or v.presence < MIN_VISIBILITY) for v in p):
            reason = "low_visibility"
        if reason:
            quality[name] = {"valid": False, "confidence": confidence, "reason": reason}
            continue
        value = functions[name](*p, width=width, height=height)
        if value is None or not math.isfinite(value):
            quality[name] = {"valid": False, "confidence": confidence, "reason": "degenerate_geometry"}
        else:
            metrics[name] = round(value * 100) / 100
            # 带方向的原始特征供个人基线使用，不改变既有绝对值评分。
            # 复用已测量的幅度，只补方向，避免重复三角函数与双口径漂移。
            direction = (p[2].x + p[3].x - p[0].x - p[1].x) if name == 'spine_angle' else (p[1].y - p[0].y) / (p[1].x - p[0].x)
            signed = -value if direction < 0 else value
            signed_metrics[name] = round(signed * 100) / 100
            quality[name] = {"valid": True, "confidence": confidence}
    return {"metrics": metrics, "signed_metrics": signed_metrics, "quality": quality, "complete": len(metrics) == 3}
