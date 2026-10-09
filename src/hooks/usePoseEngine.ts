import { useCallback, useEffect, useRef, useState } from 'react'
import { hasLocalBackend } from '../platform/runtime'
import { useWebSocket } from './useWebSocket'
import { localPoseEngine } from '../platform/localPoseEngine'
import { MODE_MONITOR, type ScoreMode } from '../platform/scoringModel'
import { withTimeout } from '../utils/withTimeout'
import type { PoseResult } from '../types'

/**
 * 统一姿态检测 hook。
 *
 * 对上层组件（NeckActivity）暴露与 `useWebSocket` 相同的接口，
 * 内部按平台分流：
 *   - 桌面端：转发到 WebSocket（Python 后端推理）
 *   - 移动端：本地 LocalPoseEngine 推理，视频帧不出设备
 *
 * 这样 NeckActivity 只需把 `useWebSocket()` 换成 `usePoseEngine()`，
 * 其余逻辑（评分展示、活动记录、语音提示）完全不用改。
 */
export function usePoseEngine() {
  const useLocal = !hasLocalBackend()
  const ws = useWebSocket()

  // ⚠️ 必须把用到的成员单独取出来依赖。
  // `useWebSocket()` 每次渲染返回的是**新的对象字面量**，若把 `ws` 整个写进依赖数组，
  // 下游所有 useCallback 都会每渲染失效 → NeckActivity 的挂载 effect 每渲染重跑一次
  // → 反复「掐掉摄像头再重新取流」，表现为永远卡在「正在启动摄像头...」。
  const wsConnect = ws.connect
  const wsDisconnect = ws.disconnect
  const wsSendFrame = ws.sendFrame
  const wsResetBackendError = ws.resetBackendError
  const wsOnPoseResult = ws.onPoseResult
  const wsConnected = ws.connected
  const wsPoseResult = ws.poseResult
  const wsBackendError = ws.backendError

  const [connected, setConnected] = useState(false)
  const [poseResult, setPoseResult] = useState<PoseResult | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const rafRef = useRef<number>(0)
  const onPoseRef = useRef<((r: PoseResult) => void) | null>(null)
  const runningRef = useRef(false)
  const generationRef = useRef(0)
  const lastInferenceRef = useRef(0)
  const lastResultAtRef = useRef(0)
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null)
  /**
   * 当前评分模式。用 ref 而不是 state：推理循环（移动端 rAF / 桌面端定时发帧）
   * 不该因为模式切换而重建 —— 重建循环会掐掉正在跑的摄像头链路。
   */
  const modeRef = useRef<ScoreMode>(MODE_MONITOR)

  const emit = useCallback((r: PoseResult) => {
    lastResultAtRef.current = performance.now()
    setPoseResult(r)
    onPoseRef.current?.(r)
  }, [])

  // ---- 桌面端：直接复用 useWebSocket ----
  useEffect(() => {
    if (!useLocal) {
      setConnected(wsConnected)
      setPoseResult(wsPoseResult?.mode && wsPoseResult.mode !== modeRef.current ? null : wsPoseResult)
      setBackendError(wsBackendError)
    }
  }, [useLocal, wsConnected, wsPoseResult, wsBackendError])

  useEffect(() => {
    if (useLocal) return
    wsOnPoseResult((r) => {
      // 旧模式的在途结果不能进入新模式的记录通道。
      if (r.mode && r.mode !== modeRef.current) return
      onPoseRef.current?.(r)
    })
  }, [useLocal, wsOnPoseResult])

  // ---- 移动端：本地推理循环 ----
  const localLoop = useCallback(() => {
    if (!runningRef.current) return
    const video = videoRef.current
    const now = performance.now()
    if (!document.hidden && video && video.readyState >= 2 && now - lastInferenceRef.current >= 100) {
      lastInferenceRef.current = now
      const r = localPoseEngine.detect(video, now, modeRef.current)
      if (r) emit(r)
    }
    rafRef.current = requestAnimationFrame(localLoop)
  }, [emit])

  /** rAF 被节流时的兜底推理入口（安卓 WebView 后台/降频场景）。 */
  const onVideoTimeUpdate = useCallback(() => {
    if (!runningRef.current) return
    const video = videoRef.current
    if (!video || video.readyState < 2) return
    if (document.hidden) return
    const now = performance.now()
    if (now - lastInferenceRef.current < 100) return
    lastInferenceRef.current = now
    const r = localPoseEngine.detect(video, now, modeRef.current)
    if (r) emit(r)
  }, [emit])

  /** 一处负责使异步启动失效、取消调度、清理旧视频与会话指标。 */
  const cleanupLocal = useCallback(() => {
    generationRef.current += 1
    runningRef.current = false
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    if (watchdogRef.current) clearInterval(watchdogRef.current)
    watchdogRef.current = null
    videoRef.current?.removeEventListener('timeupdate', onVideoTimeUpdate)
    localPoseEngine.resetSession()
    lastInferenceRef.current = 0
    console.info('[PoseEngine] Session stopped', { generation: generationRef.current })
  }, [onVideoTimeUpdate])

  /** 绑定视频元素并启动本地推理（移动端）。 */
  const attachVideo = useCallback(async (video: HTMLVideoElement) => {
    if (useLocal) cleanupLocal()
    videoRef.current = video
    if (!useLocal) return
    const generation = generationRef.current
    const startedAt = performance.now()
    setConnected(false)
    setBackendError(null)
    try {
      // 模型来自本地打包资源（apk 内 mediapipe/），加超时避免加载失败时无限等待
      await withTimeout(localPoseEngine.init(), 45000, '姿态模型加载')
      if (generation !== generationRef.current) return
      // 安卓 WebView 中 video 未必自动播放；不阻塞主流程，本地引擎按 readyState 取帧
      void Promise.resolve(video.play()).catch(() => {})
      runningRef.current = true
      setConnected(true)
      emit({ type: 'ready', timestamp: new Date().toISOString(), message: '本地姿态引擎就绪' })
      rafRef.current = requestAnimationFrame(localLoop)
      // 兜底：部分 WebView 在后台/未聚焦时会节流 rAF，
      // 用 timeupdate 事件保证视频有新画面时至少处理一次
      video.addEventListener('timeupdate', onVideoTimeUpdate)
      // 视频停滞或页面隐藏时，不让最后一帧的好分永久留在界面上。
      watchdogRef.current = setInterval(() => {
        if (runningRef.current && performance.now() - lastResultAtRef.current > 1500) {
          localPoseEngine.invalidateResult()
          emit({ type: 'no_pose', timestamp: new Date().toISOString(), mode: modeRef.current, reason: 'expired', message: 'Pose result expired' })
        }
      }, 500)
      console.info('[PoseEngine] Session started', { generation, elapsed_ms: performance.now() - startedAt })
    } catch (e) {
      if (generation !== generationRef.current) return
      const name = (e as { name?: string })?.name ?? 'Error'
      console.error('Local pose engine init failed:', e)
      setBackendError(
        name === 'TimeoutError' ? '本地姿态模型加载超时，请重试' : '本地姿态模型加载失败，请重试'
      )
      setConnected(false)
    }
  }, [useLocal, localLoop, emit, onVideoTimeUpdate, cleanupLocal])

  const stop = useCallback(() => {
    if (useLocal) cleanupLocal()
    if (useLocal) {
      setConnected(false)
      setPoseResult(null)
      onPoseRef.current?.({ type: 'no_pose', timestamp: new Date().toISOString(), reason: 'expired', message: 'Camera session stopped' })
    } else {
      wsDisconnect()
    }
  }, [useLocal, wsDisconnect, cleanupLocal])

  const resetBackendError = useCallback(() => {
    setBackendError(null)
    if (useLocal) {
      // 重新初始化本地引擎
      const video = videoRef.current
      if (video) attachVideo(video)
    } else {
      wsResetBackendError()
      wsConnect()
    }
  }, [useLocal, wsResetBackendError, wsConnect, attachVideo])

  const onPoseResult = useCallback((cb: (r: PoseResult) => void) => {
    onPoseRef.current = cb
  }, [])

  /**
   * 切换评分模式（静息坐姿 / 活动中）。
   *
   * 页面在「开始活动」「结束活动」时调用。写进 ref 而非 state：模式切换不应触发
   * 重渲染，更不应重建推理循环 —— 那会掐掉正在跑的摄像头链路。
   */
  const setScoreMode = useCallback((m: ScoreMode) => {
    if (m !== modeRef.current) emit({ type: 'no_pose', timestamp: new Date().toISOString(), mode: m, reason: 'mode_changed', message: 'Pose mode changed' })
    modeRef.current = m
  }, [emit])

  /**
   * 发帧时带上当前模式。
   * 桌面端的评分由 Python 后端算，后端必须知道用户此刻在做什么，
   * 否则会拿「你对称吗」去评「正在做康复动作的人」。
   */
  const sendFrame = useCallback(
    (base64Data: string) => wsSendFrame(base64Data, modeRef.current),
    [wsSendFrame],
  )

  useEffect(() => {
    return () => {
      if (useLocal) cleanupLocal()
      onPoseRef.current = null
    }
  }, [useLocal, cleanupLocal])

  return {
    connected,
    poseResult,
    backendError,
    resetBackendError,
    onPoseResult,
    attachVideo,
    stop,
    setScoreMode,
    /** 兼容桌面端旧签名 */
    connect: wsConnect,
    disconnect: wsDisconnect,
    sendFrame,
    isLocal: useLocal,
  }
}
