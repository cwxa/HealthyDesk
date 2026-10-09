import { useEffect, useRef, useState, useCallback } from 'react'
import type { PoseResult } from '../types'
import { MODE_MONITOR, type ScoreMode } from '../platform/scoringModel'

const WS_URL = 'ws://127.0.0.1:18920/ws/camera'
const RECONNECT_BASE_DELAY = 1000
const RECONNECT_MAX_DELAY = 10000

// 提醒弹窗统一走 Electron IPC 轮询（electron/main.ts -> /api/reminder/status ->
// 'reminder-trigger'），以便保留操作系统级通知且只有单一触发来源。
// 本 hook 只负责传递姿势数据，不再处理 reminder 消息。
export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const [poseResult, setPoseResult] = useState<PoseResult | null>(null)
  // 后端在 WebSocket 上主动报告的错误（如 MediaPipe 初始化失败）。
  // 与「网络断开」区分开：这类错误重连也修不好，必须提示用户而不是静默重试。
  const [backendError, setBackendError] = useState<string | null>(null)
  const onPoseRef = useRef<((result: PoseResult) => void) | null>(null)
  // 主动断开时禁止重连（避免组件卸载后仍持续重试）
  const manualCloseRef = useRef(false)
  // 后端已明确报错（如模型初始化失败）时停止指数退避重连，避免无限空转。
  const fatalErrorRef = useRef(false)
  const reconnectTimerRef = useRef<number>(0)
  const retryCountRef = useRef(0)
  const sessionRef = useRef('')
  const frameIdRef = useRef(0)
  const inFlightRef = useRef<{ id: number; mode: ScoreMode } | null>(null)
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const resultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearInFlight = useCallback(() => {
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current)
    ackTimerRef.current = null
    inFlightRef.current = null
  }, [])

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return

    manualCloseRef.current = false
    // 显式重新连接时清除致命错误标记（用户点击「重试」或后端重启后调用）
    fatalErrorRef.current = false

    let ws: WebSocket
    try {
      ws = new WebSocket(WS_URL)
    } catch {
      // 构造函数抛错时安排重连，避免整个功能永久失效
      scheduleReconnect()
      return
    }
    wsRef.current = ws
    sessionRef.current = crypto.randomUUID()
    clearInFlight()
    if (resultTimerRef.current) clearTimeout(resultTimerRef.current)

    ws.onopen = () => {
      if (wsRef.current !== ws) return
      retryCountRef.current = 0
      // TCP 已连接不等于模型就绪，避免冷启动时提前发帧触发 ACK 超时。
      setConnected(false)
    }

    ws.onclose = () => {
      if (wsRef.current !== ws) return
      clearInFlight()
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current)
      setConnected(false)
      setPoseResult(null)
      onPoseRef.current?.({ type: 'no_pose', timestamp: new Date().toISOString(), reason: 'connection_lost', message: 'Camera connection closed' })
      if (wsRef.current === ws) wsRef.current = null
      // 后端已明确报致命错误（如 MediaPipe 初始化失败）时不再重连：
      // 重连也无法恢复，只会让界面无限闪「正在连接后端...」。
      if (fatalErrorRef.current) return
      scheduleReconnect()
    }

    ws.onerror = () => {
      if (wsRef.current !== ws) return
      // onerror 后通常紧跟 onclose，重连逻辑统一放在 onclose 处理
      setConnected(false)
    }

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'pose' || data.type === 'partial_pose' || data.type === 'no_pose') {
          const pending = inFlightRef.current
          if (!pending || data.session_id !== sessionRef.current || data.frame_id !== pending.id) return
          clearInFlight()
          setPoseResult(data as PoseResult)
          onPoseRef.current?.(data as PoseResult)
          if (resultTimerRef.current) clearTimeout(resultTimerRef.current)
          resultTimerRef.current = setTimeout(() => {
            const expired: PoseResult = { type: 'no_pose', timestamp: new Date().toISOString(), mode: data.mode, reason: 'expired', message: 'Pose result expired' }
            setPoseResult(expired)
            onPoseRef.current?.(expired)
          }, 1500)
        } else if (data.type === 'error') {
          clearInFlight()
          // 后端侧致命错误：标记并停止重连，向 UI 暴露原因
          fatalErrorRef.current = true
          setBackendError(data.message || '后端处理出错')
          setConnected(false)
        } else if (data.type === 'ready') {
          // 模型就绪，清除历史错误
          fatalErrorRef.current = false
          setBackendError(null)
          setConnected(true)
        }
      } catch {
        // ignore parse errors
      }
    }
    // scheduleReconnect 在下方以 function 声明，依赖通过 ref 读取，故此处安全
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearInFlight])

  // 指数退避重连：后端崩溃重启或短暂断连后可自愈，无需重启整个应用
  function scheduleReconnect() {
    if (manualCloseRef.current) return
    if (reconnectTimerRef.current) return
    const delay = Math.min(
      RECONNECT_BASE_DELAY * 2 ** retryCountRef.current,
      RECONNECT_MAX_DELAY,
    )
    retryCountRef.current += 1
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = 0
      if (!manualCloseRef.current) connect()
    }, delay)
  }

  const disconnect = useCallback(() => {
    clearInFlight()
    if (resultTimerRef.current) clearTimeout(resultTimerRef.current)
    manualCloseRef.current = true
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = 0
    }
    const ws = wsRef.current
    wsRef.current = null
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null
      ws.close()
    }
    setConnected(false)
    setPoseResult(null)
    onPoseRef.current?.({ type: 'no_pose', timestamp: new Date().toISOString(), reason: 'expired', message: 'Camera session stopped' })
  }, [clearInFlight])

  /**
   * 发送一帧。
   *
   * `mode` 随帧一起带给后端：桌面端的评分在 Python 后端算，后端必须知道用户
   * 此刻是在「静息坐姿」还是「正在做康复动作」，否则会拿静息判定去评运动中的人
   * —— 那会让做对动作的用户被判「头部严重侧倾」。
   */
  const sendFrame = useCallback((base64Data: string, mode: ScoreMode = MODE_MONITOR) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && !inFlightRef.current && wsRef.current.bufferedAmount < 512_000) {
      const id = ++frameIdRef.current
      inFlightRef.current = { id, mode }
      try {
        wsRef.current.send(JSON.stringify({ type: 'frame', data: base64Data, mode, session_id: sessionRef.current, frame_id: id, captured_at: Date.now() }))
      } catch (error) {
        // 连接关闭竞态不能留下永久在途帧，错误结果同样使页面旧分数失效。
        clearInFlight()
        console.error('[PoseSocket] Frame send failed', { frame_id: id, mode, error })
        setPoseResult(null)
        onPoseRef.current?.({ type: 'no_pose', timestamp: new Date().toISOString(), mode, reason: 'inference_error', message: 'Frame send failed' })
        wsRef.current?.close()
        return
      }
      ackTimerRef.current = setTimeout(() => {
        console.warn('[PoseSocket] Frame acknowledgement timed out', { frame_id: id, mode })
        clearInFlight()
        setPoseResult(null)
        onPoseRef.current?.({ type: 'no_pose', timestamp: new Date().toISOString(), mode, reason: 'expired', message: 'Pose result expired' })
        wsRef.current?.close()
      }, 1500)
    }
  }, [clearInFlight])

  const onPoseResult = useCallback((cb: (result: PoseResult) => void) => {
    onPoseRef.current = cb
  }, [])

  // 供「重试」按钮使用：清除致命错误标记并允许重新连接
  const resetBackendError = useCallback(() => {
    fatalErrorRef.current = false
    setBackendError(null)
  }, [])

  useEffect(() => {
    return () => {
      // 卸载：彻底清理连接、定时器与回调引用，避免内存泄漏
      manualCloseRef.current = true
      clearInFlight()
      if (resultTimerRef.current) clearTimeout(resultTimerRef.current)
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = 0
      }
      const ws = wsRef.current
      wsRef.current = null
      if (ws) {
        ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null
        ws.close()
      }
      onPoseRef.current = null
    }
  }, [clearInFlight])

  return {
    connect,
    disconnect,
    connected,
    poseResult,
    backendError,
    resetBackendError,
    sendFrame,
    onPoseResult,
  }
}
