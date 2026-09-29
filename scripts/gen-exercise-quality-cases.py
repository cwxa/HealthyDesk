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
    ACTION_SCORES_LEGACY_VERSIONS,
    ACTION_SCORES_VERSION,
    ACTIVITY_IDLE_MAX,
    ACTIVITY_ONSET,
    CYCLE_TROUGH_RATIO,
    DEFAULT_MIN_CYCLES,
    EXERCISE_PASS_SCORE,
    GRADE_COMPLETED,
    GRADE_IDLE,
    GRADE_INSUFFICIENT,
    HINT_AMPLITUDE,
    HINT_COMPLETED,
    HINT_CYCLES,
    HINT_HOLD,
    HINT_IDLE,
    HOLD_TARGET_RATIO,
    IDLE_SCORE,
    KIND_CYCLIC,
    KIND_HOLD,
    MAX_FRAME_GAP_MS,
    METRIC_ANY,
    METRIC_FIELD,
    METRIC_HEAD,
    METRIC_SHOULDER,
    METRIC_SPINE,
    METRIC_THRESHOLD,
    MIN_POSE_MS,
    SCORE_WEIGHT_AMPLITUDE,
    SCORE_WEIGHT_EFFORT,
    UNMET_MAX_SCORE,
    judge_exercise,
    score_exercise,
    serialize_action_scores,
    session_score_of,
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
    """默认把肩 / 脊柱设为 0（完全端正），这样 head 通道上的用例就**只由 head 决定** ——
    否则 4.0/10 = 0.4 的脊柱底线会盖过想在头部通道上测的那些边界。"""
    return {"t": t, "head_angle": head, "shoulder_diff": shoulder, "spine_angle": spine}


def grid(values, step=500, start=0):
    """把一串 head 值铺成等间隔帧序列。"""
    return [frame(start + i * step, v) for i, v in enumerate(values)]


def swing(values, step=500, start=0):
    """**基线帧 + 摆动序列**：第一帧是"中立位"（head=0），之后按 values 铺开。

    🔴 v1.7.0 起「幅度」是**活动范围**（`max − min`），所以每条与幅度有关的用例
    都必须显式给出"从哪动到哪"。常量序列的范围是 0 —— 那等于**没动**，
    守卫会把它判成 idle。这正是"改口径要连用例一起改"的原因：
    旧用例里大量 `grid([10.0] * n)` 在旧口径下是"幅度 2.0"，在新口径下是"一动不动"。
    """
    return grid([0.0] + list(values), step=step, start=start)


