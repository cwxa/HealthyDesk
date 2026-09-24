"""动作完成度：生成 Python 后端的期望值，供前端 TS 对拍 + 离线样本回放。

背景：活动执行链路此前只有倒计时，用户全程不动、系统照样宣布「活动完成!」。
S2 引入 `judge_exercise()` 把一串帧折成三分类结论（completed / insufficient / idle）。
该判定同时存在于桌面端（Python，`services/exercise_quality.py`）与移动端
（TS，`src/platform/exerciseQuality.ts`）—— **两端给出不同结论**就是新的
「手机和电脑说法不一样」。

用法：
    python scripts/gen-exercise-quality-cases.py > scripts/exercise-quality-expected.json
    node scripts/verify-exercise-quality.mjs

样本文件（`scripts/samples/exercise-*.json`）由本脚本与守卫脚本**共同读取**，
因此「样本 → 期望值」不会漂移：守卫会重新读一遍文件，断言载荷里的 frames/spec
与文件逐字节一致。
"""

import json
import os
import sys

BACKEND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")
sys.path.insert(0, BACKEND)

from services.exercise_quality import (  # noqa: E402
    ACTIVITY_IDLE_MAX,
    ACTIVITY_ONSET,
    CYCLE_TROUGH_RATIO,
    DEFAULT_MIN_CYCLES,
    GRADE_COMPLETED,
    GRADE_IDLE,
    GRADE_INSUFFICIENT,
    HINT_AMPLITUDE,
    HINT_COMPLETED,
    HINT_CYCLES,
    HINT_HOLD,
    HINT_IDLE,
    HOLD_TARGET_RATIO,
    KIND_CYCLIC,
    KIND_HOLD,
    MAX_FRAME_GAP_MS,
    judge_exercise,
)
from services.scorer import EXERCISE_ACTIVITY_START  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES_DIR = os.path.join(HERE, "samples")

# 样本文件顺序也是断言的一部分：守卫会要求这三段给出三种**互不相同**的结论。
SAMPLE_FILES = [
    "exercise-neck-left-flex.json",
    "exercise-sit-still.json",
    "exercise-too-shallow.json",
]


def frame(t, head, shoulder=0.0, spine=0.0):
    """默认把肩 / 脊柱设为 0（完全端正），这样活动量就**只由 head 决定** ——
    否则 4.0/10 = 0.4 的脊柱底线会盖过想在头部通道上测的那些边界。"""
    return {"t": t, "head_angle": head, "shoulder_diff": shoulder, "spine_angle": spine}


def grid(values, step=500, start=0):
    """把一串 head 值铺成等间隔帧序列。"""
    return [frame(start + i * step, v) for i, v in enumerate(values)]


