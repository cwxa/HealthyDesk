import { useCallback, useEffect, useRef, useState } from 'react'
import { hasLocalBackend } from '../platform/runtime'
import { useWebSocket } from './useWebSocket'
import { localPoseEngine } from '../platform/localPoseEngine'
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

  const [connected, setConnected] = useState(false)
  const [poseResult, setPoseResult] = useState<PoseResult | null>(null)
  const [backendError, setBackendError] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement | null>(null)
  const rafRef = useRef<number>(0)
  const onPoseRef = useRef<((r: PoseResult) => void) | null>(null)
  const runningRef = useRef(false)

  const emit = useCallback((r: PoseResult) => {
    setPoseResult(r)
    onPoseRef.current?.(r)
  }, [])

  // ---- 桌面端：直接复用 useWebSocket ----
  useEffect(() => {
    if (!useLocal) {
      setConnected(ws.connected)
      setPoseResult(ws.poseResult)
      setBackendError(ws.backendError)
    }
  }, [useLocal, ws.connected, ws.poseResult, ws.backendError])

  useEffect(() => {
    if (useLocal) return
    ws.onPoseResult((r) => onPoseRef.current?.(r))
  }, [useLocal, ws])

  // ---- 移动端：本地推理循环 ----
  const localLoop = useCallback(() => {
    if (!runningRef.current) return
    const video = videoRef.current
    if (video && video.readyState >= 2) {
      const r = localPoseEngine.detect(video, performance.now())
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
    const r = localPoseEngine.detect(video, performance.now())
    if (r) emit(r)
  }, [emit])

  /** 绑定视频元素并启动本地推理（移动端）。 */
  const attachVideo = useCallback(async (video: HTMLVideoElement) => {
    videoRef.current = video
    if (!useLocal) return
    setConnected(false)
    setBackendError(null)
    try {
      await localPoseEngine.init()
      // 安卓 WebView 中 video 未必自动播放，需显式 play() 并等待就绪
      try {
        await video.play()
      } catch {
        // 若被浏览器策略拦截，可依赖用户手势触发；不影响后续 readyState 轮询
      }
      runningRef.current = true
      setConnected(true)
      emit({ type: 'ready', timestamp: new Date().toISOString(), message: '本地姿态引擎就绪' })
      rafRef.current = requestAnimationFrame(localLoop)
      // 兜底：部分 WebView 在后台/未聚焦时会节流 rAF，
      // 用 timeupdate 事件保证视频有新画面时至少处理一次
      video.addEventListener('timeupdate', onVideoTimeUpdate)
    } catch (e) {
      console.error('Local pose engine init failed:', e)
      setBackendError('本地姿态模型加载失败，请检查网络后重试')
      setConnected(false)
    }
  }, [useLocal, localLoop, emit, onVideoTimeUpdate])

  const stop = useCallback(() => {
    runningRef.current = false
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    rafRef.current = 0
    videoRef.current?.removeEventListener('timeupdate', onVideoTimeUpdate)
    if (useLocal) {
      setConnected(false)
    } else {
      ws.disconnect()
    }
  }, [useLocal, ws, onVideoTimeUpdate])

  const resetBackendError = useCallback(() => {
    setBackendError(null)
    if (useLocal) {
      // 重新初始化本地引擎
      const video = videoRef.current
      if (video) attachVideo(video)
    } else {
      ws.resetBackendError()
      ws.connect()
    }
  }, [useLocal, ws, attachVideo])

  const onPoseResult = useCallback((cb: (r: PoseResult) => void) => {
    onPoseRef.current = cb
  }, [])

  useEffect(() => {
    return () => {
      runningRef.current = false
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [])

  return {
    connected,
    poseResult,
    backendError,
    resetBackendError,
    onPoseResult,
    attachVideo,
    stop,
    /** 兼容桌面端旧签名 */
    connect: ws.connect,
    disconnect: ws.disconnect,
    sendFrame: ws.sendFrame,
    isLocal: useLocal,
  }
}