def build_cases():
    cases = []

    def add(name, frames, spec, note=""):
        verdict = judge_exercise(frames, spec)
        cases.append({
            "name": name,
            "note": note,
            "frames": frames,
            "spec": spec,
            "expected": verdict,
            # 动作分与判定**同源**：同一份 verdict、同一个 spec 算出来。
            # 每条用例因此同时覆盖「判定」与「成绩」两层 —— 只覆盖判定会漏掉
            # 那种"结论对、分数算错"的改动。
            "expected_score": score_exercise(verdict, spec),
        })

    hold = {"kind": KIND_HOLD, "duration_ms": 12000, "min_cycles": 0, "metric": METRIC_HEAD}
    cyclic3 = {"kind": KIND_CYCLIC, "duration_ms": 3000, "min_cycles": 3, "metric": METRIC_HEAD}

    # ---- 退化输入 ----
    add("空序列·保持类", [], hold, "一帧都没有 → 只能按「没动」处理，不能假装完成")
    add("空序列·往复类", [], cyclic3)
    add(
        "单帧·无区间可算（范围 = 0）",
        [frame(0, 10.0)],
        hold,
        "单帧算不出范围 → 与「一帧都没有」同样按没动处理。"
        "⚠️ **不许**退回「用这一帧的绝对偏离顶上」—— 那等于在角落里把刚修掉的缺陷放回来",
    )
    add("单帧·完全静止", [frame(0, 0.5, 0.4, 1.0)], hold)
    add("缺省 spec", swing([10.0] * 4), {}, "不传 spec 时按保持类、标称时长 0、metric=any 处理")

    # ---- 幅度三段的边界（head 阈值 5.0°，所以范围 1.0 ⇒ 活动量 0.2）----
    # 每帧活动量都过 round_1，所以「峰值恰好 0.25」不可达（0.25 落在两个可表示值之间）：
    #   0.25 → round_1 → 0.2（平局取偶）→ < ACTIVITY_IDLE_MAX → idle
    # 换言之有效边界是「取整后 ≤ 0.2 → idle，≥ 0.3 → 不算 idle」。
    add("边界·取整后 0.2 即 idle 线之下", swing([1.0] * 24), hold, "范围 1.0° → 0.2 < 0.25")
    add("边界·取整后 0.3 已越过 idle 线", swing([1.5] * 24), hold, "范围 1.5° → 0.3 > 0.25 → 判幅度不足")
    # 有效活动起点（onset）：raw 0.998 会被 round_1 抬到 1.0，因此按「已达起点」处理
    # —— 这正是 S1 那条「显示的数字与判定必须同源」的延续。
    add("边界·raw 0.998 取整成 1.0（记为已达起点）", swing([4.99] * 24), hold)
    add("边界·raw 0.94 取整成 0.9（未达起点）", swing([4.7] * 24), hold)
    add("边界·活动量恰等于 onset（含）", swing([5.0] * 24), hold, ">= 判定，恰好 1.0 要计入")

    # ---- 保持比例 ----
    # ⚠️ 保持比例的分母是**标称时长**，分子是「达标区间的左黎曼和」。
    # 要让比例恰好落在某个值上，必须数清楚"有几个 500ms 区间达标"：
    #   swing 的第 0 帧是基线（一定低于 onset），所以达标区间从下标 1 开始数。
    add(
        "保持比例·恰好 0.6（达标）",
        swing([10.0] * 12 + [0.0] * 9),
        {"kind": KIND_HOLD, "duration_ms": 10000, "min_cycles": 0, "metric": METRIC_HEAD},
        "12 个区间 × 500ms = 6000ms / 10000ms = 0.6，恰好压在线上",
    )
    add(
        "保持比例·0.5（未达标）",
        swing([10.0] * 10 + [0.0] * 11),
        {"kind": KIND_HOLD, "duration_ms": 10000, "min_cycles": 0, "metric": METRIC_HEAD},
    )
    add(
        "比例·超过 1 时钳到 1",
        swing([10.0] * 44),
        hold,
        "采样跨度 23s > 标称 12s，比例会 >1，钳到 1 避免显示 183%",
    )
    add(
        "保持比例·duration 为 0",
        swing([10.0] * 4),
        {"kind": KIND_HOLD, "duration_ms": 0, "min_cycles": 0, "metric": METRIC_HEAD},
    )

    # ---- 数据中断（掉帧 / 走出画面）----
    # 两组帧的 head 完全相同，唯一差别是间隔：1000ms 计入、2000ms 不计入。
    # 守卫会硬断言两者的 held_ms 差出整数倍，证明「中断不算保持得好」真的生效。
    # ⚠️ 两组都必须带一帧基线（head=0），否则"范围 = 0"会把用例退化成 idle，
    #    断言就变成"两个 0 相等"这种永远成立的废话。
    add("中断·间隔 1000ms（计入）", [frame(t, 0.0 if i == 0 else 10.0) for i, t in enumerate((0, 1000, 2000, 3000))], hold)
    add("中断·间隔 2000ms（不计入）", [frame(t, 0.0 if i == 0 else 10.0) for i, t in enumerate((0, 2000, 4000, 6000))], hold)
    # 非正间隔必须被排除（同一时间戳可能出现于补帧/重放）
    add(
        "异常·重复时间戳",
        [frame(0, 0.0), frame(0, 10.0), frame(500, 10.0), frame(500, 10.0), frame(1000, 10.0)],
        hold,
    )

    # ---- 往复计数（带滞回）----
    # 滞回的两个阈值都相对**基线**（范围 0 处）而言：升到 onset 才算「到位」，
    # 回落到 trough（= 0.4 × onset）才算「归位」。
    add("往复·恰好 3 次循环", grid([1.0, 10.0, 1.0, 10.0, 1.0, 10.0, 1.0]), cyclic3, "往复类不看保持比例")
    add("往复·只做了 2 次", grid([1.0, 10.0, 1.0, 10.0, 1.0]), cyclic3)
    add(
        "往复·在起点附近抖动（滞回防重复计数）",
        grid([0.0, 10.0, 6.0, 10.0, 6.0]),
        {"kind": KIND_CYCLIC, "duration_ms": 3000, "min_cycles": 1, "metric": METRIC_HEAD},
        "上升后一直停在 onset 之上（活动量 1.2 > 1.0），没有归位 → 不得计成多次循环",
    )
    add(
        "往复·恰好回落到 trough（算一次归位）",
        grid([0.0, 10.0, 2.0, 10.0, 6.0]),
        {"kind": KIND_CYCLIC, "duration_ms": 3000, "min_cycles": 1, "metric": METRIC_HEAD},
        "trough = 0.4 × onset：回落恰好落在 0.4 上要算一次归位",
    )
    add(
        "往复·回落到 trough 之上（不算归位）",
        grid([2.5, 10.0, 6.0, 10.0]),
        {"kind": KIND_CYCLIC, "duration_ms": 3000, "min_cycles": 1, "metric": METRIC_HEAD},
        "最低只回到活动量 0.7（> 0.4）→ 一次都没归位",
    )

    # ---- metric：只看这个动作针对的量（v1.7.0 的核心）----
    # 同一串帧、只换 metric，必须给出**不同**结论 —— 这一组就是"评分有没有看错部位"
    # 的可证伪证据。帧序列：头一动不动（恒 1.0°），肩高差从 0% 摆到 12%。
    only_shoulder_moves = [frame(0, 1.0, 0.0)] + [frame(500 + i * 500, 1.0, 12.0) for i in range(23)]
    add(
        "metric·head：肩高差再大也不算头部动作",
        only_shoulder_moves,
        {"kind": KIND_HOLD, "duration_ms": 12000, "min_cycles": 0, "metric": METRIC_HEAD},
        "旧口径（三项取最大）会把肩高差当成「头部侧屈的幅度」→ 判完成；新口径必须判没动",
    )
    add(
        "metric·shoulder：同一串帧换看肩部就是真动作",
        only_shoulder_moves,
        {"kind": KIND_HOLD, "duration_ms": 12000, "min_cycles": 0, "metric": METRIC_SHOULDER},
        "范围 12% > 阈值 4% → 幅度 3.0，且保持到位",
    )
    add(
        "metric·any：兜底口径下取活动范围最大的那一个量",
        only_shoulder_moves,
        {"kind": KIND_HOLD, "duration_ms": 12000, "min_cycles": 0, "metric": METRIC_ANY},
        "与 metric=shoulder 同结论（head 没动，肩部动了）",
    )
    add(
        "metric·非法值回落 any",
        only_shoulder_moves,
        {"kind": KIND_HOLD, "duration_ms": 12000, "min_cycles": 0, "metric": "elbow"},
        "未知 metric 不许「猜一个维度」，回落 any（只会更宽容，不会看错部位）",
    )
    # 脊柱通道：基线本来就歪的人，只要不动，范围仍是 0
    tilted_still = [frame(i * 500, 1.0, 1.0, 12.0) for i in range(24)]
    add(
        "metric·spine：基线歪 12° 但全程不动 → 没动",
        tilted_still,
        {"kind": KIND_HOLD, "duration_ms": 12000, "min_cycles": 0, "metric": METRIC_SPINE},
        "旧口径下这就是 82 分（姿势越差越容易「自动过关」）；新口径必须 0 分",
    )

    # ---- v1.7.1 时间支撑（第三次返工）：极值必须被**时间**支撑 ----
    # v1.7.0 修的是「减谁」（活动范围 vs 绝对偏离），这一轮修的是「减的东西算不算数」。
    # 病因：`min`（基线）由**单帧**决定，所以一次抖动（含跟踪失败返回 0.0）就能偷走它 ——
    # 整段其余帧的活动量随即全部 ≥ onset ⇒「12 秒一动不动」被判成「保持到位」（实测 82 分）。
    # 往复计数是同一扇门的另一边：`cycles` 只要「某帧 ≥ onset、随后某帧 ≤ trough」，
    # 于是 3 处单帧跳变 = 3 次环绕（实测 84 分）。
    #
    # 🔴 下面第一、二条**帧值逐位相同、只有采样间隔不同**，结论必须相反：
    #    50ms 采样 ⇒ 一帧只占 50ms ⇒ 不构成「一个位」⇒ 没动；
    #    500ms 采样 ⇒ 那一帧本身就代表 500ms ⇒ 是名副其实的一次偏离 ⇒ 算数。
    #    这一对同时钉住了「判据是到下一段的时间，而不是段内首尾差」
    #    和「时间门不是无脑钳掉所有孤立极值」。
    shake = [6.0] * 12 + [0.0] + [6.0] * 11  # 24 帧
    add(
        "时间支撑·密集帧(50ms)孤立单帧抖动 → 偷不走基线",
        grid(shake, step=50),
        {"kind": KIND_HOLD, "duration_ms": 1200, "min_cycles": 0, "metric": METRIC_HEAD},
        "旧口径下 base 被那一帧偷走 → 整段判 completed、82 分。"
        "⚠️ 这一帧只占 50ms，不构成「一个位」",
    )
    add(
        "时间支撑·同样帧值但稀疏采样(500ms) → 那一帧就是 500ms，必须仍算数",
        grid(shake, step=500),
        {"kind": KIND_HOLD, "duration_ms": 12000, "min_cycles": 0, "metric": METRIC_HEAD},
        "与上一条 frames 逐位相同、只有 t 不同。稀疏采样下一帧代表的时间 ≥ MIN_POSE_MS ⇒ "
        "永远不会出现短命段（这也是旧样本/旧用例逐位不变的原因）",
    )
    add(
        "时间支撑·密集帧(50ms)连续两帧抖动 → 一样偷不走",
        grid([6.0] * 12 + [0.0, 0.0] + [6.0] * 10, step=50),
        {"kind": KIND_HOLD, "duration_ms": 1200, "min_cycles": 0, "metric": METRIC_HEAD},
        "判据是「到下一段首帧的时间」，不是「恰好一帧」⇒ 连续两帧（共 100ms）同样拦得住",
    )
    add(
        "时间支撑·往复类密集帧单帧跳变 → 凑不出循环次数",
        grid([0.5] * 8 + [9.0] + [0.5] * 6 + [9.0] + [0.5] * 6 + [9.0] + [0.5], step=50),
        {"kind": KIND_CYCLIC, "duration_ms": 1200, "min_cycles": 3, "metric": METRIC_HEAD},
        "同一扇门的另一边：旧口径下 3 处单帧跳变 = cycles 3 → 判完成、84 分。"
        "修掉后 range 归零 ⇒ 全程没动",
    )

    # 修法不能被误伤：真实动作的每一「位」都站得够久，必须照常判完成。
    add(
        "时间支撑·密集帧真实保持动作（每段 ≥ 2s）不被误伤",
        grid([0.0] * 8 + [8.0] * 40 + [0.0] * 8, step=50),
        {"kind": KIND_HOLD, "duration_ms": 3000, "min_cycles": 0, "metric": METRIC_HEAD},
        "起势 / 保持 / 回位三段都够长 ⇒ 幅度 1.6、保持 2s/3s ⇒ 判完成（时间门只削短命段）",
    )
    add(
        "时间支撑·往复类密集帧真实环绕（每段 1s）不被误伤",
        grid([0.0] * 4 + [8.0] * 20 + [0.0] * 4 + [8.0] * 20 + [0.0] * 4 + [8.0] * 20 + [0.0] * 4, step=50),
        {"kind": KIND_CYCLIC, "duration_ms": 4000, "min_cycles": 3, "metric": METRIC_HEAD},
        "每个「位」占 1s（> MIN_POSE_MS）⇒ 全部被支撑 ⇒ 三次环绕照常计满",
    )

    # ---- 取整平局点：把 pyRound1 与 Math.round 拉到不同答案 ----
    # 逐帧活动量 raw = 1.25（→×10 = 12.5）：本项目口径取偶得 1.2，Math.round 得 1.3。
    # raw = 0.25（→2.5）更狠：本项目得 0.2（idle），Math.round 得 0.3（幅度不足）——
    # 连**结论**都会不同。
    # 没有这类用例，「逐帧取整被换成 Math.round」这件事守卫是发现不了的。
    add("取整平局点·逐帧 raw 0.25（结论也会不同）", swing([1.25] * 24), hold)
    add("取整平局点·逐帧 raw 0.75", swing([3.75] * 24), hold)
    add("取整平局点·逐帧 raw 1.25", swing([6.25] * 24), hold)
    # 保持比例 raw = 0.25（2.5）：本项目得 0.2，Math.round 得 0.3
    add(
        "取整平局点·保持比例 0.25",
        swing([10.0] * 4 + [0.0] * 17),
        {"kind": KIND_HOLD, "duration_ms": 8000, "min_cycles": 0, "metric": METRIC_HEAD},
        "4 个区间 × 500ms = 2000ms / 8000ms = 0.25",
    )

    # ---- 浮点长链 ----
    add("多小数位序列", swing([3.33, 2.77, 4.44, 3.11, 5.55, 4.55, 2.22, 1.99] * 3), hold)
    add("长序列（46 帧）", swing([4.05] * 45), hold)

    return cases


