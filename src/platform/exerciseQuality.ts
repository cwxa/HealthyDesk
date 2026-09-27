import {
  EXERCISE_ACTIVITY_START,
  SCORE_MAX,
  exerciseActivity,
  pyRound,
  pyRound1,
  scoreFromActivity,
} from './scoringModel'

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

// ---- 动作分（单个动作的成绩）----
// 目标只有一个：**分数与判定不许互相打脸**。算法与那条核心不变量见 `scoreExercise()`。
export const SCORE_WEIGHT_AMPLITUDE = 0.5
export const SCORE_WEIGHT_EFFORT = 0.5
/** 动作分达标线：`score >= 它` ⟺ 判定为「完成」。 */
export const EXERCISE_PASS_SCORE = 80
/** 未达标时的分数上限（**有意台阶**：未到位就是不到 80）。 */
export const UNMET_MAX_SCORE = 79
/** 全程没动（`grade === idle`）的成绩：就是 0，不给"动了但很少"的编造值。 */
export const IDLE_SCORE = 0

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

/**
 * 单个动作的成绩（0–100）。`judgeExercise()` 的配套函数。
 *
 * ## 怎么算
 *
 * `动作分 = 幅度分量 × SCORE_WEIGHT_AMPLITUDE + 到位程度分量 × SCORE_WEIGHT_EFFORT`
 *
 * - **幅度分量** = `scoreFromActivity(peak_activity)`：与实时运动态评分**同一个映射**
 *   （达标线 60、活动量 4 倍阈值即满分），所以「实时看着 90 分」与「这个动作幅度分 90」
 *   说的是同一件事 —— 这正是把那条映射抽成 `scoringModel.scoreFromActivity()` 的原因。
 * - **到位程度分量**：保持类 = `min(1, hold_ratio / HOLD_TARGET_RATIO) × 100`；
 *   往复类 = `min(1, cycles / min_cycles) × 100`。
 *
 * ## 🔴 核心不变量（由构造保证，不是巧合）
 *
 * `score >= EXERCISE_PASS_SCORE` **⟺** `grade === 'completed'`
 *
 * - 判「完成」⇒ 幅度 ≥ 达标线（分量 ≥ 60）且到位程度满分 ⇒ ≥ 0.5×60 + 0.5×100 = **80**；
 * - 判「未完成」⇒ 分数被**显式钳到** `UNMET_MAX_SCORE`。
 *
 * 后一条是有意为之的**台阶**：幅度很大但没保持住（按公式能算出 99）必须落在 80 以下，
 * 否则界面会一边说「保持住，别急着放下」一边给 99 分 —— 正是本项目反复修的那类
 * 「文案与判定互相打脸」。钳位由 `grade` 驱动（不重算阈值），因此调用方即便传了与
 * 判定时不同的 `spec`，不变量依然成立。
 *
 * ⚠️ 摄像头没拍到人时上游根本不判定，本函数不会被调用 —— 那种情况必须显示 `--`，
 * **不许**拿 `IDLE_SCORE` 去说「你没做」。
 */
export function scoreExercise(verdict: ExerciseVerdict, spec?: Partial<ExerciseSpec>): number {
  if (verdict.grade === GRADE_IDLE) return IDLE_SCORE

  const kind: ExerciseKind = spec?.kind ?? KIND_HOLD
  const minCycles = spec?.min_cycles != null ? spec.min_cycles : kind === KIND_CYCLIC ? DEFAULT_MIN_CYCLES : 0

  const effortRatio =
    kind === KIND_CYCLIC
      ? minCycles > 0
        ? Math.min(1, verdict.cycles / minCycles)
        : // 该配置**不要求计次**（min_cycles ≤ 0）→ 不因次数扣分。
          // 不能退回 `cycles / max(1, minCycles)`：那样「判完成（cycles ≥ 0 恒真）却只有 50 分」，
          // 上面那条核心不变量当场被打破。动作库里往复类都是 3，这条分支是防御性的。
          1
      : Math.min(1, verdict.hold_ratio / HOLD_TARGET_RATIO)

  const raw =
    SCORE_WEIGHT_AMPLITUDE * scoreFromActivity(verdict.peak_activity) +
    SCORE_WEIGHT_EFFORT * (effortRatio * SCORE_MAX)

  let score = Math.max(0, Math.min(SCORE_MAX, pyRound(raw)))
  if (verdict.grade !== GRADE_COMPLETED) score = Math.min(score, UNMET_MAX_SCORE)
  return score
}

