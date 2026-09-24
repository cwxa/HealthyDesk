/**
 * 本地日历日工具（移动端 / 纯浏览器）。
 *
 * 「哪一天」这件事必须**单点定义**：桌面端用 SQLite 的 `date(<ts>, 'localtime')`，
 * 移动端用本文件。两者口径不同的话，导出的数据在两端会落到不同的 `date` 上，
 * 归档层的日聚合也就没法互相合并（见 ROADMAP 需求 4）。
 *
 * 三条约定：
 * 1. 日边界是**本地时区**的零点，不是 UTC 零点。
 *    用户在 UTC+8 早上 7 点坐着，那属于「今天」—— 用 UTC 日会算到昨天。
 * 2. 时间戳一律是 `Date.prototype.toISOString()` 的格式（毫秒 + `Z`）。
 *    只有格式统一，字符串比较才等价于时间比较，`IDBKeyRange` 的范围查询才正确。
 * 3. 一天的区间是 `[start, end)`（左闭右开）。用「下一天零点」而不是「+24 小时」
 *    算 end，夏令时地区也不会漏/重。
 *
 * 本模块无副作用，可被 node 对拍脚本直接 bundle（`scripts/verify-daily-agg.mjs`）。
 */

/** 时间戳 → 本地日历日 `YYYY-MM-DD`。 */
export function dayKeyFromTs(ts: string): string {
  const d = new Date(ts)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 今天的本地日历日。 */
export function todayLocalDay(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${m}-${day}`
}

/** 本地日历日 → 该日 `[startIso, endIso)` 区间（ISO 串，可直接用于键范围查询）。 */
export function dayBoundsIso(day: string): [string, string] {
  // `YYYY-MM-DDT00:00:00`（不带时区）按 ECMAScript 规范被解析为**本地**时间
  const start = new Date(`${day}T00:00:00`)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  return [start.toISOString(), end.toISOString()]
}

/** 本地日历日 ± N 天。 */
export function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00`)
  d.setDate(d.getDate() + deltaDays)
  return todayLocalDay(d)
}
