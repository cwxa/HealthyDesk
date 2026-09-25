/**
 * 日粒度聚合 —— `backend/services/daily_agg.py` 的逐位等价实现（移动端侧）。
 *
 * ⚠️ 本文件必须与 Python 侧**逐位一致**，由 `scripts/verify-daily-agg.mjs` 守住
 * （常量 + 用例逐字段比对 + 取整平局点）。改这里必须同步改 Python，反之亦然。
 *
 * 设计要点见 Python 文件顶部注释，摘要：
 * - 只存**精确量**（`score_sum` / `*_bad_count`），派生量由 `dailyAvgScore` /
 *   `dailyBadPct` 现算 —— 归档层要经得起跨天合并，不能把取整烙进去。
 * - 「坏值」= 该部位指标 **严格大于**自己的阈值（等价于"这一帧该部位会被提醒"）；
 *   预警区（扣分但不产 issues）**不算**问题。
 * - 本模块**无副作用**：不碰 IndexedDB、不 import mediapipe，因此可被 node 对拍脚本
 *   直接 bundle 执行（见 `scripts/verify-daily-agg.mjs`）。IndexedDB 的读写薄层在
 *   `localMaintenance.ts`，不要挪进来。
 */

import {
  HEAD_TILT_THRESHOLD,
  SHOULDER_DIFF_THRESHOLD,
  SPINE_ANGLE_THRESHOLD,
  pyRound1,
} from './scoringModel'

/**
 * 原始采样保留天数（与后端 `config.py` 的 `RETENTION_DAYS` 同值）。
 *
 * 放在这里而不是某个"配置模块"，是为了让它被对拍脚本一起 bundle —— 两端保留期
 * 不一致会出现"电脑说还有 30 天数据、手机只剩 7 天"这种没法查的问题。
 */
export const RETENTION_DAYS = 30
export const MIN_RETENTION_DAYS = 7
export const MAX_RETENTION_DAYS = 365

/**
 * 把用户填的保留天数收敛到合法区间（与 Python 的 `config.clamp_retention_days` 同语义）。
 *
 * 🔴 单点定义：两端的上下界与回落值必须一致，否则会出现"电脑保留 30 天、
 * 手机保留 1 天"——而 1 天就把历史删干净了。
 *
 * 规则（与 Python 侧逐条对齐，每一处差异都实测过）：
 * - 布尔 → 回落默认值（Python 的 `int(True)` 是 1，会让两端给出 7 与 30 两个答案）
 * - 数字 → 向零取整（`Math.trunc(30.9) === 30`，与 Python 的 `int()` 一致）
 * - 字符串 → **只认纯整数**（`^[+-]?\d+$`）：`parseInt` 会接受 `"45abc"`，Python 的
 *   `int()` 不接受 —— 用共同的正则才等价
 * - 其它（null / 对象）→ 回落默认值
 * - 非法输入一律回落**默认值 30**（不是最小值）：填错不该导致最多数据被删
 */
export function clampRetentionDays(value: unknown): number {
  let n: number
  if (typeof value === 'boolean') {
    return RETENTION_DAYS
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) return RETENTION_DAYS
    n = Math.trunc(value)
  } else if (typeof value === 'string') {
    const s = value.trim()
    if (!/^[+-]?\d+$/.test(s)) return RETENTION_DAYS
    n = Number(s)
  } else {
    return RETENTION_DAYS
  }
  if (n < MIN_RETENTION_DAYS) return MIN_RETENTION_DAYS
  if (n > MAX_RETENTION_DAYS) return MAX_RETENTION_DAYS
  return n
}

/** 一天的聚合结果（与 `posture_daily` 表的列一一对应，仅存精确量）。 */
export interface DayAggregate {
  sample_count: number
  score_sum: number
  min_score: number
  head_bad_count: number
  shoulder_bad_count: number
  spine_bad_count: number
}

/** 参与聚合的采样行。与 `PostureRecord` 的字段名保持一致。 */
export interface AggregateInputRow {
  head_angle: number
  shoulder_diff: number
  spine_angle: number
  score: number
}

export const EMPTY_DAY: DayAggregate = {
  sample_count: 0,
  score_sum: 0,
  min_score: 0,
  head_bad_count: 0,
  shoulder_bad_count: 0,
  spine_bad_count: 0,
}

// (输出字段前缀, 采样行字段名, 阈值)。顺序与 Python 侧 PARTS 一致。
export const PARTS: ReadonlyArray<readonly [string, keyof AggregateInputRow, number]> = [
  ['head', 'head_angle', HEAD_TILT_THRESHOLD],
  ['shoulder', 'shoulder_diff', SHOULDER_DIFF_THRESHOLD],
  ['spine', 'spine_angle', SPINE_ANGLE_THRESHOLD],
]

/** 把一天内的采样折成一行统计。纯函数：同样的行 → 同样的输出。 */
export function aggregateDay(rows: AggregateInputRow[]): DayAggregate {
  const n = rows.length
  if (n === 0) return { ...EMPTY_DAY }

  const scores: number[] = []
  let total = 0
  const bad: Record<string, number> = { head: 0, shoulder: 0, spine: 0 }

  // 三段循环而不是一次遍历：与 Python 侧保持**同样的运算顺序**，
  // 浮点累加顺序一致才能保证逐位相同。
  for (const r of rows) scores.push(Number(r.score))
  for (const s of scores) total += s
  for (const r of rows) {
    for (const [prefix, field, threshold] of PARTS) {
      if (Number(r[field]) > threshold) bad[prefix] += 1
    }
  }

  return {
    sample_count: n,
    score_sum: total,
    min_score: Math.min(...scores),
    head_bad_count: bad.head,
    shoulder_bad_count: bad.shoulder,
    spine_bad_count: bad.spine,
  }
}

/** 日均分（一位小数）。空的一天返回 0 —— 与后端历史口径一致（无数据显示 0）。 */
export function dailyAvgScore(day: DayAggregate): number {
  const n = Number(day.sample_count ?? 0)
  if (n <= 0) return 0
  return pyRound1(Number(day.score_sum) / n)
}

const BAD_KEYS: Record<string, keyof DayAggregate> = {
  head: 'head_bad_count',
  shoulder: 'shoulder_bad_count',
  spine: 'spine_bad_count',
}

/** 某部位「有问题」的采样占比（%，一位小数）。空的一天返回 0。 */
export function dailyBadPct(day: DayAggregate, part: 'head' | 'shoulder' | 'spine'): number {
  const key = BAD_KEYS[part]
  if (!key) throw new Error(`unknown part: ${part}`)
  const n = Number(day.sample_count ?? 0)
  if (n <= 0) return 0
  return pyRound1((Number(day[key]) / n) * 100)
}

/** 把若干天合并成一行（周/月均分用）。计数相加、和多加，**不做加权平均**。 */
export function mergeDays(days: DayAggregate[]): DayAggregate {
  const out: DayAggregate = { ...EMPTY_DAY }
  const mins: number[] = []
  for (const d of days) {
    const n = Number(d.sample_count ?? 0)
    if (n <= 0) continue
    out.sample_count += n
    out.score_sum += Number(d.score_sum)
    mins.push(Number(d.min_score))
    out.head_bad_count += Number(d.head_bad_count)
    out.shoulder_bad_count += Number(d.shoulder_bad_count)
    out.spine_bad_count += Number(d.spine_bad_count)
  }
  out.min_score = mins.length > 0 ? Math.min(...mins) : 0
  return out
}
