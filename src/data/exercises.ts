/**
 * 肩颈活动「动作库」—— **唯一数据源**。
 *
 * 这些定义原先硬编码在 `components/ExercisePanel.tsx` 里，字段只有
 * `{name, duration, icon, hint, color}`，既没有「针对什么问题」这个维度，
 * 也没法在不改组件代码的前提下加动作（引导动画是按**下标** `switch` 的）。
 * ROADMAP-SCORING 的 **S7** 把它们搬到这里，并补上维度与引导参数。
 *
 * ## 本模块的边界
 *
 * - 🔴 **纯数据**：不 import React、不 import 任何组件。守卫要靠 esbuild 把本文件
 *   bundle 出来读真实导出（不是内联副本 —— 副本会与源码各错各的）。
 * - **单点定义**：整场活动的标称总时长只在这里算一次（`TOTAL_DURATION_SEC`）。
 *   此前 `NeckActivity.tsx` 里各算一遍，改自适应时长后必然漂移（见 ROADMAP-SCORING §0.4 #7）。
 * - S7 是**搬家**，不是改造：7 个动作的**顺序、时长、引导动画参数逐项与改造前一致**
 *   （由 `scripts/verify-exercises.mjs` 的逐项快照断言）。加动作、改时长属于 S8。
 *
 * ## 关于 `target`（问题维度）—— 一条如实记录的能力缺口
 *
 * `target` 与 `scorer` 的三个指标维度一一对应（头部倾斜 / 肩高差 / 脊柱倾斜）。
 * 按物理含义映射后，**脊柱维度只有 1 个动作**（头部后缩），低于 S7 文档里
 * 「每维度 ≥ 2 个」的预期。原因不是映射偷懒，而是：
 *
 *   1. 现有 7 个动作里可用脊柱维度的本来就少（`扩胸运动` 已按"改善圆肩"
 *      归到肩带，若挪去脊柱则换成肩带只剩 1 个，只是把缺口搬家）；
 *   2. 补齐动作**必然改变总时长与顺序**，而 S7 的硬约束是"重构不改行为" ——
 *      一次只做一件事。
 *
 * 所以这里**不为了凑数改映射**（那是"编造可验证性"），而是把这个缺口写下来，
 * 交给 S8（自适应序列 + 难度分级，本来就要扩动作库）解决。
 * 守卫会打印当前分布，并对不足 2 个的维度**显式告警**，但不静默通过。
 *
 * ## 关于 `measurable`（S2 遗留字段，必须一起搬）
 *
 * `exerciseActivity` 只看「头部侧倾角 / 肩部高度差 / 脊柱倾斜角」三个量，反映的是
 * **不对称与倾斜**。于是：
 *   - 头侧屈、肩部环绕 → 产生明显的单侧偏斜 / 高度差 → 可判定 ✅
 *   - 颈部左右转（绕垂直轴旋转，正对摄像头时耳线仍水平）、
 *     扩胸（双侧对称）、头部后缩（矢状面平移，三角度几乎不变）→ **测不到** ❌
 *
 * 对不可判定的动作给"没检测到动作"的结论，就是**冤枉真的在做的用户**
 * ——正是 S2 要消灭的那类缺陷。所以这类动作不参与完成度判定，界面照常给静态要领。
 * ⚠️ 这张表是按指标定义推出来的，**尚未用真机数据校准**（本项目目前没有真机验证手段）。
 *
 * ## 关于 `contraindications` / `keyPoints`
 *
 * 一般性安全提醒，**不构成医疗建议**。S7 先声明，S8（要领展开与语音播报）与
 * S9（安全约束与疼痛反馈）会消费它们；当前界面只用 `hint`。
 */
import type { ExerciseKind } from '../platform/exerciseQuality'

/** 动作针对的问题维度，与 `scorer` 的三档 issues 对应。 */
export type ExerciseTarget = 'head' | 'shoulder' | 'spine'

/** 动作强度档（供 S8 排期参考，当前不参与调度）。 */
export type ExerciseIntensity = 'low' | 'medium'

/**
 * 引导动画的头部运动参数。
 *
 * 关键帧单位是 `offset = headR * 0.6`（`headR ≈ size * 0.16`）：
 * `0` = 基准位、`-1` = 向左/向上一个 offset。这样写与画布尺寸无关，
 * 而改造前的写法是把 `baseX ± offset * k` 逐条硬编码在 7 个 `case` 里。
 */
export interface GuideMotion {
  /** 一次完整循环的秒数（`repeat: Infinity`，缓动固定 `easeInOut`）。 */
  cycleSec: number
  /** x 关键帧（正数向右）。 */
  x: readonly number[]
  /** y 关键帧（正数向下）。 */
  y: readonly number[]
  /** 旋转关键帧（度）。**不给**表示这个动作的头部不做旋转。 */
  rotate?: readonly number[]
}

