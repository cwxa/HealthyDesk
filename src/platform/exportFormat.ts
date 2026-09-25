/**
 * 统一导出 / 导入格式（移动端 TS 实现）—— `backend/services/export_format.py` 的逐位等价实现。
 *
 * 目标：导出的 JSON **两端可以互相导入**。所以表名、字段名、类型规则、排序、错误码
 * 都必须与 Python 侧逐字相同，由 `scripts/verify-export-format.mjs` 对拍。
 *
 * ⚠️ 本模块**无副作用**（不碰 IndexedDB / document），可被 node 对拍脚本直接 bundle。
 * 落库与文件下载在 `localData.ts` / `dataLayer.ts`，不要挪进来。
 *
 * 三条设计决定（详见 Python 文件顶部注释）：
 * 1. 只导出精确量，派生量（日均分 / 问题占比）导入后现算 —— 否则两份文件各存一套取整结果。
 * 2. 只认字段名 + 类型：多余的表/字段忽略，保证旧版本能导入新版本的文件。
 * 3. 脏行跳过并计数（写进 `skipped`），不让一行坏数据毁掉整份文件。
 */

import { dailyAvgScore, dailyBadPct, type DayAggregate } from './dailyAgg'

export const EXPORT_FORMAT = 'neckguardian-export'
export const EXPORT_FORMAT_VERSION = 1
/** CSV 前置 BOM，否则 Excel 打开中文表头是乱码。 */
export const CSV_BOM = '\ufeff'

export const TABLE_ORDER = [
  'settings',
  'posture_score',
  'posture_daily',
  'usage_record',
  'activity_log',
] as const

export type TableName = (typeof TABLE_ORDER)[number]

export type FieldKind = 'num' | 'str'

/** 每张表的字段与类型（顺序即导出时的键顺序）。 */
export const TABLE_FIELDS: Record<TableName, ReadonlyArray<readonly [string, FieldKind]>> = {
  settings: [
    ['key', 'str'],
    ['value', 'str'],
  ],
  posture_score: [
    ['timestamp', 'str'],
    ['head_angle', 'num'],
    ['shoulder_diff', 'num'],
    ['spine_angle', 'num'],
    ['score', 'num'],
  ],
  posture_daily: [
    ['date', 'str'],
    ['sample_count', 'num'],
    ['score_sum', 'num'],
    ['min_score', 'num'],
    ['head_bad_count', 'num'],
    ['shoulder_bad_count', 'num'],
    ['spine_bad_count', 'num'],
    ['updated_at', 'str'],
  ],
  usage_record: [
    ['date', 'str'],
    ['usage_minutes', 'num'],
    ['break_count', 'num'],
  ],
  activity_log: [
    ['timestamp', 'str'],
    ['activity_type', 'str'],
    ['exercise_count', 'num'],
    ['duration_sec', 'num'],
    ['avg_score', 'num'],
  ],
}

/** 排序键：让导出文件稳定，也让两端导入后落库顺序一致。 */
export const SORT_KEY: Record<TableName, string> = {
  settings: 'key',
  posture_score: 'timestamp',
  posture_daily: 'date',
  usage_record: 'date',
  activity_log: 'timestamp',
}

/**
 * 导出时**排除**的设置项。
 *
 * 它们是凭据，而导出文件是用户会随手放进网盘、发给自己的东西 —— 把 API Key 写进去
 * 等于泄露。导入时设置表用 upsert，所以「导出 → 导入」不会把本机的密钥抹掉。
 *
 * 被排除的项**不计入 `skipped`**：那不是脏数据，是有意的策略。
 * 界面上必须明说（"导出不包含 DeepSeek API Key"），否则用户会以为备份是全量的。
 */
export const SECRET_SETTING_KEYS = ['deepseek_api_key'] as const

/**
 * 数值字符串的严格形态 —— 必须与 Python 侧的 `_NUM_RE` 完全一致。
 *
 * ⚠️ 刻意**不用**各自的宽松转换：`Number('0x10')` 是 16，而 Python 的
 * `float('0x10')` 直接抛错；反过来 Python 的 `float('1_0')` 是 10、`Number('1_0')` 是 NaN。
 * 只认一个共同的正则，两端行为才真正相同。
 */
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