def build_cases():
    cases = []

    def add(name, frames, spec, note=""):
        cases.append({
            "name": name,
            "note": note,
            "frames": frames,
            "spec": spec,
            "expected": judge_exercise(frames, spec),
        })

    hold = {"kind": KIND_HOLD, "duration_ms": 12000, "min_cycles": 0}
    cyclic3 = {"kind": KIND_CYCLIC, "duration_ms": 3000, "min_cycles": 3}

    # ---- 退化输入 ----
    add("空序列·保持类", [], hold, "一帧都没有 → 只能按「没动」处理，不能假装完成")
    add("空序列·往复类", [], cyclic3)
    add("单帧·幅度到位", [frame(0, 10.0)], hold, "单帧没有区间 → 保持时长为 0")
    add("单帧·幅度不足", [frame(0, 3.0)], hold)
    add("单帧·完全静止", [frame(0, 0.5, 0.4, 1.0)], hold)
    add("缺省 spec", grid([10.0] * 5), {}, "不传 spec 时按保持类、标称时长 0 处理")

    # ---- 幅度三段的边界 ----
    # 每帧活动量都过 round_1，所以「峰值恰好 0.25」不可达（0.25 落在两个可表示值之间）：
    #   0.25 → round_1 → 0.2（平局取偶）→ < ACTIVITY_IDLE_MAX → idle
    # 换言之有效边界是「取整后 ≤ 0.2 → idle，≥ 0.3 → 不算 idle」。
    add("边界·取整后 0.2 即 idle 线之下", grid([1.0] * 25), hold, "0.2 < 0.25")
    add("边界·取整后 0.3 已越过 idle 线", grid([1.5] * 25), hold, "0.3 > 0.25 → 判幅度不足")
    # 有效活动起点（onset）：raw 0.998 会被 round_1 抬到 1.0，因此按「已达起点」处理
    # —— 这正是 S1 那条「显示的数字与判定必须同源」的延续。
    add("边界·raw 0.998 取整成 1.0（记为已达起点）", grid([4.99] * 25), hold)
    add("边界·raw 0.94 取整成 0.9（未达起点）", grid([4.7] * 25), hold)
    add("边界·活动量恰等于 onset（含）", grid([5.0] * 25), hold, ">= 判定，恰好 1.0 要计入")

    # ---- 保持比例 ----
    # ⚠️ 保持比例的分母是**标称时长**，分子是「达标区间的左黎曼和」。
    # 要让比例恰好落在某个值上，必须数清楚"有几个 500ms 区间达标"：
    #   grid 铺 500ms/帧，第 i 帧的区间 = [t_i, t_{i+1})，因此 k 帧连续达标 = k 个区间。
    add(
        "保持比例·恰好 0.6（达标）",
        grid([10.0] * 12 + [0.0] * 9),
        {"kind": KIND_HOLD, "duration_ms": 10000, "min_cycles": 0},
        "12 个区间 × 500ms = 6000ms / 10000ms = 0.6，恰好压在线上",
    )
    add(
        "保持比例·0.5（未达标）",
        grid([10.0] * 10 + [0.0] * 11),
        {"kind": KIND_HOLD, "duration_ms": 10000, "min_cycles": 0},
    )
    add(
        "比例·超过 1 时钳到 1",
        grid([10.0] * 45),
        hold,
        "采样跨度 22s > 标称 12s，比例会 >1，钳到 1 避免显示 183%",
    )
    add("保持比例·duration 为 0", grid([10.0] * 5), {"kind": KIND_HOLD, "duration_ms": 0, "min_cycles": 0})

    # ---- 数据中断（掉帧 / 走出画面）----
    # 两组帧的 head 完全相同，唯一差别是间隔：1000ms 计入、2000ms 不计入。
    # 守卫会硬断言两者的 held_ms 差出整数倍，证明「中断不算保持得好」真的生效。
    add("中断·间隔 1000ms（计入）", [frame(t, 10.0) for t in (0, 1000, 2000, 3000)], hold)
    add("中断·间隔 2000ms（不计入）", [frame(t, 10.0) for t in (0, 2000, 4000, 6000)], hold)
    # 非正间隔必须被排除（同一时间戳可能出现于补帧/重放）
    add("异常·重复时间戳", [frame(0, 10.0), frame(0, 10.0), frame(500, 10.0), frame(500, 10.0), frame(1000, 10.0)], hold)

    # ---- 往复计数（带滞回）----
    add("往复·恰好 3 次循环", grid([1.0, 10.0, 1.0, 10.0, 1.0, 10.0, 1.0]), cyclic3, "往复类不看保持比例")
    add("往复·只做了 2 次", grid([1.0, 10.0, 1.0, 10.0, 1.0]), cyclic3)
    add("往复·在起点附近抖动（滞回防重复计数）", grid([5.0, 6.0, 5.0, 7.0, 5.0]), {"kind": KIND_CYCLIC, "duration_ms": 3000, "min_cycles": 1})
    add("往复·恰好回落到 trough（算一次归位）", grid([2.0, 10.0, 2.0]), {"kind": KIND_CYCLIC, "duration_ms": 3000, "min_cycles": 1})
    add("往复·回落到 trough 之上（不算归位）", grid([2.5, 10.0, 2.5]), {"kind": KIND_CYCLIC, "duration_ms": 3000, "min_cycles": 1})

    # ---- 取整平局点：把 pyRound1 与 Math.round 拉到不同答案 ----
    # 逐帧活动量 raw = 1.25（→×10 = 12.5）：本项目口径取偶得 1.2，Math.round 得 1.3。
    # raw = 0.25（→2.5）更狠：本项目得 0.2（idle），Math.round 得 0.3（幅度不足）——
    # 连**结论**都会不同。
    # 没有这类用例，「逐帧取整被换成 Math.round」这件事守卫是发现不了的。
    add("取整平局点·逐帧 raw 0.25（结论也会不同）", grid([1.25] * 25), hold)
    add("取整平局点·逐帧 raw 0.75", grid([3.75] * 25), hold)
    add("取整平局点·逐帧 raw 1.25", grid([6.25] * 25), hold)
    # 保持比例 raw = 0.25（2.5）：本项目得 0.2，Math.round 得 0.3
    add(
        "取整平局点·保持比例 0.25",
        [frame(t, 10.0) for t in (0, 500, 1000, 1500)] + [frame(t, 0.0) for t in (2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500, 6000, 6500, 7000, 7500, 8000)],
        {"kind": KIND_HOLD, "duration_ms": 8000, "min_cycles": 0},
        "4 个区间 × 500ms = 2000ms / 8000ms = 0.25",
    )

    # ---- 浮点长链 ----
    add("多小数位序列", grid([3.33, 2.77, 4.44, 3.11, 5.55, 4.55, 2.22, 1.99] * 3), hold)
    add("长序列（45 帧）", grid([4.05] * 45), hold)

    return cases


