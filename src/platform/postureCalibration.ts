import type { PoseResult } from '../types'
import { METRIC_VERSION, type MetricName } from './poseGeometry'
import { HEAD_TILT_THRESHOLD, SHOULDER_DIFF_THRESHOLD, SPINE_ANGLE_THRESHOLD } from './scoringModel'

export const BASELINE_KEY = 'neckguardian.posture-baseline.v1'
export const CALIBRATION_MS = 10_000
export const CALIBRATION_TIMEOUT_MS = 20_000
const NAMES: MetricName[] = ['head_angle', 'shoulder_diff', 'spine_angle']
const LIMITS = [HEAD_TILT_THRESHOLD, SHOULDER_DIFF_THRESHOLD, SPINE_ANGLE_THRESHOLD]
const MAD_LIMITS = [.6, .8, .8]
const RANGE_LIMITS = [2, 2.5, 3]
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
type Metrics = Record<MetricName, number>
export type CameraProfile = { key: string; aspect: number }
export type PostureBaseline = {
  baseline_version: 1; metric_version: number; camera: CameraProfile; created_at: number
  samples: number; duration_ms: number; center: Metrics; mad: Metrics
}
export type CalibrationState = { progress: number; message: string; baseline?: PostureBaseline; finished?: boolean }
const median = (values: number[]) => quantile(values, .5)
function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (sorted.length - 1) * q, lo = Math.floor(at)
  return sorted[lo] + (sorted[Math.ceil(at)] - sorted[lo]) * (at - lo)
}

/** 只接受当前测量版本、完整高质量、静息且未超过通用提醒线的原始特征。 */
function neutralMetrics(result: PoseResult, camera: CameraProfile): Metrics | null {
  if (result.type !== 'pose' || result.mode === 'exercise' || result.metric_version !== METRIC_VERSION) return null
  if (!result.frame_width || !result.frame_height || Math.abs(result.frame_width / result.frame_height - camera.aspect) > .02) return null
  for (const [i, name] of NAMES.entries()) {
    const quality = result.quality?.[name], value = result.signed_metrics?.[name]
    if (!quality?.valid || !Number.isFinite(quality.confidence) || quality.confidence < .8 ||
        !Number.isFinite(value) || Math.abs(value!) > LIMITS[i]) return null
  }
  return { ...result.signed_metrics } as Metrics
}

/** 固定时长窗口；不把掉帧间隔或旧帧算作保持时间，最多保留约 100 个样本。 */
export class PostureCalibrator {
  private samples: { t: number; value: Metrics }[] = []
  private lastTime = -Infinity
  private lastFrame: string | null = null
  constructor(private camera: CameraProfile, private startedAt: number) {
    console.info('[PostureCalibration] Collection started', { duration_ms: CALIBRATION_MS, confidence_min: .8 })
  }
  push(result: PoseResult, now: number, wallTime = Date.now()): CalibrationState {
    if (!Number.isFinite(now) || now < this.lastTime || now < this.startedAt) {
      this.samples = []; this.lastFrame = null; this.lastTime = now
      return { progress: 0, message: '采样时序变化，请重新开始校准', finished: true }
    }
    if (now - this.startedAt >= CALIBRATION_TIMEOUT_MS) {
      console.warn('[PostureCalibration] Collection timed out', { samples: this.samples.length, elapsed_ms: now - this.startedAt })
      return { progress: 0, message: '未获得连续稳定样本，请调整机位后重试', finished: true }
    }
    const value = neutralMetrics(result, this.camera)
    const frame = result.frame_id !== undefined ? `${result.session_id}:${result.frame_id}` : result.timestamp
    // 重复回包先拒绝，不能借一次大间隔清空去重状态后重新采纳冻结帧。
    if (value && frame === this.lastFrame) return this.progress()
    if (!value || (this.samples.length && now - this.lastTime > 600)) {
      if (this.samples.length) console.info('[PostureCalibration] Window reset', { reason: value ? 'frame_gap' : 'invalid_neutral_pose', samples: this.samples.length })
      this.samples = []
    }
    if (!value) return { progress: 0, message: '请摆正摄像头，头、肩和髋部入镜，保持自然坐直' }
    // 帧编号优先；本地结果时间戳用于识别同一回包，页面重渲染不能增加样本。
    if (now - this.lastTime < 100) return this.progress()
    this.lastFrame = frame; this.lastTime = now
    this.samples.push({ t: now, value })
    const elapsed = now - this.samples[0].t
    if (elapsed < CALIBRATION_MS || this.samples.length < 30) return this.progress()
    const center = {} as Metrics, mad = {} as Metrics
    const stability = NAMES.map((name, i) => {
      const values = this.samples.map(s => s.value[name])
      center[name] = median(values)
      mad[name] = median(values.map(v => Math.abs(v - center[name])))
      return mad[name] <= MAD_LIMITS[i] && quantile(values, .9) - quantile(values, .1) <= RANGE_LIMITS[i]
    })
    if (!stability.every(Boolean)) {
      console.warn('[PostureCalibration] Unstable window rejected', { elapsed_ms: elapsed, samples: this.samples.length, mad })
      this.samples = []; this.lastFrame = null
      return { progress: 0, message: '姿势波动较大，请保持坐直并减少移动' }
    }
    const baseline: PostureBaseline = { baseline_version: 1, metric_version: METRIC_VERSION, camera: { ...this.camera },
      created_at: wallTime, samples: this.samples.length, duration_ms: elapsed, center, mad }
    console.info('[PostureCalibration] Collection completed', { elapsed_ms: elapsed, samples: baseline.samples, center, mad })
    return { progress: 1, message: '个人基线已建立', baseline, finished: true }
  }
  private progress(): CalibrationState {
    return { progress: this.samples.length ? Math.min(1, (this.lastTime - this.samples[0].t) / CALIBRATION_MS) : 0,
      message: '保持自然坐直，正在采集稳定姿势…' }
  }
}

