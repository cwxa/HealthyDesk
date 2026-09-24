/**
 * 本地数据层（移动端 / 纯浏览器）。
 *
 * 桌面版的数据全部存在 Python 后端的 SQLite 里，前端通过 REST 读写。
 * 移动端没有后端，这里用 IndexedDB 复刻出同样的四张"表"，
 * 让上层业务代码（Dashboard / NeckActivity / Settings）几乎无需改动：
 *
 *   settings        -> 键值对（reminder_interval / voice_enabled / ...）
 *   posture_score   -> 姿态采样记录 { timestamp, head_angle, shoulder_diff, spine_angle, score }
 *   usage_record    -> 每日使用/休息统计 { date, usage_minutes, break_count }
 *   activity_log    -> 活动记录 { timestamp, activity_type, exercise_count, duration_sec, avg_score }
 *   posture_daily   -> 每日归档聚合（精确量，见 dailyAgg.ts；v2 新增）
 *
 * 对外暴露的方法签名刻意与后端 REST 接口一一对应，
 * 便于 `dataLayer` 在两种后端实现之间做无感切换。
 *
 * ## schema 版本
 *
 * 移动端的迁移机制就是 `DB_VERSION` + `onupgradeneeded` 的分支 —— 与桌面端
 * `backend/db/migrations.py` 是**同一件事的两种实现**，结构必须同构（字段名一致），
 * 否则导出的数据互相导入不了（ROADMAP 需求 4）。
 *
 * 🔴 加字段/加表必须**同时**做三件事：建 store 语句、`DB_VERSION` +1、
 *    `onupgradeneeded` 里补建的分支。少做最后一件，老用户升级后新表不存在，
 *    写入静默失败。
 */

import type { DayAggregate } from './dailyAgg'
import { dayKeyFromTs } from './localDay'

const DB_NAME = 'neckguardian'
const DB_VERSION = 2

export interface PostureRecord {
  id?: number
  timestamp: string
  head_angle: number
  shoulder_diff: number
  spine_angle: number
  score: number
}

export interface UsageRecord {
  date: string
  usage_minutes: number
  break_count: number
}

export interface ActivityLogRecord {
  id?: number
  timestamp: string
  activity_type: string
  exercise_count: number
  duration_sec: number
  avg_score: number
}

/** 每日归档行。`DayAggregate` 的字段与 `posture_daily` 的列一一对应（只存精确量）。 */
export interface DailyRow extends DayAggregate {
  date: string
  updated_at: string
}

