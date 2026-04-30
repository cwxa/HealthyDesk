import { useEffect, useRef, useState, useCallback } from 'react'
import type { PoseResult } from '../types'

const WS_URL = 'ws://127.0.0.1:18920/ws/camera'

export function useWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const [connected, setConnected] = useState(false)
  const [poseResult, setPoseResult] = useState<PoseResult | null>(null)
  const [reminderTriggered, setReminderTriggered] = useState(false)
  const onPoseRef = useRef<((result: PoseResult) => void) | null>(null)

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => setConnected(true)
    ws.onclose = () => setConnected(false)
    ws.onerror = () => setConnected(false)

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'pose' || data.type === 'no_pose') {
          setPoseResult(data as PoseResult)
          onPoseRef.current?.(data as PoseResult)
        } else if (data.type === 'reminder') {
          setReminderTriggered(true)
        }
      } catch {
        // ignore parse errors
      }
    }
  }, [])

  const disconnect = useCallback(() => {
    wsRef.current?.close()
    wsRef.current = null
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

  useEffect(() => {
    return () => {
      wsRef.current?.close()
    }
  }, [])

  return {
    connect,
    disconnect,
    connected,
    poseResult,
    reminderTriggered,
    setReminderTriggered,
    sendFrame,
    onPoseResult,
  }
}