/**
 * 整场活动的成绩（0–100）：对**判定过的**动作的动作分取平均，四舍五入到整数。
 *
 * ## 为什么不是"逐帧达成度的平均"
 *
 * 那个数（`sessionScores` 的均值）没有"做到位没有"的含义：用户幅度很小地晃满 82 秒，
 * 逐帧平均也能拿到中等分数，而每个动作的判定都在说「幅度还不够」。用动作分的均值，
 * 界面上的「本次动作成绩」才与逐动作明细、与「到位动作 X / Y」对得上，
 * `score >= EXERCISE_PASS_SCORE ⟺ 判为完成` 那条不变量也才在外层继续成立。
 *
 * ## 0 不是"得了 0 分"
 *
 * `items` 为空（一个动作都没判出来）→ 返回 0。⚠️ 显示端必须靠**明细是否为空**
 * 区分"没有成绩"与"真的得 0 分"（后者是可达的：全程没动，见 `IDLE_SCORE`）。
 * 这与老记录该列为 `NULL` 是第三件事 —— 三态别混。
 */
export function sessionScoreOf(items: readonly ActionScoreItem[]): number {
  if (items.length === 0) return 0
  let sum = 0
  for (const it of items) sum += it.score
  return Math.max(0, Math.min(SCORE_MAX, pyRound(sum / items.length)))
}

// ---------------------------------------------------------------------------
// 逐动作明细（`activity_log.action_scores` 这一列的**规范文本形态**）
//
// 与 `backend/services/exercise_quality.py :: serialize_action_scores()` 是逐字节
// 等价实现 —— 少了任何一个细节，两端写进去的就不是同一串字节，导出文件在两端
// 互相导入后也**不再是同一个文件**（而那是导出格式明确的设计目标）。
//
// 规范形态**钉死**为：紧凑 JSON（无空格）、不转义非 ASCII、键序固定
// `v` → `items`，每项 `id` → `score` → `grade`。
//
// ⚠️ 这一列在导出/导入里是**不透明文本**（字段类型 `str`），导入时**不重新序列化**：
// 那样"导出→导入→再导出"的字节稳定性由构造保证，不依赖两端序列化器永远一致。
// 代价是坏值不会在导出层被拦下 —— 显示端必须防御性解析（见 `parseActionScores`）。
// ---------------------------------------------------------------------------

/** 明细文本的格式版本。将来改形态靠它区分老数据，**别靠猜结构**。 */
export const ACTION_SCORES_VERSION = 1

export interface ActionScoreItem {
  /** 动作库里的稳定标识（`Exercise.id`）。**不存中文名** —— 名字会随文案变，id 不会。 */
  id: string
  score: number
  grade: ExerciseGrade
}

/**
 * 把逐动作明细序列化成**规范文本**（两端逐字节一致）。
 *
 * 只放**判定过**的动作；没采样（人不在画面里）与指标测不到的动作**不入列** ——
 * 缺席就是「没判」，不是「得 0 分」。这一条很重要：把"没看到"写成 0 分就是
 * 冤枉用户，而本项目已经因为同类问题返工过。
 */
export function serializeActionScores(items: readonly ActionScoreItem[]): string {
  return JSON.stringify({
    v: ACTION_SCORES_VERSION,
    items: items.map((it) => ({ id: String(it.id), score: Math.trunc(it.score), grade: it.grade })),
  })
}

/**
 * 解析 `action_scores` 列（**防御性**）。
 *
 * 返回 `null` = 「读不出来 / 没有这份数据」，`[]` = 「本次一个动作都没判出来」。
 * 两者的界面表现不同（`null` → `--`，`[]` → 同样 `--` 但文案可以说明），所以不要
 * 把 `null` 折成 `[]`。
 *
 * 🔴 **任何一项不合法就整体返回 `null`**（而不是丢掉坏项、留下好的）：这份明细要拿来
 * 展示"本次每个动作得了多少分"，留下半份会被读成"只判了这几个动作"。本项目铁律是
 * **不要展示不能证明的数字** —— 宁可整份显示 `--`，也不要给出一个偏小的数目。
 * 老记录该列为 `NULL`，同样走 `null` 分支（那是"这个版本还没有这项数据"，
 * 与"本次没判出来"是两件事，界面文案要分开）。
 */
export function parseActionScores(text: unknown): ActionScoreItem[] | null {
  if (typeof text !== 'string' || text === '') return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (obj.v !== ACTION_SCORES_VERSION) return null
  if (!Array.isArray(obj.items)) return null

  const out: ActionScoreItem[] = []
  for (const it of obj.items) {
    if (it === null || typeof it !== 'object' || Array.isArray(it)) return null
    const rec = it as Record<string, unknown>
    if (typeof rec.id !== 'string' || rec.id === '') return null
    if (typeof rec.score !== 'number' || !Number.isFinite(rec.score)) return null
    const grade = rec.grade
    if (grade !== GRADE_COMPLETED && grade !== GRADE_INSUFFICIENT && grade !== GRADE_IDLE) return null
    out.push({ id: rec.id, score: Math.trunc(rec.score), grade })
  }
  return out
}
