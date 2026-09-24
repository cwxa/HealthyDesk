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
const MIN_VISIBILITY = 0.5
const EMA_ALPHA = 0.35

const NOSE = 0
const LEFT_EAR = 7
const RIGHT_EAR = 8
const LEFT_SHOULDER = 11
const RIGHT_SHOULDER = 12
const LEFT_HIP = 23
const RIGHT_HIP = 24
const CHECK_LANDMARKS = [NOSE, LEFT_EAR, RIGHT_EAR, LEFT_SHOULDER, RIGHT_SHOULDER]

/**
 * WASM 资源与模型走**本地打包**（public/mediapipe/），
 * 这样 APK 离线可用，不依赖首次联网下载。相对路径基于 Vite 的 base:'./'。
 */
const WASM_ROOT = new URL('mediapipe/wasm', document.baseURI).href
const MODEL_URL = new URL('mediapipe/models/pose_landmarker_full.task', document.baseURI).href

type LM = { x: number; y: number; z: number; visibility?: number }

/** 指数滑动平均，抑制帧间抖动（对应后端 PoseSmoother）。 */
class PoseSmoother {
  private values: Record<string, number> | null = null
  private alpha = EMA_ALPHA

  update(metrics: Record<string, number>): Record<string, number> {
    if (this.values === null) {
      this.values = { ...metrics }
      return { ...this.values }
    }
    const smoothed: Record<string, number> = {}
    for (const k of Object.keys(metrics)) {
      if (typeof metrics[k] === 'number' && k in this.values) {
        smoothed[k] = pyRound((this.alpha * metrics[k] + (1 - this.alpha) * this.values[k]) * 100) / 100
        this.values[k] = smoothed[k]
      } else {
        smoothed[k] = metrics[k]
      }
    }
    return smoothed
  }

  reset() {
    this.values = null
  }
}

// ---- 角度计算（与 pose_detector.py 等价） ----

function headTiltAngle(leftEar: LM, rightEar: LM): number {
  const dx = Math.abs(rightEar.x - leftEar.x)
  const dy = Math.abs(rightEar.y - leftEar.y)
  if (dx < 0.03) return 0
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  if (angle > 30) return 0
  return angle
}

function shoulderRatio(leftShoulder: LM, rightShoulder: LM): number {
  const width = Math.abs(leftShoulder.x - rightShoulder.x)
  if (width < 0.01) return 0
  const dy = Math.abs(leftShoulder.y - rightShoulder.y)
  return (dy / width) * 100
}

function spineAngle(leftShoulder: LM, rightShoulder: LM, leftHip: LM, rightHip: LM): number {
  const sMidX = (leftShoulder.x + rightShoulder.x) / 2
  const sMidY = (leftShoulder.y + rightShoulder.y) / 2
  const hMidX = (leftHip.x + rightHip.x) / 2
  const hMidY = (leftHip.y + rightHip.y) / 2
  const dx = hMidX - sMidX
  const dy = hMidY - sMidY
  if (dy < 0.001) return 90
  return Math.abs((Math.atan2(dx, dy) * 180) / Math.PI)
}

/** 评分（与 scorer.py 等价）。 */
function computeScore(head: number, shoulder: number, spine: number) {
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

  get ready(): boolean {
    return this.landmarker !== null
  }

  /** 初始化模型（幂等，可重复调用）。 */
  async init(): Promise<void> {
    if (this.landmarker) return
    if (this.loading) return this.loading
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
        console.warn('[LocalPoseEngine] GPU delegate 初始化失败，回退 CPU：', e)
        this.landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { ...baseOptions, delegate: 'CPU' },
          runningMode: 'VIDEO',
          numPoses: 1,
          minPoseDetectionConfidence: 0.5,
          minPosePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        })
      }
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
   */
  detect(video: HTMLVideoElement, timestampMs: number): PoseResult | null {
    if (!this.landmarker) return null
    // 同一帧不重复推理
    if (video.currentTime === this.lastVideoTime) return null
    this.lastVideoTime = video.currentTime

    const ts = new Date().toISOString()
    let result
    try {
      result = this.landmarker.detectForVideo(video, timestampMs)
    } catch {
      return null
    }

    const lms = result.landmarks?.[0]
    if (!lms || lms.length < 25) {
      this.smoother.reset()
      return { type: 'no_pose', timestamp: ts, message: 'No pose detected' }
    }

    // 可见性检查：关键点任一低于阈值即视为未检测到（与后端一致）
    const vis = CHECK_LANDMARKS.map((i) => lms[i]?.visibility ?? 0)
    const minVis = Math.min(...vis)
    if (minVis < MIN_VISIBILITY) {
      this.smoother.reset()
      return { type: 'no_pose', timestamp: ts, message: 'No pose detected' }
    }

    // 归一化坐标 -> 像素坐标（640x480，与后端输出的 landmarks 口径一致）
    const W = 640
    const H = 480
    const pt = (lm: LM) => ({ x: pyRound(lm.x * W * 10) / 10, y: pyRound(lm.y * H * 10) / 10 })

    const landmarks: Landmarks = {
      nose: pt(lms[NOSE]),
      left_ear: pt(lms[LEFT_EAR]),
      right_ear: pt(lms[RIGHT_EAR]),
      left_shoulder: pt(lms[LEFT_SHOULDER]),
      right_shoulder: pt(lms[RIGHT_SHOULDER]),
    }

    const raw = {
      head_angle: pyRound(headTiltAngle(lms[LEFT_EAR], lms[RIGHT_EAR]) * 100) / 100,
      shoulder_diff: pyRound(shoulderRatio(lms[LEFT_SHOULDER], lms[RIGHT_SHOULDER]) * 100) / 100,
      spine_angle: pyRound(spineAngle(lms[LEFT_SHOULDER], lms[RIGHT_SHOULDER], lms[LEFT_HIP], lms[RIGHT_HIP]) * 100) / 100,
    }

    const smoothed = this.smoother.update(raw) as { head_angle: number; shoulder_diff: number; spine_angle: number }
    const scored = computeScore(smoothed.head_angle, smoothed.shoulder_diff, smoothed.spine_angle)

    return {
      type: 'pose',
      timestamp: ts,
      ...scored,
      visibility: pyRound(minVis * 1000) / 1000,
      landmarks,
    }
  }

  close() {
    this.landmarker?.close()
    this.landmarker = null
    this.smoother.reset()
  }
}

export const localPoseEngine = new LocalPoseEngine()
