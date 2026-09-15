import { useState, useCallback } from 'react'
import { data } from '../platform/dataLayer'
import type { WeeklyReport, ActivityRecord } from '../types'

const BACKEND_URL = 'http://127.0.0.1:18920'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`)
  }
  return res.json()
}

/**
 * 统一的站内接口 hook。
 *
 * 桌面端直接访问 Python 后端的 REST 接口；移动端没有后端，
 * 这里把最常用的几个统计/记录读取路由到本地数据层（IndexedDB），
 * 让 Dashboard / Settings 等页面无需感知平台差异。
 *
 * 其余未被本地实现的路径在移动端会抛错——调用方通常已 try/catch。
 */
export function useApi() {
  const [loading, setLoading] = useState(false)

  const run = useCallback(async <T>(fn: () => Promise<T>): Promise<T> => {
    setLoading(true)
    try {
      return await fn()
    } finally {
      setLoading(false)
    }
  }, [])

  const get = useCallback(async <T>(path: string): Promise<T> => {
    return run(async () => {
      switch (path) {
        case '/api/settings':
          return (await data.getSettings()) as T
        case '/api/stats/summary':
          return (await data.getSummary()) as T
        case '/api/stats/weekly':
          return (await data.getWeekly()) as unknown as T
        case '/api/activity/recent?limit=10':
          return (await data.getRecentActivities(10)) as unknown as T
        case '/api/activity/recent?limit=20':
          return (await data.getRecentActivities(20)) as unknown as T
        case '/api/reminder/status':
          return ((await data.getReminderStatus()) ?? { pending: false, next_reminder: null, snooze_until: null }) as T
        default:
          return request<T>(path)
      }
    })
  }, [run])

  const post = useCallback(async <T>(path: string, body: unknown): Promise<T> => {
    return run(async () => {
      switch (path) {
        case '/api/reminder/end':
          await data.endBreak()
          return { status: 'ok' } as T
        case '/api/reminder/snooze': {
          const m = (body as { minutes?: number })?.minutes ?? 5
          await data.snooze(m)
          return { status: 'ok' } as T
        }
        default:
          return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
      }
    })
  }, [run])

  const put = useCallback(async <T>(path: string, body: unknown): Promise<T> => {
    return run(async () => {
      if (path === '/api/settings') {
        const { key, value } = body as { key: string; value: string }
        await data.setSetting(key, value)
        return { status: 'ok' } as T
      }
      return request<T>(path, { method: 'PUT', body: JSON.stringify(body) })
    })
  }, [run])

  return { get, post, put, loading }
}

export type { WeeklyReport, ActivityRecord }