def load_samples():
    """读取样本文件 —— 与守卫脚本读的是同一批文件（防载荷与文件漂移）。"""
    out = []
    for filename in SAMPLE_FILES:
        path = os.path.join(SAMPLES_DIR, filename)
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
        verdict = judge_exercise(raw["frames"], raw["spec"])
        # 文件里声明的 expected_grade 必须与真实判定一致，否则是"样本自己写错了"
        if raw["expected_grade"] != verdict["grade"]:
            raise SystemExit(
                f"✗ 样本 {filename} 声明的 expected_grade={raw['expected_grade']} "
                f"与实际判定 {verdict['grade']} 不一致"
            )
        out.append({
            "name": raw["name"],
            "source_file": f"samples/{filename}",
            "description": raw["description"],
            "expected_grade": raw["expected_grade"],
            "frames": raw["frames"],
            "spec": raw["spec"],
            "expected": verdict,
        })
    return out


def main():
    samples = load_samples()
    payload = {
        "constants": {
            # 判定阈值
            "ACTIVITY_IDLE_MAX": ACTIVITY_IDLE_MAX,
            "ACTIVITY_ONSET": ACTIVITY_ONSET,
            "HOLD_TARGET_RATIO": HOLD_TARGET_RATIO,
            "CYCLE_TROUGH_RATIO": CYCLE_TROUGH_RATIO,
            "DEFAULT_MIN_CYCLES": DEFAULT_MIN_CYCLES,
            "MAX_FRAME_GAP_MS": MAX_FRAME_GAP_MS,
            # 结论 / 类型
            "GRADE_COMPLETED": GRADE_COMPLETED,
            "GRADE_INSUFFICIENT": GRADE_INSUFFICIENT,
            "GRADE_IDLE": GRADE_IDLE,
            "KIND_HOLD": KIND_HOLD,
            "KIND_CYCLIC": KIND_CYCLIC,
            # 引导文案（措辞也钉住，防止两端给用户的说法不一致）
            "HINT_IDLE": HINT_IDLE,
            "HINT_AMPLITUDE": HINT_AMPLITUDE,
            "HINT_HOLD": HINT_HOLD,
            "HINT_CYCLES": HINT_CYCLES,
            "HINT_COMPLETED": HINT_COMPLETED,
            # 与运动态评分共用的那个量：守卫要断言它与 S1 的起点是同一个值
            "EXERCISE_ACTIVITY_START": EXERCISE_ACTIVITY_START,
        },
        # 样本文件清单（守卫据此按同一顺序回放）
        "sample_files": SAMPLE_FILES,
        "samples": samples,
        "cases": build_cases(),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
