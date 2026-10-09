import { pyRound } from './scoringModel'

/** 测量版本与评分公式版本独立：v2 修正非方形画面的几何并拒绝低可信输入。 */
export const METRIC_VERSION = 2
export const MIN_VISIBILITY = 0.5
export type PosePoint = { x: number; y: number; visibility?: number; presence?: number }
export type MetricName = 'head_angle' | 'shoulder_diff' | 'spine_angle'
export type InvalidReason = 'low_visibility' | 'out_of_frame' | 'non_finite' | 'degenerate_geometry'
export type MetricQuality = { valid: boolean; confidence: number; reason?: InvalidReason }
export const METRIC_POINTS: Record<MetricName, number[]> = {
  head_angle: [7, 8], shoulder_diff: [11, 12], spine_angle: [11, 12, 23, 24],
}

/** 使用原始画面像素比例；归一化坐标的横纵轴不能直接比较。 */
export function headTiltAngle(a: PosePoint, b: PosePoint, width = 640, height = 480): number | undefined {
  const dx = Math.abs(b.x - a.x)
  if (dx < 0.03) return undefined
  // 可信的大幅侧屈保留原值，不把超过 30° 的运动误记为健康的 0°。
  return Math.atan2(Math.abs(b.y - a.y) * height, dx * width) * 180 / Math.PI
}

export function shoulderRatio(a: PosePoint, b: PosePoint, width = 640, height = 480): number | undefined {
  const dx = Math.abs(b.x - a.x)
  if (dx < 0.01) return undefined
  return Math.abs(b.y - a.y) * height / (dx * width) * 100
}

export function spineAngle(a: PosePoint, b: PosePoint, c: PosePoint, d: PosePoint, width = 640, height = 480): number | undefined {
  const dx = (c.x + d.x - a.x - b.x) / 2
  const dy = (c.y + d.y - a.y - b.y) / 2
  if (dy < 0.001) return undefined
  return Math.abs(Math.atan2(dx * width, dy * height) * 180 / Math.PI)
}

export function measurePose(points: PosePoint[], width: number, height: number) {
  const metrics: Partial<Record<MetricName, number>> = {}
  // 带方向的原始特征只供个人基线使用，不进入原有绝对值评分与 EMA。
  const signed_metrics: Partial<Record<MetricName, number>> = {}
  const quality = {} as Record<MetricName, MetricQuality>
  const dimensionsValid = Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
  for (const name of Object.keys(METRIC_POINTS) as MetricName[]) {
    const p = METRIC_POINTS[name].map(i => points[i])
    let reason: InvalidReason | undefined
    const confidence = Math.min(...p.map(v => Number.isFinite(v?.visibility) ? v.visibility! : 0))
    if (!dimensionsValid || p.some(v => !v || !Number.isFinite(v.x) || !Number.isFinite(v.y))) reason = 'non_finite'
    else if (p.some(v => v.x < 0 || v.x > 1 || v.y < 0 || v.y > 1)) reason = 'out_of_frame'
    else if (confidence < MIN_VISIBILITY || p.some(v => v.presence !== undefined && (!Number.isFinite(v.presence) || v.presence < MIN_VISIBILITY))) reason = 'low_visibility'
    if (reason) {
      quality[name] = { valid: false, confidence, reason }
      continue
    }
    const value = name === 'head_angle' ? headTiltAngle(p[0], p[1], width, height)
      : name === 'shoulder_diff' ? shoulderRatio(p[0], p[1], width, height)
      : spineAngle(p[0], p[1], p[2], p[3], width, height)
    if (value === undefined || !Number.isFinite(value)) quality[name] = { valid: false, confidence, reason: 'degenerate_geometry' }
    else {
      metrics[name] = pyRound(value * 100) / 100
      // 复用已测量的幅度，只补方向，避免再次计算三角函数及双口径漂移。
      const direction = name === 'spine_angle'
        ? p[2].x + p[3].x - p[0].x - p[1].x
        : (p[1].y - p[0].y) / (p[1].x - p[0].x)
      const signed = direction < 0 ? -value : value
      signed_metrics[name] = pyRound(signed * 100) / 100 || 0
      quality[name] = { valid: true, confidence }
    }
  }
  return { metrics, signed_metrics, quality, complete: Object.keys(metrics).length === 3 }
}
