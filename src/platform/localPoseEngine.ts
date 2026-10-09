import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision'
import type { Landmarks, PoseResult } from '../types'
import {
  HEAD_TILT_THRESHOLD,
  SHOULDER_DIFF_THRESHOLD,
  SPINE_ANGLE_THRESHOLD,
  SECONDARY_WEIGHT,
  SCORE_MIN,
  SCORE_MAX,
  HEAD_MILD_HI,
  HEAD_MODERATE_HI,
  SHOULDER_MILD_HI,
  SHOULDER_MODERATE_HI,
  SPINE_MILD_HI,
  SPINE_MODERATE_HI,
  pyRound,
  metricDeduction,
  exerciseScore,
  MODE_MONITOR,
  MODE_EXERCISE,
  type ScoreMode,
} from './scoringModel'

/**
 * 本地姿态引擎（移动端 / 纯浏览器）。
 *
 * 桌面版把摄像头帧通过 WebSocket 发给 Python 后端，由后端用 MediaPipe Python
 * 推理并计算角度与评分。移动端没有后端，这里用 `@mediapipe/tasks-vision`
 * 的 PoseLandmarker 在浏览器内直接推理。
 *
 * ⚠️ 关键：角度计算与评分逻辑必须与后端 `services/pose_detector.py` +
 * `services/scorer.py` **逐行等价**，即 landmark 索引、阈值、扣分公式完全一致，
 * 这样同一个姿势在手机和电脑上得到同样的分数。
 *
 * 后端 landmark 索引：
 *   NOSE=0  LEFT_EAR=7  RIGHT_EAR=8
 *   LEFT_SHOULDER=11  RIGHT_SHOULDER=12  LEFT_HIP=23  RIGHT_HIP=24
 */

// 引擎自身的参数。评分模型的阈值/分档/单项扣分/取整统一定义在 scoringModel.ts，
// 与统计聚合（partHealth）共用同一份，避免两处各写一遍后悄悄漂移。
import { PoseSmoother, EMA_ALPHA } from './poseSmoother'
import { measurePose, METRIC_VERSION } from './poseGeometry'

const NOSE = 0
const LEFT_EAR = 7
const RIGHT_EAR = 8
const LEFT_SHOULDER = 11
const RIGHT_SHOULDER = 12

/**
 * WASM 资源与模型走**本地打包**（public/mediapipe/），
 * 这样 APK 离线可用，不依赖首次联网下载。相对路径基于 Vite 的 base:'./'。
 */
const WASM_ROOT = new URL('mediapipe/wasm', document.baseURI).href
const MODEL_URL = new URL('mediapipe/models/pose_landmarker_full.task', document.baseURI).href

/**
 * 评分（与 scorer.py 等价）。
 *
 * `mode="monitor"`（默认）是静息坐姿评分，语义与历史版本一致；
 * `mode="exercise"` 走运动态通道（「这个动作做到位了吗」），见 scoringModel 的说明。
 * 不传 mode 时行为不变，所有既有调用点无需改动。
 */
function computeScore(head: number, shoulder: number, spine: number, mode: ScoreMode = MODE_MONITOR) {
  if (mode === MODE_EXERCISE) return exerciseScore(head, shoulder, spine)

  const headExcess = Math.max(0, head - HEAD_TILT_THRESHOLD)
  const shoulderExcess = Math.max(0, shoulder - SHOULDER_DIFF_THRESHOLD)
  const spineExcess = Math.max(0, spine - SPINE_ANGLE_THRESHOLD)

  // 运算顺序与 Python 保持一致，避免浮点尾差影响取整
  const deductions = [
    metricDeduction(head, HEAD_TILT_THRESHOLD, HEAD_MILD_HI, HEAD_MODERATE_HI),
    metricDeduction(shoulder, SHOULDER_DIFF_THRESHOLD, SHOULDER_MILD_HI, SHOULDER_MODERATE_HI),
    metricDeduction(spine, SPINE_ANGLE_THRESHOLD, SPINE_MILD_HI, SPINE_MODERATE_HI),
  ].sort((a, b) => b - a)
  const totalDeduction = deductions[0] + SECONDARY_WEIGHT * (deductions[1] + deductions[2])

  const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, pyRound(SCORE_MAX - totalDeduction)))

  const issues: string[] = []
  if (headExcess > 0) {
    if (headExcess > HEAD_MODERATE_HI) issues.push('头部严重侧倾')
    else if (headExcess > HEAD_MILD_HI) issues.push('头部明显侧倾')
    else issues.push('头部轻微侧倾')
  }
  if (shoulderExcess > 0) {
    if (shoulderExcess > SHOULDER_MODERATE_HI) issues.push('肩部严重不平衡')
    else if (shoulderExcess > SHOULDER_MILD_HI) issues.push('肩部明显不平衡')
    else issues.push('肩部略不平衡')
  }
  if (spineExcess > 0) {
    if (spineExcess > SPINE_MODERATE_HI) issues.push('脊柱严重倾斜')
    else if (spineExcess > SPINE_MILD_HI) issues.push('脊柱明显倾斜')
    else issues.push('脊柱轻微倾斜')
  }

  return { score, issues, head_angle: head, shoulder_diff: shoulder, spine_angle: spine }
}

/**
 * 姿态引擎：懒加载模型，对视频帧做推理并产出与后端一致的 PoseResult。
 */
export class LocalPoseEngine {
  private landmarker: PoseLandmarker | null = null
  private smoother = new PoseSmoother()
  private loading: Promise<void> | null = null
  private lastVideoTime = -1
  /** 上一次推理用的评分模式，用于在切换时清空平滑状态。 */
  private lastMode: ScoreMode | null = null
  private modelGeneration = 0
  private inferenceFailures = 0

