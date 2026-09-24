"""部位健康度：生成 Python 后端的期望值，供前端 TS 对拍。

背景：Dashboard 的「部位健康度」曾经是编造的（头部写死 85、肩部 = 今日总分 + 5），
改为按 `posture_score` 的三个分项字段真实聚合后，**两端必须给出同样的数字**
（桌面端 `backend/services/part_health.py`、移动端 `src/platform/partHealth.ts`）。

用法：
    python scripts/gen-part-health-cases.py > scripts/part-health-expected.json
    node scripts/verify-part-health.mjs
"""

import json
import math
import os
import sys

# 后端模块用的是裸导入（from config import ...），因此要把 backend/ 本身加入 sys.path
BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
sys.path.insert(0, BACKEND)

from services.part_health import PARTS, compute_part_health  # noqa: E402
from services.scorer import (  # noqa: E402
    HEAD_MILD_HI,
    HEAD_MODERATE_HI,
    HEAD_TILT_THRESHOLD,
    SHOULDER_DIFF_THRESHOLD,
    SHOULDER_MILD_HI,
    SHOULDER_MODERATE_HI,
    SPINE_ANGLE_THRESHOLD,
    SPINE_MILD_HI,
    SPINE_MODERATE_HI,
    metric_deduction,
)
from services.rounding import round_1  # noqa: E402


def _js_math_round(x):
    """JS 的 `Math.round`：`floor(x + 0.5)`，即 .5 一律进位。"""
    return math.floor(x + 0.5)


def to_rows(samples):
    """[(head, shoulder, spine), ...] -> [{"head_angle": ..., ...}, ...]"""
    return [
        {"head_angle": h, "shoulder_diff": s, "spine_angle": p}
        for h, s, p in samples
    ]


# ---------------------------------------------------------------------------
# 平局点搜索
#
# 聚合结果要经 `round(x, 1)`（Python 银行家舍入）。若前端误用 `Math.round`
# 就会在 x.x5 上偏 1（例：97.25 → Python 97.2 / Math.round 97.3）。
# 但在 x.x5 以外的点上两种取整完全一致 —— 所以必须**专门搜出确实落在平局点的
# 输入**，否则这条守卫对「取整实现被换掉」毫无灵敏度。
# ---------------------------------------------------------------------------
def tie_samples():
    """搜出使「头部平均单项得分」恰好落在取整平局点、且两种取整**确实分叉**的两帧采样。

    「分叉」的判定用 `round_1`（本项目口径）对 `Math.round`（JS 默认行为）：
    若两者在这些输入上给出同样的结果，这条用例对「取整实现被换掉」就没有灵敏度，
    留着也是摆设。
    """
    th, mild_hi, moderate_hi = HEAD_TILT_THRESHOLD, HEAD_MILD_HI, HEAD_MODERATE_HI
    found = []
    seen = set()
    # 预警区 [zone_start, 阈值] 内取两位小数，两帧组合共 200×200 —— 足够且够快
    for i in range(300, 501):
        v1 = i / 100.0
        d1 = 100.0 - metric_deduction(v1, th, mild_hi, moderate_hi)
        for j in range(300, 501):
            key = (i, j)
            if key in seen:
                continue
            v2 = j / 100.0
            d2 = 100.0 - metric_deduction(v2, th, mild_hi, moderate_hi)
            mean = (d1 + d2) / 2.0
            scaled = mean * 10.0
            if scaled - float(int(scaled)) != 0.5:
                continue
            # 只保留「两种取整确实分叉」的点，才有区分度
            if round_1(mean) == _js_math_round(scaled) / 10.0:
                continue
            seen.add(key)
            seen.add((j, i))
            found.append([v1, v2])
            if len(found) >= 3:
                return found
    return found


def build_cases():
    cases = []

    def add(name, samples):
        cases.append({
            "name": name,
            "samples": [list(s) for s in samples],
            "expected": compute_part_health(to_rows(samples)),
        })

    # ---- 退化输入 ----
    add("空序列（无采样）", [])
    add("单点完美", [(0.0, 0.0, 0.0)])
    add("单点恰在阈值", [(5.0, 4.0, 10.0)])
    add("单点刚过阈值", [(5.01, 4.01, 10.01)])
    add("单点轻微档上界", [(11.0, 9.0, 18.0)])
    add("单点明显档上界", [(17.0, 14.0, 26.0)])
    add("单点极端（触发各项上限）", [(100.0, 100.0, 100.0)])

    # ---- 方向性反例：这是「旧实现必然失败」的那几条 ----
    # 旧实现下头部恒为 85、肩部 = 总分 + 5，以下三条都会给出错误的方向。
    add("反例·头部极差肩部极好", [(30.0, 0.0, 2.0)] * 20)
    add("反例·肩部极差头部极好", [(0.0, 30.0, 2.0)] * 20)
    add("反例·脊柱极差其余端正", [(0.0, 0.0, 40.0)] * 20)
    add("反例·三部位都极差", [(30.0, 30.0, 40.0)] * 20)

    # ---- 时间混合：前半端正、后半歪斜（验证是"平均"而不是"取最后一帧"）----
    add("混合·先好后差", [(1.0, 1.0, 4.0)] * 10 + [(20.0, 18.0, 34.0)] * 10)
    add("混合·三部位各不同", [(0.0, 30.0, 12.0), (2.0, 2.0, 2.0), (8.0, 4.0, 30.0)] * 6)

    # ---- 浮点：多位小数 + 较长的累加链（结合顺序写错会差 0.1）----
    add("多小数位序列", [(3.33, 2.77, 6.19), (4.44, 3.11, 8.02),
                          (5.55, 4.55, 11.11), (2.22, 1.99, 9.99)] * 7)
    add("长序列（33 帧）", [(1.05, 1.05, 1.05)] * 33)

    # ---- 取整平局点（每种取整实现会被拉到不同答案）----
    for n, pair in enumerate(tie_samples(), start=1):
        add(f"取整平局点 #{n}", [(pair[0], 1.0, 4.0), (pair[1], 1.0, 4.0)])

    return cases


def main():
    payload = {
        "constants": {
            "HEAD_TILT_THRESHOLD": HEAD_TILT_THRESHOLD,
            "SHOULDER_DIFF_THRESHOLD": SHOULDER_DIFF_THRESHOLD,
            "SPINE_ANGLE_THRESHOLD": SPINE_ANGLE_THRESHOLD,
            "HEAD_MILD_HI": HEAD_MILD_HI,
            "HEAD_MODERATE_HI": HEAD_MODERATE_HI,
            "SHOULDER_MILD_HI": SHOULDER_MILD_HI,
            "SHOULDER_MODERATE_HI": SHOULDER_MODERATE_HI,
            "SPINE_MILD_HI": SPINE_MILD_HI,
            "SPINE_MODERATE_HI": SPINE_MODERATE_HI,
        },
        # 部位与字段的对应关系也要跟着走：前端若把 head 接到 spine_angle 上，
        # 光比对数值可能撞巧相等，这里把映射本身也钉住。
        "parts": [[key, field] for key, field, *_ in PARTS],
        "cases": build_cases(),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
