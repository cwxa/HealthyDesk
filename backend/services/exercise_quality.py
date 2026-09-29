"""动作完成度判定 —— 回答「用户到底做了没有 / 做到位没有」。

## 为什么需要它

`NeckActivity` 的活动执行链路此前**只有倒计时**（`setInterval` 递减 `timeLeft`）：
用户从头到尾一动不动，82 秒后系统照样宣布「活动完成!」并记一条记录。
S1 给评分分了静息/运动双通道之后，界面能显示「动作达成度」了，但那仍然是
**逐帧瞬时值** —— 没有任何地方把一串帧折成「这次活动完成得怎么样」。

本模块把那串帧折成**三分类结论**，并把三个可解释的量一并返回：

    peak_activity  峰值活动量（= 活动范围）—— 幅度够不够
    held_ms        达标状态累计时长 —— 保持住了没有
    cycles         往复动作有效循环 —— 次数够不够

## 三分类（不允许第四种状态）

    idle          峰值活动量 < ACTIVITY_IDLE_MAX —— 全程没动
    insufficient  动了，但幅度 / 保持时长 / 次数有一项没达到
    completed     本类型要求的项全部达到

## 口径（单点定义）

- 🔴 **活动量 = 「活动范围」，不是「偏离有多大」**（v1.7.0 改的口径，原因见下一节）：
  取**该动作针对的那个姿态量**（`spec.metric`），算出它在这一段里的
  `最大值 − 最小值`，再除以该量的**静息阈值**（5.0° / 4% / 10.0°）—— 于是
  「活动量 1.0」的含义是**这个部位真的动了整整一个提醒线那么多**。
  除以阈值带来两个好处：与 S1 的阈值体系同源（不另立一套"典型活动幅度"），
  且天生归一化，不受摄像头距离与用户体型影响（正好回应 S2 设计里那条
  「设备差异会显著影响幅度判定」的风险）。
- **为什么不能沿用「绝对偏离」**：静息阈值是**绝对**的（"偏离超过 5° 就该提醒你"），
  直接拿它当动作幅度会同时错两头 —— 实测（`judge_exercise` + `score_exercise`）：
  **一个习惯性脊柱倾斜 12° 的人，全程一动不动会被判「完成」、拿 82 分；
  一个高低肩 6% 的人做「颈部左侧屈」时头完全没动，也能拿 84 分；
  而姿态良好的人同样一动不动只拿 0 分。** 也就是**姿势越差越容易"自动过关"**。
  改口径还有一个必须一起修的点：旧实现**三项取最大值**，于是"肩高差很大"
  可以冒充"头部侧屈的幅度" —— 那等于**这个动作的评分在看别的部位**。
  `metric` 就是为此而生：每个动作只用它自己针对的量打分。
  ⚠️ 改口径的副作用：**动作分数值会变**，历史记录的分数与新记录不可比 ——
  所以 `ACTION_SCORES_VERSION` 从 1 升到 2，显示端会把老明细标成「旧口径」
  （与 v1.6.3 对"没有明细的老记录"的处理同一思路）。
- 每帧活动量先经 `round_1` 再做**一切**比较。这不是美化输出，而是本项目的硬规矩：
  **用户看到的数字与系统判定必须同源**。S1 刚踩过这个坑 —— `raw = 59.94` 取整成
  60（正好是达标线）却提示「幅度不足」，自相矛盾。所以判定用的必须是取整后的值。
- ⚠️ **至少要两帧**才谈得上"范围"：只有一帧时 `max − min = 0`，与"一帧都没有"
  同样按 `idle` 处理。这是口径的直接推论（**不能**退回"用绝对偏离顶上"，
  那等于在角落里把刚修掉的缺陷放回来），且只影响"这一段几乎没有采到数据"的情形。
- `held_ms` = Σ(t[i+1] − t[i])，只累加 `activity[i] >= ACTIVITY_ONSET` 的区间
  （左端点取值，标准左黎曼和）。相邻间隔大于 `MAX_FRAME_GAP_MS` 视为**数据中断**、
  不计入 —— 掉帧或用户走出画面时，不该把那一段空白算成「保持得很好」；
  非正的间隔同样不计入。
- `hold_ratio` = `held_ms / duration_ms`，分母是**标称时长**而不是「实际采集跨度」：
  12 秒的动作就该在 12 秒里保持住，用户中途离开摄像头不能让分母跟着变小。
  结果**钳到 [0, 1]**：采样跨度偶尔会略超过标称时长（计时器与帧率不可能严丝合缝），
  显示成 183% 只会让人困惑。

## 双端一致

前端 `src/platform/exerciseQuality.ts` 是本模块的逐位等价实现，由
`scripts/verify-exercise-quality.mjs` 用 Python 生成的期望值逐条对拍（已挂进
`npm run verify:parity`）。改这里必须同步改前端，否则对拍会红。
"""