def build_score_cases():
    """动作分（单动作成绩）的边界用例。

    为什么**直接构造 verdict** 而不是铺帧序列：这一层测的是"给定判定结果，分数是多少"，
    而"幅度恰好等于达标线 1.0""保持比例恰好 0.6"这类点，在帧序列上要靠数区间长度
    凑出来（见上面 build_cases 里那些注释），既脆又难读。上游判定本身已由帧序列用例覆盖，
    这里补的是分数层自己的边界。

    守卫会把每条 ``expected_score`` 与前端 `scoreExercise()` 的结果逐条比对，
    并额外断言那条核心不变量（见 `verify-exercise-quality.mjs` 的 h 段）。
    """
    hold = {"kind": KIND_HOLD, "duration_ms": 12000, "min_cycles": 0, "metric": METRIC_HEAD}
    cyclic3 = {"kind": KIND_CYCLIC, "duration_ms": 3000, "min_cycles": 3, "metric": METRIC_HEAD}

    def verdict(grade, peak, hold_ratio=0.0, cycles=0):
        return {
            "grade": grade,
            "hint": "",
            "peak_activity": peak,
            "held_ms": 0,
            "hold_ratio": hold_ratio,
            "cycles": cycles,
        }

    cases = []

    def add(name, grade, peak, spec, hold_ratio=0.0, cycles=0, note=""):
        v = verdict(grade, peak, hold_ratio, cycles)
        cases.append({
            "name": name,
            "note": note,
            "verdict": v,
            "spec": spec,
            "expected_score": score_exercise(v, spec),
        })

    # ---- 达标线两侧：分数与判定必须同向（这条不变量是本函数的全部意义）----
    add(
        "压线·幅度恰好达标 + 保持恰好达标 → 恰好是达标分",
        GRADE_COMPLETED, EXERCISE_ACTIVITY_START, hold,
        hold_ratio=HOLD_TARGET_RATIO,
        note="0.5×60 + 0.5×100 = 80，恰好压在线上而不是 79 或 81",
    )
    add("线上·幅度 1.5 倍阈值", GRADE_COMPLETED, 1.5, hold, hold_ratio=HOLD_TARGET_RATIO)
    add("线上·幅度满分 + 保持满分 → 100", GRADE_COMPLETED, 4.0, hold, hold_ratio=1.0)

    # ---- 未达标必须低于达标分，哪怕幅度满分 ----
    # 幅度满分但一点没保持：按公式 50 分，本来就在线下，钳位不介入。
    add("线下·幅度满分但保持 0", GRADE_INSUFFICIENT, 4.0, hold, hold_ratio=0.0)
    # 幅度满分、保持 0.59（只差一点点）：按公式约 99 分 → **必须**被钳到线下，
    # 否则界面会一边说「保持住，别急着放下」一边给 99 分。
    add(
        "线下·幅度满分 + 保持 0.59（只差一步）→ 钳位生效",
        GRADE_INSUFFICIENT, 4.0, hold, hold_ratio=round(HOLD_TARGET_RATIO - 0.01, 2),
        note="这条专门证明「未达标 ⇒ 不到达标分」是靠钳位保证的",
    )
    add("线下·保持 0.5", GRADE_INSUFFICIENT, 4.0, hold, hold_ratio=0.5)
    add("线下·幅度不足（未达起点）", GRADE_INSUFFICIENT, 0.5, hold)
    add("线下·幅度只有 idle 线附近但不判 idle", GRADE_INSUFFICIENT, ACTIVITY_IDLE_MAX, hold)

    # ---- 没动就是 0 ----
    add("没动·idle → 0 分", GRADE_IDLE, ACTIVITY_IDLE_MAX, hold)
    add("没动·idle 但峰值很高（判定与分数必须同源，不看峰值）", GRADE_IDLE, 4.0, hold)

    # ---- 往复类：次数替代保持比例 ----
    add(
        "往复·压线幅度 + 次数恰好达标 → 恰好是达标分",
        GRADE_COMPLETED, EXERCISE_ACTIVITY_START, cyclic3, hold_ratio=0.9, cycles=3,
        note="往复类不看保持比例：hold_ratio 给 0.9 也不影响",
    )
    add("往复·次数 2/3 → 钳位生效", GRADE_INSUFFICIENT, 4.0, cyclic3, hold_ratio=0.9, cycles=2)
    add("往复·次数超额", GRADE_COMPLETED, 4.0, cyclic3, hold_ratio=0.9, cycles=9)

    # ---- 防御性分支：不要求计次的往复配置 ----
    # 动作库里往复类都是 3，这条配置实际不可达；但"不可达"不是不测的理由：
    # 若退回 `cycles / max(1, min_cycles)`，判定为完成（cycles >= 0 恒真）却只有 50 分，
    # 核心不变量当场被打破 —— 这条用例就是钉住它的。
    add(
        "往复·min_cycles=0（不要求计次）→ 完成即达标，不因次数扣分",
        GRADE_COMPLETED, 4.0, {"kind": KIND_CYCLIC, "duration_ms": 3000, "min_cycles": 0}, cycles=0,
    )

    return cases