/**
 * 方向指示图元。
 *
 * 组件负责「怎么画」，数据只负责「画哪个」—— 这样新增动作只要从既有图元里挑一个
 * 并填参数，不必改组件（S7 的验收标准之一）。图元内部的具体坐标仍留在组件里，
 * 因为它们是纯绘图细节（含少量绝对像素），放进数据只会变成难懂的系数表。
 */
export type GuideArrow =
  | { kind: 'straight'; dir: 'left' | 'right' | 'up' | 'down' }
  | { kind: 'arc'; from: number; to: number; dir: 'cw' | 'ccw' }
  | { kind: 'ring' }

export interface Exercise {
  /** 稳定标识（英文 slug）。列表 key、埋点都用它 —— **别拿中文名当标识**。 */
  id: string
  /** 显示名。 */
  name: string
  /** 密集文案用的短名（多个动作可共用，如左右转颈都叫「转颈」）。 */
  shortName: string
  /** 针对的问题维度。 */
  target: ExerciseTarget
  /** 强度档。 */
  intensity: ExerciseIntensity
  /** 标称时长（秒）—— 排期与完成度判定的分母都用它。 */
  duration: number
  /** S8 时长分级的可用区间（秒）；`duration` 必须落在区间内（守卫断言）。 */
  durationRange: readonly [number, number]
  /** 禁忌：出现这些情况应跳过或先咨询医生。 */
  contraindications: readonly string[]
  /** 界面一行要领（与改造前逐字一致，避免用户可见变化）。 */
  hint: string
  /** 要领 / 常见错误，供 S8 展开与语音播报。 */
  keyPoints: readonly string[]
  icon: string
  color: string
  /** 完成度判定元数据（S2）：保持类看幅度+保持时长，往复类看幅度+有效次数。 */
  kind: ExerciseKind
  min_cycles: number
  /** 当前三个指标能否反映这个动作（详见文件头说明）。 */
  measurable: boolean
  /** 引导参数：头部运动 + 方向指示。 */
  guide: { motion: GuideMotion; arrow: GuideArrow }
}

