import {
  type ActivityLogRecord,
  type DailyRow,
  getDailyRows,
  getRecentActivities,
  getLocalSettings,
  readAllRows,
  readPostureRange,
} from './localDb'
import type { WeeklyReport, ActivityRecord } from '../types'
import { computePartHealth, type PartHealth } from './partHealth'
import { pyRound, pyRound1 } from './scoringModel'
import { dailyAvgScore, mergeDays } from './dailyAgg'
import { dayBoundsIso, dayKeyFromTs, shiftDay, todayLocalDay } from './localDay'
import { ensureDailyFresh } from './localMaintenance'

/**
 * 本地统计计算 —— 把后端 `api/stats.py` + `api/activity.py` 的聚合
 * 用 JS 重写一遍，保证移动端与桌面端给出**同样的数字**。
 *
 * 对应关系：
 *   stats.py  /stats/weekly   -> computeWeeklyReport()
 *   stats.py  /stats/summary  -> computeSummary()
 *   activity.py /activity/recent -> getRecentActivities()
 *
 * ## 日期口径
 *
 * 一律**本地自然日**，由 `localDay.ts` 单点定义。桌面端对应
 * `date(<ts>, 'localtime')`。此前两端口径不同（桌面端是 UTC 零点起的滚动窗口），
 * 在 UTC+8 的凌晨 0–8 点会算到不同的一天上。
 *
 * ## 为什么日级数字来自 posture_daily，而不是直接算原始采样
 *
 * 归档层（`posture_daily`）与后端同源：两端都是「同一天 → 同一行精确量」。
 * 好处有两个：
 * 1. **趋势与均分不可能互相矛盾** —— 它们读的是同一份数据，不是一个查原始表
 *    分组、另一个再算一遍平均。
 * 2. 原始采样只保留最近 30 天，而归档长期保留；若日级数字直读原始表，
 *    超过保留期的历史就会凭空消失。
 *
 * ⚠️ 但**部位健康度例外**：它是「单项扣分的时间平均」，扣分随超出阈值的程度
 * 连续变化，无法由计数还原，所以必须读原始行（今天这一天）。
 *
 * 注意：所有读取都走 localDb 的接口（复用同一套 openDb 版本/schema），
 * 不要在这里另外 `indexedDB.open`，否则会打开出一个空库。
 */

export interface StatsSummary {
  today_activities: number
  today_avg: number
  latest_score: number
  /** 三个部位各自的真实聚合（0–100，一位小数）；今日无采样时三者为 null。 */
  part_health: PartHealth
}

export async function computeSummary(): Promise<StatsSummary> {
  // 读之前先保证归档是新的（与后端 `/stats/summary` 的 _ensure_daily_fresh 对称）
  await ensureDailyFresh()

  const activities = await readAllRows<ActivityLogRecord>('activity_log')
  const today = todayLocalDay()

  const todayActivities = activities.filter((a) => dayKeyFromTs(a.timestamp) === today).length

  // 今日均分：消费归档行
  const todayRow = (await getDailyRows(today)).find((r) => r.date === today)
  const todayAvg = todayRow ? dailyAvgScore(todayRow) : 0

  // 部位健康度：必须读今天的原始行（见文件头说明）。
  // 今天的原始采样永远不会被保留策略清掉，所以这里一定有数据可用。
  const [startIso, endIso] = dayBoundsIso(today)
  const todayPostures = await readPostureRange(startIso, endIso)
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
  await ensureDailyFresh()

  const activities = await readAllRows<ActivityLogRecord>('activity_log')
  const usage = await readAllRows<{ date: string; usage_minutes: number; break_count: number }>(
    'usage_record',
  )
  const settings = await getLocalSettings()
  const interval = Math.max(1, parseInt(settings.reminder_interval) || 30)

  // 近 7 天 = 本地今天往前 7 天的零点起算（含今天共 8 个自然日），与后端一致。
  const sinceDay = shiftDay(todayLocalDay(), -7)

  // 日级数字全部来自归档层 —— 不再全量读取原始采样表
  //（那既慢，又会让超过保留期的历史凭空消失）。
  const dailyRows: DailyRow[] = await getDailyRows(sinceDay)
  const postureAvg = dailyAvgScore(mergeDays(dailyRows))

  const weekActivities = activities.filter((a) => dayKeyFromTs(a.timestamp) >= sinceDay)
  const totalExerciseSec = weekActivities.reduce((s, a) => s + a.duration_sec, 0)

  const recentUsage = usage.filter((u) => u.date >= sinceDay)
  const totalMinutes = recentUsage.reduce((s, u) => s + (u.usage_minutes || 0), 0)
  const totalBreaks = recentUsage.reduce((s, u) => s + (u.break_count || 0), 0)

  // 整数取整（pyRound），不是保留一位小数的 pyRound1 ——
  // 后端 stats.py 对应位置是 `max(1, round_int(...))`。此前这里误用了 pyRound1，
  // 于是手机把「应休息 2.7 次」拿去算完成率，电脑用 3 次，两端结果不同。
  const expectedBreaks = Math.max(1, pyRound(totalMinutes / interval))
  const completionRate = pyRound1(Math.min(100, (weekActivities.length / expectedBreaks) * 100))

  // 趋势：直接消费归档行（与 posture_avg 同源，不可能互相矛盾）
  const trend = dailyRows.map((r) => ({ day: r.date, avg_score: dailyAvgScore(r) }))

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

export { getRecentActivities }
export type { ActivityRecord }