def build_action_scores_cases():
    """逐动作明细的**规范文本**用例：两端必须给出逐字节相同的字符串。

    为什么值得单独立一组用例：这一列在导出/导入里是**不透明文本**，导入端**不重新
    序列化**（那样"导出→导入→再导出是同一个文件"就不再由构造保证）。于是"两端写出来
    的字节一样"就成了一条**只在这里**能被证明的硬约束 —— 一旦漂开，两端导出的文件
    互换后不再相等，而这个差异在界面上完全看不出来。

    挑的用例都是"两种语言真会给出不同答案"的地方，不是随便凑数：

    - **非 ASCII 的 id**：Python 的 `json.dumps` **默认** `ensure_ascii=True`，
      会把中文转成 `\\u9888\\u90e8…`，而 JS 的 `JSON.stringify` **不转义**非 ASCII。
      生产里的 id 都是 ASCII slug，所以这个坑只有在"有人给动作库加了个中文 id /
      有人把 id 改成显示名"时才会炸 —— 那时它会先在这里红，而不是在用户互换文件时。
    - **引号与反斜杠**：转义规则两端不同就抓得到。
    - **空列 / 边界分（0 与 100）**：`{"v":3,"items":[]}` 与 0 分是两件事，形态必须钉住。
      ⚠️ 版本号 1 → 2（改成活动范围）→ 3（加时间支撑）**都不是形态变了**，而是**分数口径变了**，
      形态自始至终没变 —— 显示端要靠这个号把老明细标成「旧口径」，并说清是哪一把尺子。
    - **一串完整明细**：钉住项**顺序**不被重排（Python 的 dict 与 JS 的对象都保证插入序，
      但"保证"是要有证据的）。

    返回列表里每项是 `{"name", "items", "expected", "note"}`。
    """
    cases = []

    def add(name, items, note=""):
        cases.append({
            "name": name,
            "items": items,
            "expected": serialize_action_scores(items),
            "note": note,
        })

    add("空明细（本次一个动作都没判出来）", [],
        "与「老记录该列为 NULL」不同 —— 这是「判过了，但一个都没判出来」")
    add("单动作·完成", [{"id": "neck-flex-left", "score": 84, "grade": GRADE_COMPLETED}])
    add("单动作·没动（0 分）", [{"id": "sit-still", "score": IDLE_SCORE, "grade": GRADE_IDLE}],
        "0 分是一个**真结论**，不是缺失")
    add("单动作·满分", [{"id": "neck-flex-right", "score": 100, "grade": GRADE_COMPLETED}])
    add("混合·完成与未到位", [
        {"id": "neck-flex-left", "score": 84, "grade": GRADE_COMPLETED},
        {"id": "shoulder-circles", "score": UNMET_MAX_SCORE, "grade": GRADE_INSUFFICIENT},
    ], "未达标的分数上限 79 与达标线 80 相邻 —— 形态里必须看得出两者不同")
    add("非 ASCII 的 id（钉住 ensure_ascii=False）", [
        {"id": "颈部左侧屈", "score": 84, "grade": GRADE_COMPLETED},
    ], "Python 默认 ensure_ascii=True 会转义成 \\u9888…，JS 不转义 —— 两端会写出不同的字节")
    add("含引号与反斜杠的 id（钉住转义规则）", [
        {"id": 'a"b\\c', "score": 90, "grade": GRADE_COMPLETED},
    ])
    add("一串完整明细（钉住项顺序）", [
        {"id": "neck-flex-left", "score": 92, "grade": GRADE_COMPLETED},
        {"id": "neck-flex-right", "score": 79, "grade": GRADE_INSUFFICIENT},
        {"id": "shoulder-circles", "score": 80, "grade": GRADE_COMPLETED},
        {"id": "chin-tuck", "score": 0, "grade": GRADE_IDLE},
    ], "顺序即动作在库里的顺序，不许被重排（重排会让两端的 diff 无意义）")

    return cases