import json
import logging

from config import (  # noqa: E402
    HEAD_TILT_THRESHOLD,
    SHOULDER_DIFF_THRESHOLD,
    SPINE_ANGLE_THRESHOLD,
)
from services.rounding import round_1, round_int
from services.scorer import (  # noqa: E402
    EXERCISE_ACTIVITY_START,
    SCORE_MAX,
    exercise_score_from_activity,
)

logger = logging.getLogger("neckguardian.exercise_quality")

# ---- 结论 ----
GRADE_COMPLETED = "completed"
GRADE_INSUFFICIENT = "insufficient"
GRADE_IDLE = "idle"

# ---- 动作类型 ----
KIND_HOLD = "hold"      # 保持类（屈、伸、缩）：看「幅度 + 保持时长」
KIND_CYCLIC = "cyclic"  # 往复类（环绕、扩胸）：看「幅度 + 有效次数」

# ---- 幅度看哪个量（`spec.metric`）----
# 名字与 `src/data/exercises.ts` 的 `ExerciseMetric` 一一对应。
METRIC_HEAD = "head"
METRIC_SHOULDER = "shoulder"
METRIC_SPINE = "spine"
#: 兜底：三个量各自算范围后取最大。**生产路径不应依赖它** —— 每个动作都该声明
#: 自己用哪个量（`exercises.ts :: metric`）。它存在的意义是：万一调用方漏传，
#: 退化成"哪个部位动得最多算哪个"，而不是退回"绝对偏离"那条已知有缺陷的老路。
METRIC_ANY = "any"

#: metric → 姿态帧里的字段名（**运行时值**，进对拍体系；类型在前端运行时不存在）。
METRIC_FIELD = {
    METRIC_HEAD: "head_angle",
    METRIC_SHOULDER: "shoulder_diff",
    METRIC_SPINE: "spine_angle",
}

#: metric → 该量的静息阈值。与 `scorer` 用的是同一批常量（"一个提醒线"只有一处定义）。
METRIC_THRESHOLD = {
    METRIC_HEAD: HEAD_TILT_THRESHOLD,
    METRIC_SHOULDER: SHOULDER_DIFF_THRESHOLD,
    METRIC_SPINE: SPINE_ANGLE_THRESHOLD,
}

# ---- 具名常量（全部进对拍体系，不许散落成魔法数字）----
ACTIVITY_IDLE_MAX = 0.25        # 峰值活动量低于此值 = 全程没动
ACTIVITY_ONSET = EXERCISE_ACTIVITY_START  # 有效活动起点，与运动态评分共用同一取值
HOLD_TARGET_RATIO = 0.6         # 保持类：达标时长占标称时长的比例下限
CYCLE_TROUGH_RATIO = 0.4        # 往复类：回落到 onset 的该比例以下才算「一次归位」
DEFAULT_MIN_CYCLES = 3          # 往复类动作的默认最小有效循环数
MAX_FRAME_GAP_MS = 1500         # 相邻帧间隔超过它 = 数据中断，该段不计入保持时长

