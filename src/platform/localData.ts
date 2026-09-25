/**
 * 移动端的数据管理：导出 / 导入 / 一键清除 / 存储用量。
 *
 * 与桌面端 `backend/api/data.py` 的三条语义**逐条对齐**：
 * 1. 导入 = **覆盖**数据表（先清后写）；设置表用 upsert（不清空）。
 * 2. 设置表不被导入/清除动到已有的密钥。
 * 3. 校验失败返回错误码而不是抛异常，界面据此给出具体提示。
 *
 * 格式本身（字段、类型规则、排序、错误码）在 `exportFormat.ts`，与 Python 侧逐位一致，
 * 由 `scripts/verify-export-format.mjs` 守住。本文件只负责 IndexedDB 的读写与
 * 存储用量这类**平台相关**的部分。
 */

import {
  type ExportBundle,
  type Skipped,
  TABLE_ORDER,
  buildDailyCsv,
  buildExport,
  validateExport,
} from './exportFormat'
import { clampRetentionDays, RETENTION_DAYS } from './dailyAgg'
import {
  clearAllLocalData,
  countStore,
  DB_VERSION,
  getDailyRows,
  getLocalSettings,
  putStoreRows,
  readAllRows,
  replaceStoreRows,
} from './localDb'

/** 导入/清除**不碰**的设置表：它是配置不是数据（且含 API Key 等凭据）。 */
const SETTINGS_TABLE = 'settings'
const DATA_STORES = ['posture_score', 'posture_daily', 'usage_record', 'activity_log'] as const

export interface DataStatus {
  raw_samples: number
  daily_rows: number
  first_day: string | null
  last_day: string | null
  keep_days: number
  default_keep_days: number
  schema_version: number
  /** 占用的存储字节数（桌面端是 DB 文件大小，移动端是 IndexedDB 用量估计）。 */
  db_bytes: number
  /** 仅移动端：浏览器给的配额上限。 */
  quota_bytes?: number
}

export async function getLocalDataStatus(): Promise<DataStatus> {
  const settings = await getLocalSettings()
  const days = await getDailyRows()
  // daily_rows 是"有采样的天数"，first/last 取它的两端 —— 与桌面端口径一致
  const first = days.length > 0 ? days[0].date : null
  const last = days.length > 0 ? days[days.length - 1].date : null

  let usage = 0
  let quota = 0
  try {
    const estimate = await navigator.storage?.estimate?.()
    usage = estimate?.usage ?? 0
    quota = estimate?.quota ?? 0
  } catch {
    /* 隐私模式等场景下不可用：显示 0 而不是崩掉 */
  }

  return {
    raw_samples: await countStore('posture_score'),
    daily_rows: days.length,
    first_day: first,
    last_day: last,
    keep_days: clampRetentionDays(settings.retention_days),
    default_keep_days: RETENTION_DAYS,
    schema_version: DB_VERSION,
    db_bytes: usage,
    quota_bytes: quota,
  }
}

/** 收集全部数据。返回的是 `exportFormat.buildExport` 的结果（bundle 用于写文件）。 */
export async function exportLocalData() {
  const tables: Record<string, unknown[]> = {}
  for (const table of TABLE_ORDER) {
    tables[table] = await readAllRows(table)
  }
  // 移动端没有后端可问版本号：用构建期注入的 __APP_VERSION__（vite define）。
  // `typeof` 保护是必要的 —— 对拍脚本用 esbuild bundle 时没有这个全局。
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
  return buildExport(tables, version, DB_VERSION, new Date().toISOString())
}

/** 每日汇总 CSV。 */
export async function exportLocalDailyCsv(): Promise<string> {
  return buildDailyCsv(await getDailyRows())
}

export interface ImportOutcome {
  ok: boolean
  error: string | null
  imported: Partial<Record<string, number>>
  skipped: Skipped
}

/** 导入一个导出包（**覆盖**数据表，设置表 upsert）。 */
export async function importLocalData(payload: unknown): Promise<ImportOutcome> {
  const result = validateExport(payload)
  if (!result.ok) {
    return { ok: false, error: result.error, imported: {}, skipped: {} }
  }

  const tables = result.bundle.tables
  const imported: Partial<Record<string, number>> = {}

  // 🔴 顺序：先写归档（posture_daily）再清原始表 —— 其实两者互相独立（都是覆盖写），
  // 但保持与桌面端一致的书写顺序，避免以后有人"优化"成边清边写。
  for (const store of DATA_STORES) {
    imported[store] = await replaceStoreRows(store, tables[store] as Record<string, unknown>[])
  }
  // 设置项 upsert：文件的删不掉本机已有的（尤其是没被导出的密钥）
  if (tables[SETTINGS_TABLE].length > 0) {
    imported[SETTINGS_TABLE] = await putStoreRows(
      SETTINGS_TABLE,
      tables[SETTINGS_TABLE] as Record<string, unknown>[],
    )
  }

  return { ok: true, error: null, imported, skipped: result.skipped }
}

/** 清除全部**健康数据**（原始采样 / 归档 / 使用记录 / 活动记录）。保留设置。 */
export async function clearLocalHealthData(): Promise<Partial<Record<string, number>>> {
  const cleared: Partial<Record<string, number>> = {}
  for (const store of DATA_STORES) {
    cleared[store] = await countStore(store)
  }
  await clearAllLocalData()
  return cleared
}

/** 导出文件名（两端一致，便于用户识别是同一份备份）。 */
export function exportFileName(kind: 'json' | 'csv', now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `neckguardian-${stamp}.${kind}`
}

export type { ExportBundle }