type StoreName = 'settings' | 'posture_score' | 'usage_record' | 'activity_log' | 'posture_daily'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      // 用 contains 判断而不是只信 oldVersion：既覆盖全新安装（oldVersion 0），
      // 也覆盖"升级中途失败留下半套表"的情况。每个分支都幂等，重跑安全。
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains('posture_score')) {
        const s = db.createObjectStore('posture_score', { keyPath: 'id', autoIncrement: true })
        s.createIndex('timestamp', 'timestamp')
      }
      if (!db.objectStoreNames.contains('usage_record')) {
        db.createObjectStore('usage_record', { keyPath: 'date' })
      }
      if (!db.objectStoreNames.contains('activity_log')) {
        const s = db.createObjectStore('activity_log', { keyPath: 'id', autoIncrement: true })
        s.createIndex('timestamp', 'timestamp')
      }
      // ---- v2 新增：每日归档（与桌面端 SQLite 的 posture_daily 同构）----
      if (!db.objectStoreNames.contains('posture_daily')) {
        db.createObjectStore('posture_daily', { keyPath: 'date' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = fn(t.objectStore(store))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

function getAll<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, 'readonly', (s) => s.getAll() as IDBRequest<T[]>)
}

/**
 * 读取某张"表"的全部行。
 *
 * ⚠️ 必须复用本模块的 `openDb()`（带 DB_VERSION 与 onupgradeneeded），
 * 否则用 `indexedDB.open(name)`（无版本号）打开会创建一个**没有任何
 * object store 的空库**，把后续正常的打开也一起带偏。
 */
export function readAllRows<T>(store: StoreName): Promise<T[]> {
  return getAll<T>(store)
}

// ---------------- settings ----------------

/** 默认设置，与后端 `db/database.py` 的初始 INSERT 保持一致。 */
export const DEFAULT_SETTINGS: Record<string, string> = {
  reminder_interval: '30',
  ai_enabled: 'false',
  auto_start: 'false',
  voice_enabled: 'true',
}

export async function getLocalSettings(): Promise<Record<string, string>> {
  const rows = await getAll<{ key: string; value: string }>('settings')
  const map: Record<string, string> = { ...DEFAULT_SETTINGS }
  for (const r of rows) map[r.key] = r.value
  return map
}

export async function setLocalSetting(key: string, value: string): Promise<void> {
  await tx('settings', 'readwrite', (s) => s.put({ key, value }))
}

// ---------------- posture_score ----------------

export async function addPostureRecord(rec: Omit<PostureRecord, 'id'>): Promise<void> {
  await tx('posture_score', 'readwrite', (s) => s.add(rec))
}

/**
 * 读取 `[startIso, endIso)` 区间内的采样。
 *
 * 走 `timestamp` 索引的范围查询，**不要**改成 `getAll()` 后在 JS 里过滤：
 * 原始表按 1.9 万条/天增长，全量读取会把整个数据集拉进内存
 * （这也是改造后 `localStats` 不再全量读原始表的原因）。
 */
export function readPostureRange(startIso: string, endIso: string): Promise<PostureRecord[]> {
  return openDb().then(
    (db) =>
      new Promise<PostureRecord[]>((resolve, reject) => {
        const t = db.transaction('posture_score', 'readonly')
        const idx = t.objectStore('posture_score').index('timestamp')
        const out: PostureRecord[] = []
        const req = idx.openCursor(IDBKeyRange.bound(startIso, endIso, false, true))
        req.onsuccess = () => {
          const cur = req.result
          if (cur) {
            out.push(cur.value as PostureRecord)
            cur.continue()
          } else {
            resolve(out)
          }
        }
        req.onerror = () => reject(req.error)
      }),
  )
}

/**
 * 统计每个本地自然日的采样条数。
 *
 * 用**键游标**（`openKeyCursor`）而不是取值游标：只需要知道"某天有多少条"，
 * 不必把 500 多万字节的采样数据搬进内存。归档时靠它判断哪些天需要重算。
 */
export function readPostureDayCounts(): Promise<Record<string, number>> {
  return openDb().then(
    (db) =>
      new Promise<Record<string, number>>((resolve, reject) => {
        const t = db.transaction('posture_score', 'readonly')
        const idx = t.objectStore('posture_score').index('timestamp')
        const counts: Record<string, number> = {}
        const req = idx.openKeyCursor()
        req.onsuccess = () => {
          const cur = req.result
          if (!cur) return
          const day = dayKeyFromTs(String(cur.key))
          counts[day] = (counts[day] ?? 0) + 1
          cur.continue()
        }
        req.onerror = () => reject(req.error)
        t.oncomplete = () => resolve(counts)
      }),
  )
}

/** 删除 `timestamp < startIso` 的原始采样，返回删除条数。 */
export function deletePostureBefore(startIso: string): Promise<number> {
  return openDb().then(
    (db) =>
      new Promise<number>((resolve, reject) => {
        const t = db.transaction('posture_score', 'readwrite')
        const idx = t.objectStore('posture_score').index('timestamp')
        let deleted = 0
        const req = idx.openCursor(IDBKeyRange.upperBound(startIso, true))
        req.onsuccess = () => {
          const cur = req.result
          if (cur) {
            cur.delete()
            deleted += 1
            cur.continue()
          }
        }
        req.onerror = () => reject(req.error)
        t.oncomplete = () => resolve(deleted)
      }),
  )
}

// ---------------- posture_daily（每日归档） ----------------

export async function putDailyRow(row: DailyRow): Promise<void> {
  await tx('posture_daily', 'readwrite', (s) => s.put(row))
}

/** 读取 `date >= sinceDay` 的归档行（按日期升序）。归档表很小，可以全量取。 */
export async function getDailyRows(sinceDay?: string): Promise<DailyRow[]> {
  const all = await getAll<DailyRow>('posture_daily')
  const rows = sinceDay ? all.filter((r) => r.date >= sinceDay) : all
  return rows.sort((a, b) => (a.date < b.date ? -1 : 1))
}

// ---------------- usage_record ----------------

function todayStr(): string {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 累加当日使用分钟数。 */
export async function addUsageMinutes(minutes: number): Promise<void> {
  const date = todayStr()
  const existing = await tx<UsageRecord | undefined>('usage_record', 'readonly', (s) =>
    s.get(date) as IDBRequest<UsageRecord | undefined>,
  )
  const next: UsageRecord = existing
    ? { ...existing, usage_minutes: existing.usage_minutes + minutes }
    : { date, usage_minutes: minutes, break_count: 0 }
  await tx('usage_record', 'readwrite', (s) => s.put(next))
}

/** 记录一次休息（完成活动 / 触发提醒）。 */
export async function recordBreak(): Promise<void> {
  const date = todayStr()
  const existing = await tx<UsageRecord | undefined>('usage_record', 'readonly', (s) =>
    s.get(date) as IDBRequest<UsageRecord | undefined>,
  )
  const next: UsageRecord = existing
    ? { ...existing, break_count: existing.break_count + 1 }
    : { date, usage_minutes: 0, break_count: 1 }
  await tx('usage_record', 'readwrite', (s) => s.put(next))
}

// ---------------- activity_log ----------------

export async function addActivityLog(rec: Omit<ActivityLogRecord, 'id'>): Promise<void> {
  await tx('activity_log', 'readwrite', (s) => s.add(rec))
}

export async function getRecentActivities(limit = 20): Promise<(ActivityLogRecord & { id: number })[]> {
  const all = await getAll<ActivityLogRecord>('activity_log')
  return all
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1))
    .slice(0, limit)
    .map((r) => ({ ...r, id: r.id ?? 0 }))
}

// ---------------- 清空（用于设置页"重置数据"） ----------------

export async function clearAllLocalData(): Promise<void> {
  // 含 posture_daily：归档也是"用户的数据"，一键清除必须真的清干净，
  // 否则用户以为清空了、趋势里却还留着历史。
  for (const store of [
    'posture_score',
    'posture_daily',
    'usage_record',
    'activity_log',
  ] as StoreName[]) {
    await tx(store, 'readwrite', (s) => s.clear())
  }
}
