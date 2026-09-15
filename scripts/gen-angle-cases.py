"""角度计算：Python 后端 vs 前端 TS 的数值等价性验证。

生成覆盖典型/边界场景的 landmark 坐标（归一化 0~1），
调用 Python 的 _compute_* 函数算出期望角度，输出 JSON 供 node 侧对比。
"""

import json
import sys
import os
import math

BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
sys.path.insert(0, BACKEND)

import services.pose_detector as pd  # noqa: E402


class LM:
    """最小 landmark 桩：只需要 x / y。"""
    def __init__(self, x, y):
        self.x = x
        self.y = y


# 每项：{name, left_ear, right_ear, left_shoulder, right_shoulder, left_hip, right_hip}
# 坐标用归一化值（0~1）
CASES = [
    {
        "name": "perfect_upright_frontal",
        "left_ear": (0.42, 0.20), "right_ear": (0.58, 0.20),
        "left_shoulder": (0.35, 0.35), "right_shoulder": (0.65, 0.35),
        "left_hip": (0.38, 0.70), "right_hip": (0.62, 0.70),
    },
    {
        "name": "head_tilt_10deg",
        "left_ear": (0.40, 0.21), "right_ear": (0.60, 0.185),
        "left_shoulder": (0.35, 0.35), "right_shoulder": (0.65, 0.35),
        "left_hip": (0.38, 0.70), "right_hip": (0.62, 0.70),
    },
    {
        "name": "shoulders_tilted",
        "left_ear": (0.42, 0.20), "right_ear": (0.58, 0.20),
        "left_shoulder": (0.35, 0.34), "right_shoulder": (0.65, 0.38),
        "left_hip": (0.38, 0.70), "right_hip": (0.62, 0.70),
    },
    {
        "name": "spine_leaning",
        "left_ear": (0.46, 0.20), "right_ear": (0.62, 0.20),
        "left_shoulder": (0.40, 0.35), "right_shoulder": (0.70, 0.35),
        "left_hip": (0.44, 0.70), "right_hip": (0.68, 0.70),
    },
    {
        "name": "ears_too_close_dx_guard",
        "left_ear": (0.495, 0.20), "right_ear": (0.505, 0.25),
        "left_shoulder": (0.35, 0.35), "right_shoulder": (0.65, 0.35),
        "left_hip": (0.38, 0.70), "right_hip": (0.62, 0.70),
    },
    {
        "name": "shoulders_almost_same_x_guard",
        "left_ear": (0.42, 0.20), "right_ear": (0.58, 0.20),
        "left_shoulder": (0.50, 0.35), "right_shoulder": (0.505, 0.40),
        "left_hip": (0.38, 0.70), "right_hip": (0.62, 0.70),
    },
    {
        "name": "head_tilt_beyond_30_guard",
        "left_ear": (0.45, 0.20), "right_ear": (0.55, 0.45),
        "left_shoulder": (0.35, 0.35), "right_shoulder": (0.65, 0.35),
        "left_hip": (0.38, 0.70), "right_hip": (0.62, 0.70),
    },
    {
        "name": "spine_dy_zero_guard",
        "left_ear": (0.42, 0.20), "right_ear": (0.58, 0.20),
        "left_shoulder": (0.35, 0.50), "right_shoulder": (0.65, 0.50),
        "left_hip": (0.38, 0.50), "right_hip": (0.62, 0.50),
    },
]


def main():
    out = []
    for c in CASES:
        head = pd._compute_head_tilt_angle(LM(*c["left_ear"]), LM(*c["right_ear"]))
        shoulder = pd._compute_shoulder_ratio(LM(*c["left_shoulder"]), LM(*c["right_shoulder"]))
        spine = pd._compute_spine_angle(
            LM(*c["left_shoulder"]), LM(*c["right_shoulder"]),
            LM(*c["left_hip"]), LM(*c["right_hip"]),
        )
        out.append({
            "name": c["name"],
            "landmarks": {k: c[k] for k in (
                "left_ear", "right_ear", "left_shoulder", "right_shoulder", "left_hip", "right_hip"
            )},
            "head_angle": round(head, 2),
            "shoulder_diff": round(shoulder, 2),
            "spine_angle": round(spine, 2),
        })
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
