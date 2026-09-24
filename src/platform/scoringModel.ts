/**
 * 评分模型：阈值、分档常量、单项扣分、取整。
 *
 * 与后端 `backend/services/scorer.py` + `backend/config.py` **逐项等价**，
 * 由 `scripts/verify-scoring.mjs` 用四层对拍守住（常量 / 80 用例 / 439 帧平滑 / 8 角度）。
 *
 * ## 为什么单独成一个模块
 *
 * 1. **单点定义**：评分模型被两条链路共用 —— 实时逐帧评分（`localPoseEngine`）
 *    与统计聚合「部位健康度」（`partHealth`）。各写一份必然漂移，
 *    而漂移的表现是「界面显示的分数」与「实际判定依据」不一致，很难发现。
 * 2. **无副作用**：本模块不 import mediapipe、不读 `document`、不建任何实例，
 *    因此可以在 node 里被对拍脚本直接 bundle 引用。
 *    `localPoseEngine.ts` 顶层会 `new LocalPoseEngine()` 并读 `document.baseURI`，
 *    统计链路（Dashboard / localStats）不应该为了拿一个常量而依赖它。
 *
 * 唯一需要记住的规则：
 *     出现任何姿态提醒（issues 非空）  ⟺  分数 < 80
 */

// ---- 与 backend/config.py 一致的阈值 ----
export const HEAD_TILT_THRESHOLD = 5.0
export const SHOULDER_DIFF_THRESHOLD = 4.0
export const SPINE_ANGLE_THRESHOLD = 10.0

// ---- 评分模型的常量，必须与 backend/services/scorer.py 完全一致 ----
export const WARN_ZONE_RATIO = 0.6
export const WARN_ZONE_MAX = 6.0
// 叠加权重：只把最差项算满，其余两项按此权重递减叠加（三项直接相加会过度惩罚）
export const SECONDARY_WEIGHT = 0.3
export const MILD_BASE = 22.0
export const MILD_MAX = 28.0
export const MODERATE_BASE = 34.0
export const MODERATE_MAX = 46.0
export const SEVERE_BASE = 52.0
export const SEVERE_MAX = 65.0
export const SCORE_MIN = 20
export const SCORE_MAX = 100
// 档位边界：超出阈值多少算「明显 / 严重」，与 issues 的分档判断共用
export const HEAD_MILD_HI = 6.0
export const HEAD_MODERATE_HI = 12.0
export const SHOULDER_MILD_HI = 5.0
export const SHOULDER_MODERATE_HI = 10.0
export const SPINE_MILD_HI = 8.0
export const SPINE_MODERATE_HI = 16.0

/**
 * 整数取整，平局取偶（banker's rounding）。
 * 等价于后端 `services/rounding.py :: round_int`。
 *
 * ⚠️ 这两个 `py*` 函数**不是**在复刻 Python 内置 `round()` ——
 * 内置 round 是对 x 的**精确二进制值**做十进制舍入，JS 无法复刻
 * （实测会在平局点上分叉，见 `backend/services/rounding.py` 的说明）。
 * 它们是本项目**双方共同约定的**取整口径，后端也改用同一算法，
 * 因此两端逐位一致。改这里必须同步改 `rounding.py`。
 */
export function pyRound(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  // 恰好 .5：取偶数
  return floor % 2 === 0 ? floor : floor + 1
}

/** 保留一位小数，平局取偶。等价于后端 `services/rounding.py :: round_1`。 */
export function pyRound1(x: number): number {
  const scaled = x * 10
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  const r = diff > 0.5 ? floor + 1 : diff < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1
  return r / 10
}

/**
 * 单项扣分，分段与 issues 的三档严格一致。
 * 等价于 scorer.py 的 `metric_deduction()`。
 */
export function metricDeduction(value: number, threshold: number, mildHi: number, moderateHi: number): number {
  const excess = value - threshold
  if (excess <= 0) {
    // 未超标：仅在接近阈值时轻微扣分
    const zoneStart = threshold * WARN_ZONE_RATIO
    if (value <= zoneStart) return 0
    return (WARN_ZONE_MAX * (value - zoneStart)) / (threshold - zoneStart)
  }
  if (excess <= mildHi) {
    return MILD_BASE + (MILD_MAX - MILD_BASE) * (excess / mildHi)
  }
  if (excess <= moderateHi) {
    return MODERATE_BASE + (MODERATE_MAX - MODERATE_BASE) * ((excess - mildHi) / (moderateHi - mildHi))
  }
  return (
    SEVERE_BASE +
    Math.min(SEVERE_MAX - SEVERE_BASE, (SEVERE_MAX - SEVERE_BASE) * ((excess - moderateHi) / moderateHi))
  )
}
