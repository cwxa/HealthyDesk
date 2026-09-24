import {
  HEAD_MILD_HI,
  HEAD_MODERATE_HI,
  HEAD_TILT_THRESHOLD,
  SHOULDER_DIFF_THRESHOLD,
  SHOULDER_MILD_HI,
  SHOULDER_MODERATE_HI,
  SPINE_ANGLE_THRESHOLD,
  SPINE_MILD_HI,
  SPINE_MODERATE_HI,
  metricDeduction,
  pyRound1,
} from './scoringModel'

/**
 * 部位健康度（移动端）—— `backend/services/part_health.py` 的逐位等价实现。
 *
 * 口径（与后端单点定义一致）：
 *
 *     某部位健康度 = 该部位在窗口内每一帧的「单项得分」的算术平均
 *     单项得分     = 100 − metricDeduction(该部位角度, 该部位阈值, 该部位档位边界)
 *
 * 为什么用「单项得分」而不是总分：总分是三档加权合成（最差项算满 + 其余 × 0.3），
 * 一个部位差会连带压低另外两项的呈现，三个部位之间就不可比了。
 *
 * ⚠️ 改动本文件必须同步改 `backend/services/part_health.py`，并跑
 * `npm run verify:parity`（`verify-part-health.mjs` 会逐条对拍两端结果）。
 */

export interface PartHealth {
  head: number | null
  shoulder: number | null
  spine: number | null
}

/** 聚合所需的采样字段（`posture_score` 的三个分项）。 */
export interface PartHealthInput {
  head_angle: number
  shoulder_diff: number
  spine_angle: number
}

/** (输出字段, 数据字段, 阈值, 轻微上界, 明显上界) —— 与 scorer 的三项一一对应。 */
const PARTS: ReadonlyArray<readonly [keyof PartHealth, keyof PartHealthInput, number, number, number]> = [
  ['head', 'head_angle', HEAD_TILT_THRESHOLD, HEAD_MILD_HI, HEAD_MODERATE_HI],
  ['shoulder', 'shoulder_diff', SHOULDER_DIFF_THRESHOLD, SHOULDER_MILD_HI, SHOULDER_MODERATE_HI],
  ['spine', 'spine_angle', SPINE_ANGLE_THRESHOLD, SPINE_MILD_HI, SPINE_MODERATE_HI],
]

/**
 * 把姿态采样聚合为三个部位健康度（0–100，一位小数）。
 *
 * ⚠️ 窗口内**没有任何采样**时返回全 `null`，而不是 0 —— 调用方据此显示
 * 「暂无数据」。用 0 会被误读成「部位健康度为 0（极差）」，这与「没有数据」
 * 是两件完全不同的事。
 */
export function computePartHealth(rows: PartHealthInput[]): PartHealth {
  if (rows.length === 0) {
    return { head: null, shoulder: null, spine: null }
  }

  const out: PartHealth = { head: null, shoulder: null, spine: null }
  for (const [key, field, threshold, mildHi, moderateHi] of PARTS) {
    let total = 0
    // 显式按下标顺序累加：浮点加法的结合顺序会影响末位，
    // 后端 Python 也以完全相同的顺序累加，否则 `round(x, 1)` 可能差 0.1。
    for (let i = 0; i < rows.length; i++) {
      total += 100 - metricDeduction(rows[i][field], threshold, mildHi, moderateHi)
    }
    out[key] = pyRound1(total / rows.length)
  }
  return out
}