  get ready(): boolean {
    return this.landmarker !== null
  }

  /** 初始化模型（幂等，可重复调用）。 */
  async init(): Promise<void> {
    if (this.landmarker) return
    if (this.loading) return this.loading
    const generation = this.modelGeneration
    const startedAt = performance.now()
    this.loading = (async () => {
      const vision = await FilesetResolver.forVisionTasks(WASM_ROOT)
      const baseOptions = { modelAssetPath: MODEL_URL }
      try {
        // 优先 GPU（WebGL）delegate，性能更好
        this.landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { ...baseOptions, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        })
      } catch (e) {
        // 部分安卓 WebView 不支持 GPU delegate，回退到 CPU（WASM）
        console.warn('[LocalPoseEngine] GPU delegate failed; falling back to CPU:', e)
        this.landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { ...baseOptions, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        })
      }
      if (generation !== this.modelGeneration) {
        this.landmarker?.close()
        this.landmarker = null
        throw new Error('Pose model initialization cancelled')
      }
      console.info('[LocalPoseEngine] Model initialized', { elapsed_ms: performance.now() - startedAt })
    })()
    try {
      await this.loading
    } finally {
      this.loading = null
    }
  }

  /**
   * 处理一帧视频。
   * @param video 视频元素
   * @param timestampMs 单调递增的时间戳（用 performance.now()）
   * @param mode 评分模式：`monitor`（静息坐姿，默认）或 `exercise`（活动中，
   *   问「这个动作做到位了吗」而不是「你对称吗」）。见 scoringModel 的说明。
   */
  detect(video: HTMLVideoElement, timestampMs: number, mode: ScoreMode = MODE_MONITOR): PoseResult | null {
    if (!this.landmarker) return null
    // 同一帧不重复推理
    if (video.currentTime === this.lastVideoTime) return null
    this.lastVideoTime = video.currentTime

    const ts = new Date().toISOString()
    const startedAt = performance.now()
    let result
    try {
      result = this.landmarker.detectForVideo(video, timestampMs)
    } catch (error) {
      this.smoother.reset()
      this.inferenceFailures += 1
      if (this.inferenceFailures === 1 || this.inferenceFailures % 30 === 0) console.error('[LocalPoseEngine] Inference failed', { mode, count: this.inferenceFailures, elapsed_ms: performance.now() - startedAt, error })
      return { type: 'no_pose', timestamp: ts, mode, reason: 'inference_error', message: 'Inference failed' }
    }
    if (this.inferenceFailures) console.info('[LocalPoseEngine] Inference recovered', { failures: this.inferenceFailures })
    this.inferenceFailures = 0

    const lms = result.landmarks?.[0]
    if (!lms || lms.length < 25) {
      this.smoother.reset()
      return { type: 'no_pose', timestamp: ts, mode, reason: 'no_person', message: 'No pose detected' }
    }

    // 逐指标检查：髋部不可测时仍展示头肩，但不给完整坐姿分。
    const W = video.videoWidth
    const H = video.videoHeight
    const measured = measurePose(lms, W, H)
    const pt = (lm: { x: number; y: number }) => ({ x: pyRound(lm.x * W * 10) / 10, y: pyRound(lm.y * H * 10) / 10 })
    const landmarks: Landmarks = {
      nose: pt(lms[NOSE]), left_ear: pt(lms[LEFT_EAR]), right_ear: pt(lms[RIGHT_EAR]),
      left_shoulder: pt(lms[LEFT_SHOULDER]), right_shoulder: pt(lms[RIGHT_SHOULDER]),
    }
    const raw = measured.metrics as Record<string, number>
    const minVis = Math.min(...Object.values(measured.quality).filter(q => q.valid).map(q => q.confidence), 1)

    // 切换模式时清空平滑状态：EMA 是跨帧的，不清空就会拿「运动中」的平滑值
    // 去评「静息态」（或反过来），表现为活动结束后约 1 秒内的虚假报警。
    // 与后端 camera_ws.py 的处理保持一致。
    if (this.lastMode !== mode) {
      this.smoother.reset()
      this.lastMode = mode
    }

    const smoothed = this.smoother.update(raw, timestampMs) as { head_angle: number; shoulder_diff: number; spine_angle: number }
    const scored = measured.complete ? computeScore(smoothed.head_angle, smoothed.shoulder_diff, smoothed.spine_angle, mode) : smoothed
    const type = measured.complete ? 'pose' : Object.keys(raw).length ? 'partial_pose' : 'no_pose'
    if (type === 'no_pose') this.smoother.reset()

    return {
      type,
      timestamp: ts,
      mode,
      metric_version: METRIC_VERSION,
      quality: measured.quality,
      frame_width: W,
      frame_height: H,
      reason: type === 'no_pose' ? 'invalid_measurement' : undefined,
      ...scored,
      visibility: pyRound(minVis * 1000) / 1000,
      landmarks,
    }
  }

  /** 复用模型，清空属于摄像头会话的状态。 */
  invalidateResult() {
    // 超时保留帧去重记录，不能把冻结画面再次推理成“新鲜”结果。
    this.smoother.reset()
    this.lastMode = null
  }

  resetSession() {
    this.lastVideoTime = -1
    this.inferenceFailures = 0
    this.invalidateResult()
  }

  close() {
    this.modelGeneration += 1
    this.landmarker?.close()
    this.landmarker = null
    this.resetSession()
  }
}

export const localPoseEngine = new LocalPoseEngine()
