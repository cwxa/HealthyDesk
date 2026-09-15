"""姿态评分：Python 后端 vs 前端 TS 的数值等价性验证。

思路：构造一组覆盖典型场景的 (head_angle, shoulder_diff, spine_angle) 输入，
分别用 Python 的 scorer.compute_score 与前端 TS 的 computeScore 计算，
逐条比对 score 与 issues 是否完全一致。

前端实现由 scripts/verify-scoring.mjs 用 esbuild 把**真实源码**
src/platform/localPoseEngine.ts 打出来执行（不是内联副本），所以这里只需
产出「Python 侧的期望值」。

除评分外还覆盖**平滑器**（帧 → 角度 → 平滑 → 评分 里的中间一环）：
同一个姿势在手机和电脑上要得到同一串平滑值，否则分数还是会不一致。

用法：
    python scripts/gen-scoring-cases.py > scripts/scoring-expected.json
    node scripts/verify-scoring.mjs
"""

import json
import math
import sys
import os

# 后端模块用的是裸导入（from config import ...），因此要把 backend/ 本身加入 sys.path
BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
sys.path.insert(0, BACKEND)

import services.scorer as _scorer  # noqa: E402
import services.smoother as _smoother  # noqa: E402

compute_score = _scorer.compute_score
PoseSmoother = _smoother.PoseSmoother
EMA_ALPHA = _smoother.EMA_ALPHA

CASES = [
    # (head_angle, shoulder_diff, spine_angle) —— 覆盖各档位边界
    (0.0, 0.0, 0.0),        # 完美姿势
    (3.0, 2.0, 5.0),        # 阈值内
    (5.0, 4.0, 10.0),       # 恰好等于阈值：不提醒，但已进入预警区
    (5.01, 4.01, 10.01),    # 刚过阈值 → 必须低于 80 分
    (8.0, 6.0, 12.0),       # 轻微
    (12.0, 8.0, 15.0),      # 中等
    (18.0, 14.0, 20.0),     # 明显
    (30.0, 50.0, 60.0),     # 极端，触发各项上限
    (100.0, 100.0, 100.0),  # 更极端，分数应被 min 到 20
    (5.5, 4.5, 10.5),       # 微小超出，验证小数舍入
    (11.0, 3.0, 9.0),       # 只有头部有问题
    (2.0, 12.0, 4.0),       # 只有肩部有问题
    (1.0, 1.0, 18.0),       # 只有脊柱有问题
]


def _boundary_cases():
    """扫描每项指标的「预警区起点 / 阈值 / 轻微上界 / 明显上界」，共 ~60 条。

    用途：让 verify-scoring.mjs 能够验证核心约束
        「出现任何提醒（issues 非空） ⟺ 分数 < 80」
    单靠几条典型用例证明不了这条，必须在边界附近密集取样。
    """
    cases = []
    safe = (2.0, 2.0, 5.0)  # 另两项固定在不触发预警、也不触发提醒的安全值

    # 头部：阈值 5.0，轻微上界 +6（11.0），明显上界 +12（17.0）
    for v in (0.0, 2.0, 2.99, 3.0, 3.01, 4.0, 4.9, 5.0, 5.01, 5.5, 8.0,
              10.99, 11.0, 11.01, 13.0, 16.99, 17.0, 17.01, 20.0, 29.0, 40.0):
        cases.append((v, safe[1], safe[2]))

    # 肩部：阈值 4.0，轻微上界 +5（9.0），明显上界 +10（14.0）
    for v in (0.0, 2.0, 2.39, 2.4, 2.41, 3.0, 3.9, 4.0, 4.01, 4.5, 6.0,
              8.99, 9.0, 9.01, 11.0, 13.99, 14.0, 14.01, 18.0, 24.0, 30.0):
        cases.append((safe[0], v, safe[2]))

    # 脊柱：阈值 10.0，轻微上界 +8（18.0），明显上界 +16（26.0）
    for v in (0.0, 4.0, 5.99, 6.0, 6.01, 8.0, 9.9, 10.0, 10.01, 12.0,
              17.99, 18.0, 18.01, 20.0, 25.99, 26.0, 26.01, 34.0, 42.0, 60.0):
        cases.append((safe[0], safe[1], v))

    # 三项组合：刚好卡在各档边界上
    for combo in ((6.0, 5.0, 8.0), (12.0, 10.0, 16.0), (17.0, 14.0, 26.0),
                  (11.5, 9.5, 18.5), (20.0, 16.0, 30.0)):
        cases.append(combo)

    return cases


CASES = CASES + _boundary_cases()


# ---------------------------------------------------------------------------
# 平滑器对拍用例
#
# 背景：后端原先写的是 `round(x, 2)`，前端是 `pyRound(x * 100) / 100`。
# 两者不是同一个函数 —— 当 `x * 100` 恰好落在半整数上时结果会不同
# （例：x = 0.015 → round(x, 2) = 0.01，而 round(x * 100) / 100 = 0.02）。
# 下面第一组专门构造能踩中这个点的输入，作为回归用例；第二组是常规序列。
# ---------------------------------------------------------------------------