/** 本机机位专属配置不随健康备份迁移；版本、期限和内容不可信时直接拒绝。 */
export function parseBaseline(raw: string | null, now = Date.now()): PostureBaseline | null {
  try {
    if (!raw || raw.length > 4096) return null
    const b = JSON.parse(raw) as PostureBaseline
    if (b.baseline_version !== 1 || b.metric_version !== METRIC_VERSION || !b.camera || typeof b.camera.key !== 'string' ||
        !b.camera.key || b.camera.key.length > 512 || !Number.isFinite(b.camera.aspect) || b.camera.aspect <= 0 ||
        !Number.isFinite(b.created_at) || b.created_at > now || now - b.created_at > MAX_AGE_MS ||
        !Number.isInteger(b.samples) || b.samples < 30 || b.samples > 102 ||
        !Number.isFinite(b.duration_ms) || b.duration_ms < CALIBRATION_MS || b.duration_ms >= CALIBRATION_TIMEOUT_MS) return null
    if (!NAMES.every((name, i) => Number.isFinite(b.center?.[name]) && Math.abs(b.center[name]) <= LIMITS[i] &&
        Number.isFinite(b.mad?.[name]) && b.mad[name] >= 0 && b.mad[name] <= MAD_LIMITS[i])) return null
    return b
  } catch { return null }
}

export function cameraMatches(baseline: PostureBaseline, camera: CameraProfile): boolean {
  return baseline.camera.key === camera.key && Math.abs(baseline.camera.aspect - camera.aspect) <= .02
}

/** 相对变化与通用健康分并列展示；保留正负方向，绝不改写入库分数或活动幅度。 */
export function baselineDeviation(baseline: PostureBaseline, result: PoseResult, camera: CameraProfile): Metrics | null {
  if (!cameraMatches(baseline, camera) || result.type !== 'pose' || result.mode === 'exercise' ||
      result.metric_version !== METRIC_VERSION || !result.frame_width || !result.frame_height ||
      Math.abs(result.frame_width / result.frame_height - camera.aspect) > .02) return null
  if (!NAMES.every(name => result.quality?.[name]?.valid && Number.isFinite(result.quality[name].confidence) &&
      result.quality[name].confidence >= .8 && Number.isFinite(result.signed_metrics?.[name]))) return null
  return Object.fromEntries(NAMES.map(name => [name, Number((result.signed_metrics![name]! - baseline.center[name]).toFixed(2))])) as Metrics
}