# ---- 动作分（单个动作的成绩）----
# 目标只有一个：**分数与判定不许互相打脸**。算法与那条核心不变量见 ``score_exercise()``。
SCORE_WEIGHT_AMPLITUDE = 0.5    # 幅度分量权重
SCORE_WEIGHT_EFFORT = 0.5       # 到位程度分量权重（保持类=保持时长，往复类=次数）
EXERCISE_PASS_SCORE = 80        # 动作分达标线：score >= 它 ⟺ 判定为「完成」
UNMET_MAX_SCORE = 79            # 未达标时的分数上限（有意台阶：未到位就是不到 80）
IDLE_SCORE = 0                  # 全程没动（grade=idle）的成绩：就是 0

# ---- 引导文案（与结论一一对应；措辞本身也进对拍，防止两端说法不一致）----
HINT_IDLE = "没检测到动作，跟着引导慢慢做"
HINT_AMPLITUDE = "幅度还不够，再大一点"
HINT_HOLD = "保持住，别急着放下"
HINT_CYCLES = "再多做几次"
HINT_COMPLETED = "很好，保持住"


def _amplitudes(frames, metric) -> list:
    """逐帧「活动量」= 该动作针对的量 · 相对它在**这一段里的最低位**的偏移 ÷ 该量的静息阈值。

    ## 为什么是"相对最低位"而不是"绝对偏离"

    见模块文档：绝对偏离会把"用户本来就驼背"算成"动作幅度"，于是姿势越差越容易
    自动过关（实测 82 分）。减去本段的最低值之后，这个量衡量的是
    **用户自己动了多少** —— 与他的基线无关。

    ## 为什么"这一段里"的最低值可以被当作基线

    用户在这 10–12 秒里总会有接近自己中立位的时刻（动作起势、换向、回位）。
    取最低位而不是外部传入的基线，一是**纯函数**（不需要额外输入，两端好对拍、
    移动端也不用新采一段静息姿态），二是**不会冤枉正在做动作的人**：
    只要他真的动了，范围就 > 0；而"全程保持不动"与"全程保持在一个拉伸位"
    是不同的两件事——后者依然是"动了"（范围 = 从起势到保持位的距离）。

    ## 取整只有一处

    与旧实现位置相同：先算 raw，最后统一 `round_1` 一次。逐帧取整再比较是本项目
    的硬规矩（用户看到的数字与判定必须同源），但**不能**先把每轴各自取整再取 max ——
    那会与"先取 max 再取整"分叉，多出一个取整点。
    """
    metrics = list(METRIC_FIELD) if metric == METRIC_ANY else [metric]
    series = []
    for m in metrics:
        field = METRIC_FIELD[m]
        thr = float(METRIC_THRESHOLD[m])
        vals = [float(f[field]) for f in frames]
        base = min(vals)
        # `- base` 之后必然 ≥ 0（base 就是最小值），所以不必再 max(0, …)
        series.append([(v - base) / thr for v in vals])
    return [round_1(max(s[i] for s in series)) for i in range(len(frames))]


