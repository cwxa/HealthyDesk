/**
 * 移动端数据维护：日聚合 + 保留期清理。
 *
 * 与桌面端 `backend/services/retention.py` 同构（同样两件事、同样的顺序），
 * 因为移动端的数据形态与桌面端**完全对应**（`posture_score` ↔ 表、
 * `posture_daily` ↔ 表），两端的清理与聚合口径必须一致。
 *
 * ## 顺序不可颠倒
 *
 * 1. `rollupDaily()` —— 先把原始采样折成归档行
 * 2. `pruneRaw()`     —— 再删掉超出保留期的原始采样
 *
 * 反过来先删，被删那天的数据就**永久消失**了（归档还没写）。
 * `maintainLocalData()` 把这个顺序固定在函数里，调用方不必记住。
 */

import { RETENTION_DAYS, aggregateDay } from './dailyAgg'
import { dayBoundsIso, shiftDay, todayLocalDay } from './localDay'
import {
  deletePostureBefore,
  getDailyRows,
  putDailyRow,
  readPostureDayCounts,
  readPostureRange,
} from './localDb'

/** 把原始采样折成每日归档，只重算**样本数发生变化**的日子，返回重算天数。 */
export async function rollupDaily(): Promise<number> {
  const counts = await readPostureDayCounts()
  const existing = new Map((await getDailyRows()).map((r) => [r.date, Number(r.sample_count)]))

  let updated = 0
  for (const [day, n] of Object.entries(counts)) {
    if (existing.get(day) === n) continue
    const [startIso, endIso] = dayBoundsIso(day)
    const rows = await readPostureRange(startIso, endIso)
    const agg = aggregateDay(rows)
    await putDailyRow({ date: day, ...agg, updated_at: new Date().toISOString() })
    updated += 1
  }
  return updated
}

/** 删除超出保留期的原始采样，返回删除条数。⚠️ 必须在 `rollupDaily()` 之后调用。 */
export async function pruneRaw(keepDays: number = RETENTION_DAYS): Promise<number> {
  if (keepDays <= 0) return 0
  const cutoffDay = shiftDay(todayLocalDay(), -keepDays)
  const [startIso] = dayBoundsIso(cutoffDay)
  return deletePostureBefore(startIso)
}

/** 先聚合、后清理。应用启动时调用。 */
export async function maintainLocalData(keepDays: number = RETENTION_DAYS): Promise<{
  daysRolledUp: number
  samplesDeleted: number
  keepDays: number
}> {
  try {
    const daysRolledUp = await rollupDaily()
    const samplesDeleted = await pruneRaw(keepDays)
    return { daysRolledUp, samplesDeleted, keepDays }
  } catch (e) {
    // 维护失败不能影响应用可用性（例如 IndexedDB 在某些隐私模式下不可用）
    console.error('本地数据维护失败:', e)
    return { daysRolledUp: 0, samplesDeleted: 0, keepDays }
  }
}

// ---------------------------------------------------------------------------
// 归档刷新节流
//
// 与后端 `api/stats._ensure_daily_fresh` 同一思路：读统计之前保证归档是新的一天的
// 数据一直在变，只靠启动时跑一次会让「今日均分」停在启动那一刻。
// 但不能每次读都重算 —— 所以带 60 秒节流。
// ---------------------------------------------------------------------------
const ENSURE_MIN_INTERVAL_MS = 60_000
let lastEnsureAt = 0

/** 保证本次读取前归档是新的（带节流）。 */
export async function ensureDailyFresh(): Promise<void> {
  const now = Date.now()
  if (now - lastEnsureAt < ENSURE_MIN_INTERVAL_MS) return
  lastEnsureAt = now
  try {
    await rollupDaily()
  } catch (e) {
    console.error('日聚合刷新失败:', e)
  }
}

/** 仅供测试/调试：重置节流计时器。 */
export function __resetEnsureThrottle(): void {
  lastEnsureAt = 0
}
