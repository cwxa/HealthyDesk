import {
  type ActivityLogRecord,
  type PostureRecord,
  getRecentActivities,
  getLocalSettings,
  readAllRows,
} from './localDb'
import type { WeeklyReport, ActivityRecord } from '../types'
import { computePartHealth, type PartHealth } from './partHealth'
import { pyRound, pyRound1 } from './scoringModel'

/**
 * 本地统计计算 —— 把后端 `api/stats.py` + `api/activity.py` 的 SQL 聚合
 * 用 JS 重写一遍，保证移动端与桌面端给出**同样的数字**。
 *
 * 对应关系：
 *   stats.py  /stats/weekly   -> computeWeeklyReport()
 *   stats.py  /stats/summary  -> computeSummary()
 *   activity.py /activity/recent -> getRecentActivities()
 *
 * 注意：所有读取都走 localDb 的 readAllRows（复用同一套 openDb 版本/schema），
 * 不要在这里另外 `indexedDB.open`，否则会打开出一个空库。
 */

/** 7 天前的 ISO 日期串，用于按时间窗口过滤。 */
function daysAgo(n: number): Date {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - n)
  return d
}

function withinDays(ts: string, n: number): boolean {
  return new Date(ts).getTime() >= daysAgo(n).getTime()
}

function dateKey(ts: string): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

export interface StatsSummary {
  today_activities: number
  today_avg: number
  latest_score: number
  /** 三个部位各自的真实聚合（0–100，一位小数）；今日无采样时三者为 null。 */
  part_health: PartHealth
}

export async function computeSummary(): Promise<StatsSummary> {
  const activities = await readAllRows<ActivityLogRecord>('activity_log')
  const postures = await readAllRows<PostureRecord>('posture_score')
  const today = dateKey(new Date().toISOString())

  const todayActivities = activities.filter((a) => dateKey(a.timestamp) === today).length

  const todayPostures = postures.filter((p) => dateKey(p.timestamp) === today)
  const todayAvg = todayPostures.length
    ? pyRound1(todayPostures.reduce((s, p) => s + p.score, 0) / todayPostures.length)
    : 0

  // 部位健康度：从三个分项字段真实聚合，与 today_avg 取同一窗口（今日自然日）。
  // 与后端 /api/stats/summary 的 part_health 必须给出同样的数字。
  const partHealth = computePartHealth(todayPostures)

  const latest = activities.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))[0]

  return {
    today_activities: todayActivities,
    today_avg: todayAvg,
    latest_score: latest?.avg_score ?? 0,
    part_health: partHealth,
  }
}

export async function computeWeeklyReport(): Promise<WeeklyReport> {
  const postures = await readAllRows<PostureRecord>('posture_score')
  const activities = await readAllRows<ActivityLogRecord>('activity_log')
  const usage = await readAllRows<{ date: string; usage_minutes: number; break_count: number }>(
    'usage_record',
  )
  const settings = await getLocalSettings()
  const interval = Math.max(1, parseInt(settings.reminder_interval) || 30)

  const weekPostures = postures.filter((p) => withinDays(p.timestamp, 7))
  const postureAvg = weekPostures.length
    ? pyRound1(weekPostures.reduce((s, p) => s + p.score, 0) / weekPostures.length)
    : 0

  const weekActivities = activities.filter((a) => withinDays(a.timestamp, 7))
  const totalExerciseSec = weekActivities.reduce((s, a) => s + a.duration_sec, 0)
  const daily = getLocalSettingsDaily(usage)

  const totalMinutes = daily.total_minutes
  const totalBreaks = daily.total_breaks

  // 整数取整（pyRound），不是保留一位小数的 pyRound1 ——
  // 后端 stats.py 对应位置是 `max(1, round_int(...))`。此前这里误用了 pyRound1，
  // 于是手机把「应休息 2.7 次」拿去算完成率，电脑用 3 次，两端结果不同。
  const expectedBreaks = Math.max(1, pyRound(totalMinutes / interval))
  const completionRate = pyRound1(Math.min(100, (weekActivities.length / expectedBreaks) * 100))

  // 趋势：近 7 天每天的姿态平均分
  const byDay = new Map<string, number[]>()
  for (const p of weekPostures) {
    const k = dateKey(p.timestamp)
    if (!byDay.has(k)) byDay.set(k, [])
    byDay.get(k)!.push(p.score)
  }
  const trend = Array.from(byDay.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, scores]) => ({
      day,
      avg_score: pyRound1(scores.reduce((s, x) => s + x, 0) / scores.length),
    }))

  return {
    posture_avg: postureAvg,
    weekly_activities: weekActivities.length,
    total_exercise_sec: totalExerciseSec,
    total_minutes: totalMinutes,
    total_breaks: totalBreaks,
    completion_rate: completionRate,
    trend,
  }
}

function getLocalSettingsDaily(
  usage: { date: string; usage_minutes: number; break_count: number }[],
): { total_minutes: number; total_breaks: number } {
  const cutoff = daysAgo(7)
  const recent = usage.filter((u) => new Date(u.date + 'T00:00:00').getTime() >= cutoff.getTime())
  return {
    total_minutes: recent.reduce((s, u) => s + (u.usage_minutes || 0), 0),
    total_breaks: recent.reduce((s, u) => s + (u.break_count || 0), 0),
  }
}

export { getRecentActivities }
export type { ActivityRecord }