def judge_exercise(frames, spec=None) -> dict:
    """把一串（已按时间升序的）姿态帧折成完成度结论。

    Args:
        frames: 可迭代对象，每项为 ``{"t": 毫秒, "head_angle": float,
                "shoulder_diff": float, "spine_angle": float}``。
                **没有姿态的帧不应进入序列** —— 缺口会被算到前一帧的区间上，
                因此上游只推入 `type == "pose"` 的帧。
        spec: ``{"kind": "hold" | "cyclic", "duration_ms": 标称时长,
                "metric": 幅度看哪个量（"head" / "shoulder" / "spine" / "any"，
                          见 `METRIC_*`；缺省 `any` 只是兜底，生产路径必须显式给）,
                "min_cycles": 往复类的最小循环数（可选）}``。缺省为保持类、不限时长。

    Returns:
        ``{"grade", "hint", "peak_activity", "held_ms", "hold_ratio", "cycles"}``

    这是**纯函数**：同样输入必然同样输出，因此可以离线回放固定样本
    （见 `scripts/samples/` 与 `scripts/verify-exercise-quality.mjs`）。
    """
    spec = spec or {}
    kind = spec.get("kind") or KIND_HOLD
    metric = spec.get("metric") or METRIC_ANY
    duration_ms = float(spec.get("duration_ms") or 0)
    min_cycles = spec.get("min_cycles")
    if min_cycles is None:
        min_cycles = DEFAULT_MIN_CYCLES if kind == KIND_CYCLIC else 0
    if metric not in METRIC_FIELD and metric != METRIC_ANY:
        # 非法值回落 `any`（比"猜一个维度"安全）：`any` 只会更宽容，不会给出
        # 一个"看错部位"的结论。与 kind 的非法值回落保持类同一思路。
        logger.warning("未知 metric=%r，回落 %s", metric, METRIC_ANY)
        metric = METRIC_ANY

    frames = list(frames)
    if not frames:
        # 一帧都没有 = 完全不知道用户做了什么，只能按"没动"处理（不能假装完成）
        return {
            "grade": GRADE_IDLE,
            "hint": HINT_IDLE,
            "peak_activity": 0.0,
            "held_ms": 0,
            "hold_ratio": 0.0,
            "cycles": 0,
        }

    acts = _amplitudes(frames, metric)
    peak = max(acts)

    held_ms = 0
    for i in range(len(frames) - 1):
        if acts[i] < ACTIVITY_ONSET:
            continue
        gap = frames[i + 1]["t"] - frames[i]["t"]
        if gap <= 0 or gap > MAX_FRAME_GAP_MS:
            continue
        held_ms += gap

    hold_ratio = min(1.0, round_1(held_ms / duration_ms)) if duration_ms > 0 else 0.0

    # 往复计数：带滞回的穿越计数（升到 onset 才算「到位」，回落到 trough 才算「归位」）。
    # 用两个不同的阈值是为了防止在 onset 附近抖动时被反复计数。
    cycles = 0
    hot = False
    trough = ACTIVITY_ONSET * CYCLE_TROUGH_RATIO
    for a in acts:
        if not hot:
            if a >= ACTIVITY_ONSET:
                hot = True
        elif a <= trough:
            cycles += 1
            hot = False

    if peak < ACTIVITY_IDLE_MAX:
        grade, hint = GRADE_IDLE, HINT_IDLE
    elif peak < ACTIVITY_ONSET:
        grade, hint = GRADE_INSUFFICIENT, HINT_AMPLITUDE
    elif kind == KIND_CYCLIC and cycles < min_cycles:
        grade, hint = GRADE_INSUFFICIENT, HINT_CYCLES
    elif kind == KIND_HOLD and hold_ratio < HOLD_TARGET_RATIO:
        grade, hint = GRADE_INSUFFICIENT, HINT_HOLD
    else:
        grade, hint = GRADE_COMPLETED, HINT_COMPLETED

    logger.debug(
        "Exercise quality grade=%s | peak=%.1f(范围) held=%dms ratio=%.1f cycles=%d "
        "(n=%d, kind=%s, metric=%s)",
        grade, peak, held_ms, hold_ratio, cycles, len(frames), kind, metric,
    )
    return {
        "grade": grade,
        "hint": hint,
        "peak_activity": peak,
        "held_ms": held_ms,
        "hold_ratio": hold_ratio,
        "cycles": cycles,
    }


