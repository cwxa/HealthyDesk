"""动作完成度判定 —— 回答「用户到底做了没有 / 做到位没有」。

## 为什么需要它

`NeckActivity` 的活动执行链路此前**只有倒计时**（`setInterval` 递减 `timeLeft`）：
用户从头到尾一动不动，82 秒后系统照样宣布「活动完成!」并记一条记录。
S1 给评分分了静息/运动双通道之后，界面能显示「动作达成度」了，但那仍然是
**逐帧瞬时值** —— 没有任何地方把一串帧折成「这次活动完成得怎么样」。

本模块把那串帧折成**三分类结论**，并把三个可解释的量一并返回：

    peak_activity  峰值活动量      —— 幅度够不够
    held_ms        达标状态累计时长 —— 保持住了没有
    cycles         往复动作有效循环 —— 次数够不够

## 三分类（不允许第四种状态）

    idle          峰值活动量 < ACTIVITY_IDLE_MAX —— 全程没动
    insufficient  动了，但幅度 / 保持时长 / 次数有一项没达到
    completed     本类型要求的项全部达到

## 口径（单点定义）

- **活动量**复用 `scorer.exercise_activity()`（三项相对各自静息阈值的倍数取最大），
  于是「活动量 1.0」与 S1 **同义**：偏离已达静息态提醒线 = 确实动起来了。
  复用它还有一个额外好处 —— **它天生是归一化的**（除以各自阈值），因此不受摄像头
  距离与用户体型影响，正好回应 S2 设计里那条「设备差异会显著影响幅度判定」的风险。
- 每帧活动量先经 `round_1` 再做**一切**比较。这不是美化输出，而是本项目的硬规矩：
  **用户看到的数字与系统判定必须同源**。S1 刚踩过这个坑 —— `raw = 59.94` 取整成
  60（正好是达标线）却提示「幅度不足」，自相矛盾。所以判定用的必须是取整后的值。
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

import logging

from services.rounding import round_1
from services.scorer import EXERCISE_ACTIVITY_START, exercise_activity

logger = logging.getLogger("neckguardian.exercise_quality")

# ---- 结论 ----
GRADE_COMPLETED = "completed"
GRADE_INSUFFICIENT = "insufficient"
GRADE_IDLE = "idle"

# ---- 动作类型 ----
KIND_HOLD = "hold"      # 保持类（屈、伸、缩）：看「幅度 + 保持时长」
KIND_CYCLIC = "cyclic"  # 往复类（环绕、扩胸）：看「幅度 + 有效次数」

# ---- 具名常量（全部进对拍体系，不许散落成魔法数字）----
ACTIVITY_IDLE_MAX = 0.25        # 峰值活动量低于此值 = 全程没动
ACTIVITY_ONSET = EXERCISE_ACTIVITY_START  # 有效活动起点，与运动态评分共用同一取值
HOLD_TARGET_RATIO = 0.6         # 保持类：达标时长占标称时长的比例下限
CYCLE_TROUGH_RATIO = 0.4        # 往复类：回落到 onset 的该比例以下才算「一次归位」
DEFAULT_MIN_CYCLES = 3          # 往复类动作的默认最小有效循环数
MAX_FRAME_GAP_MS = 1500         # 相邻帧间隔超过它 = 数据中断，该段不计入保持时长

# ---- 引导文案（与结论一一对应；措辞本身也进对拍，防止两端说法不一致）----
HINT_IDLE = "没检测到动作，跟着引导慢慢做"
HINT_AMPLITUDE = "幅度还不够，再大一点"
HINT_HOLD = "保持住，别急着放下"
HINT_CYCLES = "再多做几次"
HINT_COMPLETED = "很好，保持住"


def _activities(frames) -> list:
    """逐帧活动量，统一经 `round_1` —— 之后所有比较都基于它（见模块文档「同源」）。"""
    return [
        round_1(
            exercise_activity(
                float(f["head_angle"]), float(f["shoulder_diff"]), float(f["spine_angle"])
            )
        )
        for f in frames
    ]


def judge_exercise(frames, spec=None) -> dict:
    """把一串（已按时间升序的）姿态帧折成完成度结论。

    Args:
        frames: 可迭代对象，每项为 ``{"t": 毫秒, "head_angle": float,
                "shoulder_diff": float, "spine_angle": float}``。
                **没有姿态的帧不应进入序列** —— 缺口会被算到前一帧的区间上，
                因此上游只推入 `type == "pose"` 的帧。
        spec: ``{"kind": "hold" | "cyclic", "duration_ms": 标称时长,
                "min_cycles": 往复类的最小循环数（可选）}``。缺省为保持类、不限时长。

    Returns:
        ``{"grade", "hint", "peak_activity", "held_ms", "hold_ratio", "cycles"}``

    这是**纯函数**：同样输入必然同样输出，因此可以离线回放固定样本
    （见 `scripts/samples/` 与 `scripts/verify-exercise-quality.mjs`）。
    """
    spec = spec or {}
    kind = spec.get("kind") or KIND_HOLD
    duration_ms = float(spec.get("duration_ms") or 0)
    min_cycles = spec.get("min_cycles")
    if min_cycles is None:
        min_cycles = DEFAULT_MIN_CYCLES if kind == KIND_CYCLIC else 0

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

    acts = _activities(frames)
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
        "Exercise quality grade=%s | peak=%.1f held=%dms ratio=%.1f cycles=%d (n=%d, kind=%s)",
        grade, peak, held_ms, hold_ratio, cycles, len(frames), kind,
    )
    return {
        "grade": grade,
        "hint": hint,
        "peak_activity": peak,
        "held_ms": held_ms,
        "hold_ratio": hold_ratio,
        "cycles": cycles,
    }
