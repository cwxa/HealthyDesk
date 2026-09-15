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
 *
 * 对外暴露的方法签名刻意与后端 REST 接口一一对应，
 * 便于 `dataLayer` 在两种后端实现之间做无感切换。
 */

const DB_NAME = 'neckguardian'
const DB_VERSION = 1

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

type StoreName = 'settings' | 'posture_score' | 'usage_record' | 'activity_log'

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
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
  for (const store of ['posture_score', 'usage_record', 'activity_log'] as StoreName[]) {
    await tx(store, 'readwrite', (s) => s.clear())
  }
}
