import { hasLocalBackend } from './runtime'
import * as local from './localDb'
import * as stats from './localStats'
import type { WeeklyReport, ActivityRecord } from '../types'

/**
 * 统一数据层。
 *
 * 上层组件只需要 `import { data } from '../platform/dataLayer'`，
 * 不再关心数据到底来自 Electron 的 Python 后端还是手机本地 IndexedDB。
 *
 * 桌面端：转发到 `http://127.0.0.1:18920` 的 REST 接口（保持既有行为不变）。
 * 移动端：走本地 IndexedDB 实现。
 */

const BACKEND_URL = 'http://127.0.0.1:18920'

async function http<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  return res.json()
}

export interface StatsSummary {
  today_activities: number
  today_avg: number
  latest_score: number
}

export const data = {
  /** 读全部设置（键值对）。 */
  async getSettings(): Promise<Record<string, string>> {
    if (hasLocalBackend()) return http<Record<string, string>>('/api/settings')
    return local.getLocalSettings()
  },

  /** 写单个设置项。 */
  async setSetting(key: string, value: string): Promise<void> {
    if (hasLocalBackend()) {
      await http('/api/settings', { method: 'PUT', body: JSON.stringify({ key, value }) })
      return
    }
    await local.setLocalSetting(key, value)
  },

  /** 记录一次姿态采样。 */
  async recordPosture(rec: {
    timestamp: string
    head_angle: number
    shoulder_diff: number
    spine_angle: number
    score: number
  }): Promise<void> {
    if (hasLocalBackend()) {
      await http('/api/posture/record', { method: 'POST', body: JSON.stringify(rec) })
      return
    }
    await local.addPostureRecord(rec)
  },

  /** 记录一次活动（完成练习）。 */
  async recordActivity(rec: {
    timestamp: string
    activity_type: string
    exercise_count: number
    duration_sec: number
    avg_score: number
  }): Promise<void> {
    if (hasLocalBackend()) {
      await http('/api/activity/record', { method: 'POST', body: JSON.stringify(rec) })
      return
    }
    await local.addActivityLog(rec)
    await local.recordBreak()
  },

  /** 累加使用时长（分钟）。 */
  async addUsageMinutes(minutes: number): Promise<void> {
    if (hasLocalBackend()) {
      await http('/api/posture/usage', { method: 'POST', body: JSON.stringify({ minutes }) })
      return
    }
    await local.addUsageMinutes(minutes)
  },

  /** 记录一次休息计数。 */
  async recordBreak(): Promise<void> {
    if (hasLocalBackend()) {
      await http('/api/reminder/end', { method: 'POST', body: '{}' })
      return
    }
    await local.recordBreak()
  },

  /** 今日 / 最近活动概要。 */
  async getSummary(): Promise<StatsSummary> {
    if (hasLocalBackend()) return http<StatsSummary>('/api/stats/summary')
    return stats.computeSummary()
  },

  /** 近 7 天周报。 */
  async getWeekly(): Promise<WeeklyReport> {
    if (hasLocalBackend()) return http<WeeklyReport>('/api/stats/weekly')
    return stats.computeWeeklyReport()
  },

  /** 最近活动记录。 */
  async getRecentActivities(limit = 10): Promise<ActivityRecord[]> {
    if (hasLocalBackend()) {
      return http<ActivityRecord[]>(`/api/activity/recent?limit=${limit}`)
    }
    return local.getRecentActivities(limit)
  },

  /** 提醒状态（仅桌面端后端有；移动端由本地定时器管理）。 */
  async getReminderStatus(): Promise<{
    pending: boolean
    next_reminder: string | null
    snooze_until: string | null
  } | null> {
    if (!hasLocalBackend()) return null
    try {
      return await http('/api/reminder/status')
    } catch {
      return null
    }
  },

  /** 结束当前休息（开始活动时调用）。 */
  async endBreak(): Promise<void> {
    if (hasLocalBackend()) {
      await http('/api/reminder/end', { method: 'POST', body: '{}' })
    }
  },

  /** 稍后提醒。 */
  async snooze(minutes: number): Promise<void> {
    if (hasLocalBackend()) {
      await http('/api/reminder/snooze', { method: 'POST', body: JSON.stringify({ minutes }) })
    }
  },
}
