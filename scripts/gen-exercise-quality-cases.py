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
    SCORE_WEIGHT_AMPLITUDE,
    SCORE_WEIGHT_EFFORT,
    UNMET_MAX_SCORE,
    judge_exercise,
    score_exercise,
    serialize_action_scores,
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


def build_score_cases():
    """动作分（单动作成绩）的边界用例。

    为什么**直接构造 verdict** 而不是铺帧序列：这一层测的是"给定判定结果，分数是多少"，
    而"幅度恰好等于达标线 1.0""保持比例恰好 0.6"这类点，在帧序列上要靠数区间长度
    凑出来（见上面 build_cases 里那些注释），既脆又难读。上游判定本身已由帧序列用例覆盖，
    这里补的是分数层自己的边界。

    守卫会把每条 ``expected_score`` 与前端 `scoreExercise()` 的结果逐条比对，
    并额外断言那条核心不变量（见 `verify-exercise-quality.mjs` 的 h 段）。
    """
    hold = {"kind": KIND_HOLD, "duration_ms": 12000, "min_cycles": 0}
    cyclic3 = {"kind": KIND_CYCLIC, "duration_ms": 3000, "min_cycles": 3}

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
    - **空列 / 边界分（0 与 100）**：`{"v":1,"items":[]}` 与 0 分是两件事，形态必须钉住。
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
        # 样本文件清单（守卫据此按同一顺序回放）
        "sample_files": SAMPLE_FILES,
        "samples": samples,
        "cases": build_cases(),
        # 动作分（单动作成绩）边界：直接构造 verdict，打"恰好压线"这类点
        "score_cases": build_score_cases(),
        # 逐动作明细的**规范文本**：两端必须逐字节相同（导出/导入只搬运不重算）
        "action_scores_cases": build_action_scores_cases(),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