def _tie_cases():
    """构造能让 `round(x, 2)` 与 `round(x * 100) / 100` 分叉的平滑输入。

    第一帧把内部状态置为 v，第二帧传 0，则平滑值 x = 0.65 * v。
    只要此时 x * 100 恰好等于半整数，两种取整实现就会给出不同结果。
    """
    out = []
    for k in range(1, 40000):
        v = (k + 0.5) / 65.0
        x = (1 - EMA_ALPHA) * v
        t = x * 100.0
        if t != math.floor(t) + 0.5:
            continue                      # 没踩中平局点，无区分度
        if round(x, 2) == round(x * 100) / 100:
            continue                      # 这个点两种实现恰好一致
        out.append(v)
        if len(out) >= 40:
            break
    return out


def _sequences():
    """返回 [(frames, smoothed), ...]：frames 是逐帧原始值，smoothed 是期望平滑值。"""
    seqs = []

    # 1) 平局点回归：两帧一组
    for v in _tie_cases():
        seqs.append([[v, 0.0, 0.0], [0.0, 0.0, 0.0]])

    # 2) 常规序列：确定性 LCG（与 verify-scoring.mjs 无关，只在这里生成输入）
    x = 20260915
    frames = []
    for i in range(240):
        if i == 120:
            frames.append(None)           # None 表示 reset()
            continue
        x = (x * 48271) % 2147483647
        head = (x % 2501) / 100
        x = (x * 48271) % 2147483647
        shoulder = (x % 2001) / 100
        x = (x * 48271) % 2147483647
        spine = (x % 4501) / 100
        frames.append([head, shoulder, spine])
    seqs.append(frames)

    # 3) 抖动序列：在阈值附近来回跳（评分与提醒最容易失配的位置）
    frames = []
    for i in range(120):
        frames.append([5.0 + (0.4 if i % 2 else -0.4),
                       4.0 + (0.2 if i % 3 else -0.2),
                       10.0 + (0.6 if i % 5 else -0.6)])
    seqs.append(frames)

    out = []
    for frames in seqs:
        smoother = PoseSmoother()
        smoothed = []
        for f in frames:
            if f is None:
                smoother.reset()
                smoothed.append(None)
                continue
            r = smoother.update({"head_angle": f[0], "shoulder_diff": f[1], "spine_angle": f[2]})
            smoothed.append([r["head_angle"], r["shoulder_diff"], r["spine_angle"]])
        out.append({"frames": frames, "smoothed": smoothed})
    return out


def main():
    out = []
    for head, sh, spine in CASES:
        r = compute_score(head, sh, spine)
        out.append({
            "input": {"head": head, "shoulder": sh, "spine": spine},
            "score": r["score"],
            "issues": r["issues"],
        })

    # 顺带把 Python 侧用到的全部评分常量导出，供 node 侧比对前端是否漂移。
    # 只比对用例结果的话，两端「同时改错但改得一样」是发现不了的。
    payload = {
        "constants": {
            "HEAD_TILT_THRESHOLD": _scorer.HEAD_TILT_THRESHOLD,
            "SHOULDER_DIFF_THRESHOLD": _scorer.SHOULDER_DIFF_THRESHOLD,
            "SPINE_ANGLE_THRESHOLD": _scorer.SPINE_ANGLE_THRESHOLD,
            "WARN_ZONE_RATIO": _scorer.WARN_ZONE_RATIO,
            "WARN_ZONE_MAX": _scorer.WARN_ZONE_MAX,
            "SECONDARY_WEIGHT": _scorer.SECONDARY_WEIGHT,
            "MILD_BASE": _scorer.MILD_BASE,
            "MILD_MAX": _scorer.MILD_MAX,
            "MODERATE_BASE": _scorer.MODERATE_BASE,
            "MODERATE_MAX": _scorer.MODERATE_MAX,
            "SEVERE_BASE": _scorer.SEVERE_BASE,
            "SEVERE_MAX": _scorer.SEVERE_MAX,
            "SCORE_MIN": _scorer.SCORE_MIN,
            "SCORE_MAX": _scorer.SCORE_MAX,
            "HEAD_MILD_HI": _scorer.HEAD_MILD_HI,
            "HEAD_MODERATE_HI": _scorer.HEAD_MODERATE_HI,
            "SHOULDER_MILD_HI": _scorer.SHOULDER_MILD_HI,
            "SHOULDER_MODERATE_HI": _scorer.SHOULDER_MODERATE_HI,
            "SPINE_MILD_HI": _scorer.SPINE_MILD_HI,
            "SPINE_MODERATE_HI": _scorer.SPINE_MODERATE_HI,
        },
        # 平滑器常量与逐帧期望值
        "smootherConstants": {"EMA_ALPHA": EMA_ALPHA},
        "smootherSequences": _sequences(),
        "cases": out,
    }
    # 输出到 stdout，供 node 侧读取比对
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