export interface ExportBundle {
  format: string
  format_version: number
  app_version: string
  schema_version: number
  exported_at: string
  tables: Record<TableName, Record<string, string | number>[]>
}

/**
 * 脏行计数是**调用方拿到的诊断信息**，不是数据，所以不放进 `bundle`。
 *
 * 理由：一旦写进文件，"导出 → 导入 → 再导出"就不是同一个文件了（第二遍已无脏行可跳），
 * 而备份/恢复的直觉是**同一个文件**。文件本身必须是纯数据。
 */
export type Skipped = Partial<Record<TableName, number>>

export type BuildResult = { bundle: ExportBundle; skipped: Skipped }

export type ValidationResult =
  | { ok: true; error: null; bundle: ExportBundle; skipped: Skipped }
  | { ok: false; error: string; bundle: null; skipped: Skipped }

/** 按共同规则取数值；失败返回 null（拒绝 NaN / Infinity）。 */
function num(v: unknown): number | null {
  if (typeof v === 'boolean') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const s = v.trim()
    if (!s || !NUM_RE.test(s)) return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 只接受真正的字符串。
 *
 * ⚠️ 数字/布尔**不做**隐式转换：Python 的 `str(True)` 是 `"True"`，
 * JS 的 `String(true)` 是 `"true"` —— 隐式转换会让两端导出同一个布尔值时
 * 得到不同的字符串。宁可跳过该行。
 */
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** 规范化一张表的行，返回 (规范行, 被跳过的行数)。 */
export function normalizeRows(
  table: TableName,
  rows: unknown[],
): [Record<string, string | number>[], number] {
  const fields = TABLE_FIELDS[table]
  const out: Record<string, string | number>[] = []
  let skipped = 0
  for (const raw of rows) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped += 1
      continue
    }
    const src = raw as Record<string, unknown>
    const row: Record<string, string | number> = {}
    let ok = true
    for (const [name, kind] of fields) {
      const value = kind === 'num' ? num(src[name]) : str(src[name])
      if (value === null) {
        ok = false
        break
      }
      row[name] = value
    }
    if (!ok) {
      skipped += 1
      continue
    }
    out.push(row)
  }
  const key = SORT_KEY[table]
  // Array.prototype.sort 自 ES2019 起保证稳定：并列时保持输入顺序，与 Python 的 sort 一致
  out.sort((a, b) => (String(a[key]) < String(b[key]) ? -1 : String(a[key]) > String(b[key]) ? 1 : 0))
  const filtered =
    table === 'settings' ? out.filter((r) => !SECRET_SETTING_KEYS.includes(r.key as never)) : out
  return [filtered, skipped]
}

/** 要写进文件的部分 —— **只有数据**，不含任何诊断信息（见 `Skipped` 的说明）。 */
function bundleOf(
  tables: Record<TableName, Record<string, string | number>[]>,
  appVersion: string,
  schemaVersion: number,
  exportedAt: string,
): ExportBundle {
  return {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    app_version: appVersion,
    schema_version: Math.trunc(schemaVersion || 0),
    exported_at: exportedAt,
    tables,
  }
}

/** 按表顺序整理诊断计数（键顺序稳定，方便两端比对与展示）。 */
function sortedSkipped(skipped: Skipped): Skipped {
  const out: Skipped = {}
  for (const t of TABLE_ORDER) {
    if (skipped[t]) out[t] = skipped[t]
  }
  return out
}

/** 组装导出包。返回 `{ bundle: <写入文件的内容>, skipped: {表名: 跳过行数} }`。 */
export function buildExport(
  tables: Partial<Record<TableName, unknown[]>>,
  appVersion = '',
  schemaVersion = 0,
  exportedAt = '',
): BuildResult {
  const out = {} as Record<TableName, Record<string, string | number>[]>
  const skipped: Skipped = {}
  for (const table of TABLE_ORDER) {
    const [rows, sk] = normalizeRows(table, (tables ?? {})[table] ?? [])
    out[table] = rows
    if (sk) skipped[table] = sk
  }
  return {
    bundle: bundleOf(out, String(appVersion ?? ''), Number(schemaVersion) || 0, String(exportedAt ?? '')),
    skipped: sortedSkipped(skipped),
  }
}