def build_session_score_cases():
    """整场成绩（`sessionScoreOf`）的用例：真值、取整方向、空明细三态。

    这个数会被**写进 `activity_log.avg_score` 并进导出文件**，所以两端必须给出同一个值。

    这几条不是凑数：
    - **空明细返回 0**（= "没有成绩"），而"真的得 0 分"是可达的（全程没动）——
      两者数值相同、含义不同，靠明细是否为空区分，这里把数值形态钉住。
    - **均值恰好落在 .5 上**：平局取偶（`round_int` / 前端 `pyRound`）与"半向上"
      （JS `Math.round`）在平局点上给不同的数 —— 79.5 与 80.5 两条正好把方向钉死。
      ⚠️ 这也意味着**整场成绩这一层是有平局点的**（动作分那一层没有，见守卫文件头），
      所以"取整实现被换掉"在**这里**抓得到。
    - **单动作**（均值就是它自己）与**含 0 分**（0 不能被当成"缺项"跳过）。
    """
    cases = []

    def add(name, items, note=""):
        cases.append({
            "name": name,
            "items": items,
            "expected": session_score_of(items),
            "note": note,
        })

    add("空明细 → 0（「没有成绩」，不是「得 0 分」）", [],
        "与老记录的 NULL 是第三件事")
    add("单动作", [{"id": "a", "score": 84, "grade": GRADE_COMPLETED}])
    add("3 项·均值 79.33 → 79", [
        {"id": "a", "score": 84, "grade": GRADE_COMPLETED},
        {"id": "b", "score": 79, "grade": GRADE_INSUFFICIENT},
        {"id": "c", "score": 75, "grade": GRADE_INSUFFICIENT},
    ])
    # 4 项和 318 → 79.5，和 322 → 80.5：两个**恰好落在平局点**的均值。
    #
    # 🔴 平局取偶（`round_int` / 前端 `pyRound`）：79.5 → 80（floor 79 是奇数，进到 80）、
    #    80.5 → 80（floor 80 是偶数，不进）。若哪天换成"半向上"（JS `Math.round`），
    #    后者会变成 **81** —— 这两条正好把平局方向钉死。
    #    也就是说：**动作分那一层没有平局点**（见守卫文件头的推导），
    #    但**整场成绩这一层有**，所以"取整实现被偷偷换掉"在这里抓得到。
    add("4 项·均值恰为 79.5（平局取偶：进）", [
        {"id": "a", "score": 80, "grade": GRADE_COMPLETED},
        {"id": "b", "score": 79, "grade": GRADE_INSUFFICIENT},
        {"id": "c", "score": 79, "grade": GRADE_INSUFFICIENT},
        {"id": "d", "score": 80, "grade": GRADE_COMPLETED},
    ], "floor=79 为奇数 → 进到 80")
    add("4 项·均值恰为 80.5（平局取偶：不进）", [
        {"id": "a", "score": 81, "grade": GRADE_COMPLETED},
        {"id": "b", "score": 80, "grade": GRADE_COMPLETED},
        {"id": "c", "score": 80, "grade": GRADE_COMPLETED},
        {"id": "d", "score": 81, "grade": GRADE_COMPLETED},
    ], "floor=80 为偶数 → 不进，仍 80；换成 Math.round 会变成 81")
    add("含 0 分（0 是结论，不是缺项）", [
        {"id": "a", "score": 0, "grade": GRADE_IDLE},
        {"id": "b", "score": 100, "grade": GRADE_COMPLETED},
    ], "均值 50 —— 若把 0 当缺项跳过就会变成 100")

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
            "expected_score": score_exercise(verdict, raw["spec"]),
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
            "MIN_POSE_MS": MIN_POSE_MS,
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
            # 动作分（单动作成绩）—— 分数与判定的绑定关系全靠这几个值
            "SCORE_WEIGHT_AMPLITUDE": SCORE_WEIGHT_AMPLITUDE,
            "SCORE_WEIGHT_EFFORT": SCORE_WEIGHT_EFFORT,
            "EXERCISE_PASS_SCORE": EXERCISE_PASS_SCORE,
            "UNMET_MAX_SCORE": UNMET_MAX_SCORE,
            "IDLE_SCORE": IDLE_SCORE,
            # 逐动作明细文本的格式版本
            "ACTION_SCORES_VERSION": ACTION_SCORES_VERSION,
        },
        # 幅度口径的映射表：守卫会拿前端**运行时的** METRIC_FIELD / METRIC_THRESHOLD 逐键比。
        # 单排在 constants 之外，因为它们是映射（`!==` 比不了），而且这一层最容易"一端改了
        # 另一端没改" —— 而症状是"同一个动作在手机与电脑上看的是不同部位"，非常难查。
        "metrics": {
            "field": METRIC_FIELD,
            "threshold": METRIC_THRESHOLD,
            "names": {
                "head": METRIC_HEAD,
                "shoulder": METRIC_SHOULDER,
                "spine": METRIC_SPINE,
                "any": METRIC_ANY,
            },
        },
        # 明细文本的版本：当前版本 + 仍能解析的历史版本（后者要被标成「旧口径」）
        "action_scores_versions": {
            "current": ACTION_SCORES_VERSION,
            "legacy": list(ACTION_SCORES_LEGACY_VERSIONS),
        },
        # 样本文件清单（守卫据此按同一顺序回放）
        "sample_files": SAMPLE_FILES,
        "samples": samples,
        "cases": build_cases(),
        # 动作分（单动作成绩）边界：直接构造 verdict，打"恰好压线"这类点
        "score_cases": build_score_cases(),
        # 逐动作明细的**规范文本**：两端必须逐字节相同（导出/导入只搬运不重算）
        "action_scores_cases": build_action_scores_cases(),
        # 整场成绩（会被写进 activity_log.avg_score）
        "session_score_cases": build_session_score_cases(),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
