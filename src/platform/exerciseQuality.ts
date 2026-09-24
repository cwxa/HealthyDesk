import { EXERCISE_ACTIVITY_START, exerciseActivity, pyRound1 } from './scoringModel'

/**
 * 动作完成度判定（前端）—— `backend/services/exercise_quality.py` 的逐位等价实现。
 *
 * 回答的问题：**用户到底做了没有、做到位没有**。
 * 活动执行链路此前只有倒计时，用户全程不动，系统照样宣布「活动完成!」——
 * 本模块把一串帧折成三分类结论 + 三个可解释的量。
 *
 * 口径与后端单点定义一致：
 *
 *   - 活动量复用 `exerciseActivity()`（与运动态评分同一个函数、同一组阈值），
 *     因此「活动量 1.0」= 偏离已达静息态提醒线 = 确实动起来了。
 *     它天生归一化（除以各自阈值），不受摄像头距离 / 体型影响。
 *   - 每帧活动量先经 `pyRound1` 再做**一切**比较 —— 用户看到的数字与系统判定
 *     必须同源（S1 的教训：`raw = 59.94` 取整成 60 却提示「幅度不足」）。
 *   - `heldMs` 是左黎曼和：只累加 `activity[i] >= ACTIVITY_ONSET` 的区间，
 *     且间隔须在 (0, MAX_FRAME_GAP_MS] 内 —— 掉帧/走出画面不算「保持得好」。
 *   - `holdRatio` 的分母是**标称时长**，不是实际采集跨度（用户离开画面
 *     不能让分母变小）；结果钳到 [0, 1] —— 采样跨度偶尔会略超标称时长
 *     （计时器与帧率不可能严丝合缝），显示成 183% 只会让人困惑。
 *
 * ⚠️ 改动本文件必须同步改 `backend/services/exercise_quality.py`，
 * 并跑 `npm run verify:parity`（`verify-exercise-quality.mjs` 会逐条对拍）。
 */

// ---- 结论 ----
// 先定义**运行时常量**再由它派生类型（而不是反过来只写类型字面量）：
// 类型在运行时不存在，对拍脚本就拿不到值来比对，跨语言那两个字符串是否一致
// 只能靠人眼。中文文案与结论字符串一旦两端不一致，用户会看到「结论说完成、
// 文案说再大一点」这种自相矛盾 —— 所以它们必须是可被机器钉住的值。
export const GRADE_COMPLETED = 'completed'
export const GRADE_INSUFFICIENT = 'insufficient'
export const GRADE_IDLE = 'idle'
export type ExerciseGrade = typeof GRADE_COMPLETED | typeof GRADE_INSUFFICIENT | typeof GRADE_IDLE

// ---- 动作类型 ----
export const KIND_HOLD = 'hold'
export const KIND_CYCLIC = 'cyclic'
export type ExerciseKind = typeof KIND_HOLD | typeof KIND_CYCLIC

// ---- 具名常量（全部进对拍体系）----
export const ACTIVITY_IDLE_MAX = 0.25
export const ACTIVITY_ONSET = EXERCISE_ACTIVITY_START
export const HOLD_TARGET_RATIO = 0.6
export const CYCLE_TROUGH_RATIO = 0.4
export const DEFAULT_MIN_CYCLES = 3
export const MAX_FRAME_GAP_MS = 1500

// ---- 引导文案（与结论一一对应，措辞本身也进对拍）----
export const HINT_IDLE = '没检测到动作，跟着引导慢慢做'
export const HINT_AMPLITUDE = '幅度还不够，再大一点'
export const HINT_HOLD = '保持住，别急着放下'
export const HINT_CYCLES = '再多做几次'
export const HINT_COMPLETED = '很好，保持住'

/** 判定用的单帧采样（字段名与后端 / 样本文件一致，避免中间映射层漂移）。 */
export interface ExerciseFrame {
  /** 毫秒时间戳，只用于求区间长度，原点无所谓。序列必须按它升序。 */
  t: number
  head_angle: number
  shoulder_diff: number
  spine_angle: number
}