/**
 * 校验并规范化一个导入包。错误码是**约定的字符串**（两端必须同一个码）。
 *
 * 只接受当前 `format_version`（拒绝而不是尽力而为）：格式演进时静默兼容会让用户
 * 以为导入成功了，而数据其实是残缺的。
 */
export function validateExport(raw: unknown): ValidationResult {
  const empty: Skipped = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'not_an_object', bundle: null, skipped: empty }
  }
  const src = raw as Record<string, unknown>
  if (src.format !== EXPORT_FORMAT) {
    return { ok: false, error: 'bad_format', bundle: null, skipped: empty }
  }
  const version = num(src.format_version)
  if (version === null || version !== Math.trunc(version) || Math.trunc(version) !== EXPORT_FORMAT_VERSION) {
    return { ok: false, error: 'unsupported_version', bundle: null, skipped: empty }
  }
  const tables = src.tables
  if (tables === null || typeof tables !== 'object' || Array.isArray(tables)) {
    return { ok: false, error: 'missing_tables', bundle: null, skipped: empty }
  }
  const tableMap = tables as Record<string, unknown>

  const out = {} as Record<TableName, Record<string, string | number>[]>
  const skipped: Skipped = {}
  for (const table of TABLE_ORDER) {
    if (!Array.isArray(tableMap[table])) {
      return { ok: false, error: `missing_table:${table}`, bundle: null, skipped: empty }
    }
    const [rows, sk] = normalizeRows(table, tableMap[table] as unknown[])
    out[table] = rows
    if (sk) skipped[table] = sk
  }

  return {
    ok: true,
    error: null,
    bundle: bundleOf(
      out,
      str(src.app_version) ?? '',
      num(src.schema_version) ?? 0,
      str(src.exported_at) ?? '',
    ),
    skipped: sortedSkipped(skipped),
  }
}

// ---------------------------------------------------------------------------
// CSV（给人看的那一份）
//
// 只导出每日汇总：原始采样动辄数十万行，摊成 CSV 没人看得下去。
// ⚠️ 数字格式必须两端一致：`String(85)` 是 "85" 而 Python 的 `str(85.0)` 是 "85.0"，
// 所以派生量固定用一位小数（`toFixed(1)` ↔ `f"{x:.1f}"`），计数用整数形态。
// ---------------------------------------------------------------------------

export const DAILY_CSV_HEADER = [
  '日期',
  '采样数',
  '日均分',
  '最低分',
  '头部问题占比%',
  '肩部问题占比%',
  '脊柱问题占比%',
] as const

function csvField(text: string): string {
  if (text.includes(',') || text.includes('"') || text.includes('\n') || text.includes('\r')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function fmtInt(x: unknown): string {
  return String(Math.trunc(Number(x) || 0))
}

function fmt1(x: unknown): string {
  return (Number(x) || 0).toFixed(1)
}

/**
 * 每日汇总 CSV。行尾 CRLF（Excel 与 RFC 4180 的常规选择），两端一致。
 *
 * 🔴 开头必须是 `CSV_BOM`。中文表头不带 BOM 时，Windows 版 Excel 会按
 * 系统 ANSI 代码页解读，直接显示成乱码 —— 这正是导出 CSV 唯一的用途场景。
 */
export function buildDailyCsv(dailyRows: Array<Partial<DayAggregate> & { date?: string }>): string {
  const rows = [...dailyRows].sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? -1 : 1))
  const lines = [DAILY_CSV_HEADER.map(csvField).join(',')]
  for (const r of rows) {
    const day: DayAggregate = {
      sample_count: Number(r.sample_count ?? 0),
      score_sum: Number(r.score_sum ?? 0),
      min_score: Number(r.min_score ?? 0),
      head_bad_count: Number(r.head_bad_count ?? 0),
      shoulder_bad_count: Number(r.shoulder_bad_count ?? 0),
      spine_bad_count: Number(r.spine_bad_count ?? 0),
    }
    const fields = [
      r.date ?? '',
      fmtInt(day.sample_count),
      fmt1(dailyAvgScore(day)),
      fmtInt(day.min_score),
      fmt1(dailyBadPct(day, 'head')),
      fmt1(dailyBadPct(day, 'shoulder')),
      fmt1(dailyBadPct(day, 'spine')),
    ]
    lines.push(fields.map(csvField).join(','))
  }
  return CSV_BOM + lines.join('\r\n') + '\r\n'
}