def score_exercise(verdict, spec=None) -> int:
    """单个动作的成绩（0–100）。``judge_exercise()`` 的配套函数。

    ## 怎么算
    动作分 = 幅度分量 × ``SCORE_WEIGHT_AMPLITUDE`` + 到位程度分量 × ``SCORE_WEIGHT_EFFORT``

    - **幅度分量** = ``exercise_score_from_activity(peak_activity)``：与实时运动态评分
      **同一张映射**（达标线 60、活动量 4 倍阈值即满分），所以「实时看着 90 分」与
      「这个动作幅度分 90」说的是同一件事。
      ⚠️ 但两边的**输入**不是同一个量：这里传的是「活动范围」（见 `_amplitudes`），
      实时那一帧传的是「当前偏离」。共用映射是为了让刻度一致，不是为了让数值相等。
    - **到位程度分量**：保持类 = ``min(1, hold_ratio / HOLD_TARGET_RATIO) × 100``；
      往复类 = ``min(1, cycles / min_cycles) × 100``。

    ## 🔴 核心不变量（由构造保证，不是巧合）
    ``score >= EXERCISE_PASS_SCORE`` **⟺** ``grade == "completed"``

    - 判「完成」⇒ 幅度 ≥ 达标线（分量 ≥ 60）且到位程度满分 ⇒ ≥ 0.5*60 + 0.5*100 = **80**；
    - 判「未完成」⇒ 分数被**显式钳到** ``UNMET_MAX_SCORE``。

    后一条是有意为之的**台阶**：幅度很大但没保持住（按公式能算出 99）必须落在 80 以下，
    否则界面会一边说「保持住，别急着放下」一边给 99 分 —— 正是本项目反复修的那类
    「文案与判定互相打脸」。钳位由 ``grade`` 驱动（不重算阈值），因此调用方即便传了与
    判定时不同的 ``spec``，不变量依然成立。

    Args:
        verdict: ``judge_exercise()`` 的返回字典。
        spec: 与判定时**同一个** ``spec``（``kind`` / ``min_cycles``）。

    Returns:
        整数 0–100。摄像头没拍到人时上游根本不判定，本函数不会被调用 —— 那种情况
        必须显示 ``--``，**不许**拿 ``IDLE_SCORE`` 去说"你没做"。
    """
    if verdict.get("grade") == GRADE_IDLE:
        return IDLE_SCORE

    spec = spec or {}
    kind = spec.get("kind") or KIND_HOLD
    min_cycles = spec.get("min_cycles")
    if min_cycles is None:
        min_cycles = DEFAULT_MIN_CYCLES if kind == KIND_CYCLIC else 0

    if kind == KIND_CYCLIC:
        # min_cycles <= 0 = 该配置**不要求计次** → 不因次数扣分。
        # 不能退回 ``cycles / max(1, min_cycles)``：那样「判完成（cycles >= 0 恒真）却只有 50 分」，
        # 核心不变量当场被打破。动作库里往复类都是 3，这条分支是防御性的。
        effort_ratio = min(1.0, verdict.get("cycles", 0) / min_cycles) if min_cycles > 0 else 1.0
    else:
        effort_ratio = min(1.0, verdict.get("hold_ratio", 0.0) / HOLD_TARGET_RATIO)

    raw = SCORE_WEIGHT_AMPLITUDE * exercise_score_from_activity(
        verdict.get("peak_activity", 0.0)
    ) + SCORE_WEIGHT_EFFORT * (effort_ratio * SCORE_MAX)

    score = max(0, min(SCORE_MAX, round_int(raw)))
    if verdict.get("grade") != GRADE_COMPLETED:
        score = min(score, UNMET_MAX_SCORE)
    return score


def session_score_of(items) -> int:
    """整场活动的成绩（0–100）：对**判定过的**动作的动作分取平均，四舍五入到整数。

    ## 为什么不是"逐帧达成度的平均"

    那个数没有"做到位没有"的含义：用户幅度很小地晃满 82 秒，逐帧平均也能拿到中等
    分数，而每个动作的判定都在说「幅度还不够」。用动作分的均值，界面上的「本次动作
    成绩」才与逐动作明细、与「到位动作 X / Y」对得上，
    ``score >= EXERCISE_PASS_SCORE`` ⟺ 判为完成 那条不变量也才在外层继续成立。

    ## 0 不是"得了 0 分"

    ``items`` 为空（一个动作都没判出来）→ 返回 0。⚠️ 显示端必须靠**明细是否为空**
    区分"没有成绩"与"真的得 0 分"（后者可达：全程没动，见 ``IDLE_SCORE``）。
    这与"老记录该列为 NULL"是第三件事 —— 三态别混。

    与前端 ``exerciseQuality.sessionScoreOf()`` 逐位等价（由守卫对拍）。
    """
    items = list(items)
    if not items:
        return 0
    total = sum(int(it["score"]) for it in items)
    return max(0, min(SCORE_MAX, round_int(total / len(items))))