export interface ExerciseSpec {
  kind: ExerciseKind
  /** 标称时长（毫秒），作为保持比例的分母。 */
  duration_ms: number
  /** 往复类动作的最小有效循环数；缺省用 `DEFAULT_MIN_CYCLES`（保持类为 0）。 */
  min_cycles?: number
}

export interface ExerciseVerdict {
  grade: ExerciseGrade
  hint: string
  peak_activity: number
  held_ms: number
  hold_ratio: number
  cycles: number
}

/** 逐帧活动量，统一经 `pyRound1` —— 之后所有比较都基于它。 */
function activitiesOf(frames: ExerciseFrame[]): number[] {
  const out: number[] = []
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]
    out.push(pyRound1(exerciseActivity(f.head_angle, f.shoulder_diff, f.spine_angle)))
  }
  return out
}

/**
 * 把一串（已按时间升序的）姿态帧折成完成度结论。
 *
 * 纯函数：同样输入必然同样输出，因此可以离线回放固定样本
 * （见 `scripts/samples/` 与 `scripts/verify-exercise-quality.mjs`）。
 */
export function judgeExercise(frames: ExerciseFrame[], spec?: Partial<ExerciseSpec>): ExerciseVerdict {
  const kind: ExerciseKind = spec?.kind ?? KIND_HOLD
  const durationMs = spec?.duration_ms != null ? Number(spec.duration_ms) : 0
  const minCycles = spec?.min_cycles != null ? spec.min_cycles : kind === KIND_CYCLIC ? DEFAULT_MIN_CYCLES : 0

  if (frames.length === 0) {
    // 一帧都没有 = 完全不知道用户做了什么，只能按「没动」处理（不能假装完成）
    return { grade: GRADE_IDLE, hint: HINT_IDLE, peak_activity: 0, held_ms: 0, hold_ratio: 0, cycles: 0 }
  }

  const acts = activitiesOf(frames)
  let peak = acts[0]
  for (let i = 1; i < acts.length; i++) {
    if (acts[i] > peak) peak = acts[i]
  }

  let heldMs = 0
  for (let i = 0; i < frames.length - 1; i++) {
    if (acts[i] < ACTIVITY_ONSET) continue
    const gap = frames[i + 1].t - frames[i].t
    if (gap <= 0 || gap > MAX_FRAME_GAP_MS) continue
    heldMs += gap
  }

  const holdRatio = durationMs > 0 ? Math.min(1, pyRound1(heldMs / durationMs)) : 0

  // 往复计数：带滞回的穿越计数（升到 onset 算「到位」，回落到 trough 算「归位」）。
  // 两个不同阈值是为了防止在 onset 附近抖动时被反复计数。
  let cycles = 0
  let hot = false
  const trough = ACTIVITY_ONSET * CYCLE_TROUGH_RATIO
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i]
    if (!hot) {
      if (a >= ACTIVITY_ONSET) hot = true
    } else if (a <= trough) {
      cycles += 1
      hot = false
    }
  }

  let grade: ExerciseGrade
  let hint: string
  if (peak < ACTIVITY_IDLE_MAX) {
    grade = GRADE_IDLE
    hint = HINT_IDLE
  } else if (peak < ACTIVITY_ONSET) {
    grade = GRADE_INSUFFICIENT
    hint = HINT_AMPLITUDE
  } else if (kind === KIND_CYCLIC && cycles < minCycles) {
    grade = GRADE_INSUFFICIENT
    hint = HINT_CYCLES
  } else if (kind === KIND_HOLD && holdRatio < HOLD_TARGET_RATIO) {
    grade = GRADE_INSUFFICIENT
    hint = HINT_HOLD
  } else {
    grade = GRADE_COMPLETED
    hint = HINT_COMPLETED
  }

  return { grade, hint, peak_activity: peak, held_ms: heldMs, hold_ratio: holdRatio, cycles }
}
