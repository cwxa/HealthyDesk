import { useEffect, useRef, useState, useCallback } from 'react'
import type { PoseResult } from '../types'

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

    ws.onopen = () => {
      retryCountRef.current = 0
      setConnected(true)
    }

    ws.onclose = () => {
      setConnected(false)
      if (wsRef.current === ws) wsRef.current = null
      // 后端已明确报致命错误（如 MediaPipe 初始化失败）时不再重连：
      // 重连也无法恢复，只会让界面无限闪「正在连接后端...」。
      if (fatalErrorRef.current) return
      scheduleReconnect()
    }

    ws.onerror = () => {
      // onerror 后通常紧跟 onclose，重连逻辑统一放在 onclose 处理
      setConnected(false)
    }

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'pose' || data.type === 'no_pose') {
          setPoseResult(data as PoseResult)
          onPoseRef.current?.(data as PoseResult)
        } else if (data.type === 'error') {
          // 后端侧致命错误：标记并停止重连，向 UI 暴露原因
          fatalErrorRef.current = true
          setBackendError(data.message || '后端处理出错')
          setConnected(false)
        } else if (data.type === 'ready') {
          // 模型就绪，清除历史错误
          fatalErrorRef.current = false
          setBackendError(null)
        }
      } catch {
        // ignore parse errors
      }
    }
    // scheduleReconnect 在下方以 function 声明，依赖通过 ref 读取，故此处安全
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
  }, [])

  const sendFrame = useCallback((base64Data: string) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'frame', data: base64Data }))
    }
  }, [])

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
  }, [])

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