export const EXERCISES: readonly Exercise[] = [
  {
    id: 'neck-flex-left',
    name: '颈部左侧屈',
    shortName: '左侧屈',
    target: 'head',
    intensity: 'low',
    duration: 12,
    durationRange: [10, 20],
    contraindications: ['颈椎急性损伤或颈部外伤未愈', '做动作时出现眩晕、手麻或向手臂放射的疼痛'],
    hint: '头向左肩倾斜，感受右侧颈部拉伸',
    keyPoints: ['肩膀保持下沉，不要耸肩去够耳朵', '以颈部侧面有轻微拉伸感为度，不要用手压头'],
    icon: '↩',
    color: '#4CAF50',
    kind: 'hold',
    min_cycles: 0,
    measurable: true,
    guide: { motion: { cycleSec: 2, x: [0, -1, 0], y: [0] }, arrow: { kind: 'straight', dir: 'left' } },
  },
  {
    id: 'neck-flex-right',
    name: '颈部右侧屈',
    shortName: '右侧屈',
    target: 'head',
    intensity: 'low',
    duration: 12,
    durationRange: [10, 20],
    contraindications: ['颈椎急性损伤或颈部外伤未愈', '做动作时出现眩晕、手麻或向手臂放射的疼痛'],
    hint: '头向右肩倾斜，感受左侧颈部拉伸',
    keyPoints: ['肩膀保持下沉，不要耸肩去够耳朵', '以颈部侧面有轻微拉伸感为度，不要用手压头'],
    icon: '↪',
    color: '#66BB6A',
    kind: 'hold',
    min_cycles: 0,
    measurable: true,
    guide: { motion: { cycleSec: 2, x: [0, 1, 0], y: [0] }, arrow: { kind: 'straight', dir: 'right' } },
  },
  {
    id: 'neck-rotate-left',
    name: '颈部左转',
    shortName: '转颈',
    target: 'head',
    intensity: 'low',
    duration: 12,
    durationRange: [10, 20],
    contraindications: ['颈椎急性损伤或颈部外伤未愈', '做动作时出现眩晕、手麻或向手臂放射的疼痛'],
    hint: '缓慢向左转头，保持双肩放松',
    keyPoints: ['下巴保持水平，不要低头或抬头', '转到有轻微牵拉感即可，不要用力甩头'],
    icon: '⬅',
    color: '#2196F3',
    kind: 'hold',
    min_cycles: 0,
    measurable: false,
    guide: {
      motion: { cycleSec: 2.2, x: [0], y: [0], rotate: [-18, 18, -18] },
      arrow: { kind: 'arc', from: 30, to: 150, dir: 'ccw' },
    },
  },
  {
    id: 'neck-rotate-right',
    name: '颈部右转',
    shortName: '转颈',
    target: 'head',
    intensity: 'low',
    duration: 12,
    durationRange: [10, 20],
    contraindications: ['颈椎急性损伤或颈部外伤未愈', '做动作时出现眩晕、手麻或向手臂放射的疼痛'],
    hint: '缓慢向右转头，保持双肩放松',
    keyPoints: ['下巴保持水平，不要低头或抬头', '转到有轻微牵拉感即可，不要用力甩头'],
    icon: '➡',
    color: '#42A5F5',
    kind: 'hold',
    min_cycles: 0,
    measurable: false,
    guide: {
      motion: { cycleSec: 2.2, x: [0], y: [0], rotate: [18, -18, 18] },
      arrow: { kind: 'arc', from: 150, to: 30, dir: 'cw' },
    },
  },
  {
    id: 'shoulder-circles',
    name: '肩部环绕',
    shortName: '肩环绕',
    target: 'shoulder',
    intensity: 'medium',
    duration: 12,
    durationRange: [10, 20],
    contraindications: ['肩关节脱位史，或肩袖损伤急性期'],
    hint: '双肩向后画圈，幅度尽量大',
    keyPoints: ['画圈时颈部放松，不要跟着耸肩', '速度放慢，感受肩胛骨在背后转动'],
    icon: '⭕',
    color: '#FF9800',
    kind: 'cyclic',
    min_cycles: 3,
    measurable: true,
    guide: {
      motion: { cycleSec: 2.5, x: [0, 0.5, -0.5, 0], y: [0, -0.3, -0.3, 0] },
      arrow: { kind: 'ring' },
    },
  },
  {
    id: 'chest-opener',
    name: '扩胸运动',
    shortName: '扩胸',
    target: 'shoulder',
    intensity: 'medium',
    duration: 12,
    durationRange: [10, 20],
    contraindications: ['腰椎间盘问题发作期（避免腰部过伸）', '肩关节脱位史，或肩袖损伤急性期'],
    hint: '双手后伸，挺胸抬头',
    keyPoints: ['力量来自背部收紧，不是把腰往前顶', '肩胛骨向后下方靠拢'],
    icon: '🤲',
    color: '#9C27B0',
    kind: 'cyclic',
    min_cycles: 3,
    measurable: false,
    guide: {
      motion: { cycleSec: 2.4, x: [0], y: [0, -0.5, 0], rotate: [0, -8, 0] },
      arrow: { kind: 'straight', dir: 'up' },
    },
  },
  {
    id: 'chin-tuck',
    name: '头部后缩',
    shortName: '头部后缩',
    target: 'spine',
    intensity: 'low',
    duration: 10,
    durationRange: [8, 15],
    contraindications: ['颈椎急性损伤或颈部外伤未愈'],
    hint: '收下巴向后平移，像做双下巴',
    keyPoints: ['是向后平移，不是低头', '眼睛保持水平，颈部后侧有轻微牵拉感'],
    icon: '⬇',
    color: '#00BCD4',
    kind: 'hold',
    min_cycles: 0,
    measurable: false,
    guide: { motion: { cycleSec: 1.8, x: [0], y: [0, 0.4, 0] }, arrow: { kind: 'straight', dir: 'down' } },
  },
]

export const EXERCISE_COUNT = EXERCISES.length

/**
 * 整场活动的标称总时长（秒）。
 *
 * 🔴 **单点定义**：别在别处再 `reduce` 一遍。此前 `NeckActivity.tsx` 里算了两处，
 * 值相同所以看不出问题；一旦 S8 让时长变得可配，两处就会给出不同的进度条。
 */
export const TOTAL_DURATION_SEC = EXERCISES.reduce((sum, e) => sum + e.duration, 0)

/** 当前指标**测不到**的动作（不参与完成度判定）。 */
export const NOT_MEASURABLE: readonly Exercise[] = EXERCISES.filter((e) => !e.measurable)

/**
 * 「未参与判定」的短名串（去重）。
 *
 * 左右转颈共用短名「转颈」，所以要去重 —— 否则会拼出「转颈 / 转颈 / 扩胸」。
 * 收尾文案由它派生，避免在组件里再写一遍动作名（那正是 S7 要消灭的耦合）。
 */
export const NOT_MEASURABLE_LABEL = [...new Set(NOT_MEASURABLE.map((e) => e.shortName))].join(' / ')

/** 维度显示名（供 S8 的"为什么给你安排这个"使用）。 */
export const TARGET_LABEL: Record<ExerciseTarget, string> = {
  head: '头部姿态',
  shoulder: '肩部高低',
  spine: '脊柱倾斜',
}