# ---------------------------------------------------------------------------
# 逐动作明细（`activity_log.action_scores` 这一列的**规范文本形态**）#
# ## 为什么要有"规范文本形态"这一说
#
# 这一列存的是「本次每个动作各自得了多少分」。它是一个 JSON 文本，但**不是随便一段
# JSON** —— 两端写进去的字节必须完全一样，否则：
#   - 导出的文件在两端互相导入后**不是同一个文件**（而"导出→导入→再导出得到同一个
#     文件"是导出格式明确的设计目标）；
#   - 对拍脚本无法逐字符比对，只能改成"解析后比较"，而解析后比较放过了键序、
#     空白、Unicode 转义这些真实差异。
#
# 所以这里把形态**钉死**成一个具体字节序列：紧凑分隔符（无空格）、不转义非 ASCII、
# 键序固定为 `v` → `items`，每项 `id` → `score` → `grade`。
# 前端 `exerciseQuality.ts :: serializeActionScores()` 是逐字节等价实现，
# 由 `scripts/verify-exercise-quality.mjs` 对同一批输入逐字符对拍。
#
# ## 为什么是 `str` 而不是"结构化字段"
#
# 导出格式的字段类型只有 `num` / `str` 两态。把它声明成结构化类型意味着导入时
# 要**重新序列化**，那么"导出→导入→再导出"的字节稳定性就依赖两端的序列化器
# 永远一致 —— 而现在只要一次序列化、之后全程当作**不透明文本**搬运，稳定性
# 由构造保证。代价是这一列的坏值不会被导出层拦住；显示端一律防御性解析
# （解析失败 / 缺字段 / 老记录为 NULL 都显示 `--`，不编造）。
#
# ## 为什么 Python 侧也要有（它在生产路径上并不被调用）
#
# 这一列由**前端**序列化后随 POST 提交（移动端没有 Python，前端必须自己会序列化），
# 桌面端只把它当文本存。所以本函数在生产路径上不产生数据 —— 它的作用是给守卫
# 提供**独立期望值**：两端对"同一份明细该长什么样"必须给出同一个答案。
# 与 `judge_exercise()` 的处境相同（那一个也是前端运行时的对照实现）。
# ---------------------------------------------------------------------------

#: 明细文本的格式版本。将来改形态时靠它区分老数据，**别靠猜结构**。
#:
#: 🔴 v1 → v2 不是"形态"变了（字段完全相同），而是**分数的口径变了**：
#: v1.7.0 把幅度从"绝对偏离、三项取最大"改成了"该动作针对的量的活动范围"，
#: 于是同一个动作的分数在 v1 与 v2 下**不是同一把尺子**。
#: 形态不变却要升版本，正是为了这件事：显示端必须能把老明细标成「旧口径」，
#: 否则用户会拿两个不可比的数字互相比较（那正是"展示了不能证明的数字"）。
ACTION_SCORES_VERSION = 2

#: 仍然**能解析**的历史版本（显示端要标注口径，但不必显示成 `--`）。
ACTION_SCORES_LEGACY_VERSIONS = (1,)


def serialize_action_scores(items) -> str:
    """把逐动作明细序列化成**规范文本**（两端逐字节一致）。

    Args:
        items: 可迭代的 ``{"id": str, "score": int, "grade": str}``。
            只放**判定过**的动作；没采样（人不在画面里）与指标测不到的动作
            **不入列** —— 缺席就是"没判"，不是"得 0 分"。

    Returns:
        紧凑 JSON 文本，形如 ``{"v":1,"items":[{"id":"neck-flex-left","score":84,"grade":"completed"}]}``。

    ⚠️ `separators=(",", ":")` 与 `ensure_ascii=False` 不是风格选择：前者对齐
    JS 的 `JSON.stringify`（默认**无空格**），后者对齐它**不转义**非 ASCII 的行为。
    少了任何一个，两端写出来的就是不同的字节。
    """
    return json.dumps(
        {
            "v": ACTION_SCORES_VERSION,
            "items": [
                {
                    "id": str(it["id"]),
                    "score": int(it["score"]),
                    "grade": str(it["grade"]),
                }
                for it in items
            ],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )
