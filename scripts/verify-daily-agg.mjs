/**
 * 日聚合等价性验证：把前端 **真实源码** src/platform/dailyAgg.ts（+ localDay.ts）
 * 与 Python 后端 services/daily_agg.py（+ services/retention.py）做数值比对。
 *
 * 用法：
 *   1. 先由 Python 生成期望值：python scripts/gen-daily-agg-cases.py > scripts/daily-agg-expected.json
 *   2. node scripts/verify-daily-agg.mjs
 *
 * 为什么需要这条守卫：`posture_daily` 是**归档**层 —— 原始采样被清理之后，很长一段
 * 时间的"日级历史"就只剩它了。而日级数字现在被仪表盘的今日均分、趋势、周均分消费
 * （与后端 `api/stats.py` / 前端 `localStats.ts` 对应）。所以两端**必须逐位一致**，
 * 否则会出现"手机显示今天 85.9、电脑显示 86.0"——和 scorer 当初踩的坑一模一样。
 *
 * 校验六层：
 *   a) 常量：三项阈值 + 保留天数两端相等
 *   b) 映射：部位 → 采样字段名 + 该部位阈值
 *   c) 用例：21 条逐字段（6 个精确量 + 日均分 + 各问题占比）
 *   d) 合并：4 条 + 精确相加断言
 *   e) 本地日口径：日边界区间 + ±N 天
 *   f) 语义硬断言 + 可结合性不变量 + 取整灵敏度自检
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const require = createRequire(join(ROOT, 'package.json'))

/** 把前端源码 bundle 出来，并额外导出内部符号（评分常量、本地日工具）供比对。 */
async function loadFrontendSource() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    console.error('✗ 找不到 esbuild（vite 的依赖）。请先 npm install。')
    process.exit(2)
  }

  // 额外 import 两个模块：scoringModel（阈值常量）与 localDay（日期口径）。
  // 两者都无副作用，可安全 bundle 进 node 执行。
  // ⚠️ 导出名与 import 名不能相同（同一模块作用域里会重复声明，esbuild 会静默改名）。
  const EXPOSE = `
import * as __scoringModel from './scoringModel';
import * as __localDayMod from './localDay';
export const __constants = { ...__scoringModel, RETENTION_DAYS };
export const __localDay = __localDayMod;
`

  const built = await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'platform', 'dailyAgg.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [
      {
        name: 'expose-internals',
        setup(b) {
          b.onLoad({ filter: /dailyAgg\.ts$/ }, (args) => ({
            contents: readFileSync(args.path, 'utf8') + EXPOSE,
            loader: 'ts',
          }))
        },
      },
    ],
  })

  const out = join(tmpdir(), `neckguardian-daily-agg-${process.pid}.mjs`)
  writeFileSync(out, built.outputFiles[0].text)
  const mod = await import(pathToFileURL(out).href)
  try {
    unlinkSync(out)
  } catch {
    /* 删除失败不影响校验结果 */
  }
  return {
    aggregateDay: mod.aggregateDay,
    dailyAvgScore: mod.dailyAvgScore,
    dailyBadPct: mod.dailyBadPct,
    mergeDays: mod.mergeDays,
    PARTS: mod.PARTS,
    EMPTY_DAY: mod.EMPTY_DAY,
    constants: mod.__constants,
    localDay: mod.__localDay,
  }
}

const EXACT_FIELDS = ['sample_count', 'score_sum', 'min_score', 'head_bad_count', 'shoulder_bad_count', 'spine_bad_count']
const PARTS = ['head', 'shoulder', 'spine']

/** 真正被测的"结果"：精确量 + 两个派生量。 */
function tsResult(api, rows) {
  const agg = api.aggregateDay(rows)
  return {
    ...agg,
    avg_score: api.dailyAvgScore(agg),
    bad_pct: {
      head: api.dailyBadPct(agg, 'head'),
      shoulder: api.dailyBadPct(agg, 'shoulder'),
      spine: api.dailyBadPct(agg, 'spine'),
    },
  }
}

function diffFields(a, b) {
  const bad = []
  for (const k of EXACT_FIELDS) {
    if (a[k] !== b[k]) bad.push(`${k}: ts=${a[k]} py=${b[k]}`)
  }
  if (a.avg_score !== b.avg_score) bad.push(`avg_score: ts=${a.avg_score} py=${b.avg_score}`)
  for (const p of PARTS) {
    if (a.bad_pct[p] !== b.bad_pct[p]) bad.push(`bad_pct.${p}: ts=${a.bad_pct[p]} py=${b.bad_pct[p]}`)
  }
  return bad
}

/**
 * 与源码同输入、**只把取整换成 `Math.round`** 的变体 —— 唯一的差异。
 * 用途见 §f 的灵敏度自检：如果没有任何用例能区分两者，这条守卫对
 * "取整实现被换掉"就是瞎的。
 */
function makeMathRoundVariant(api) {
  return (rows) => {
    const agg = api.aggregateDay(rows)
    const n = agg.sample_count
    return {
      ...agg,
      avg_score: n > 0 ? Math.round((agg.score_sum / n) * 10) / 10 : 0,
      bad_pct: {
        head: n > 0 ? Math.round((agg.head_bad_count / n) * 100 * 10) / 10 : 0,
        shoulder: n > 0 ? Math.round((agg.shoulder_bad_count / n) * 100 * 10) / 10 : 0,
        spine: n > 0 ? Math.round((agg.spine_bad_count / n) * 100 * 10) / 10 : 0,
      },
    }
  }
}

async function main() {
  const expectedPath = join(__dirname, 'daily-agg-expected.json')
  let payload
  try {
    payload = JSON.parse(readFileSync(expectedPath, 'utf8'))
  } catch {
    console.error(`✗ 找不到 ${expectedPath}，请先运行：python scripts/gen-daily-agg-cases.py > scripts/daily-agg-expected.json`)
    process.exit(2)
  }

  const api = await loadFrontendSource()
  let failed = false

  // ---- a) 常量比对 ----
  let constFail = 0
  let constChecked = 0
  for (const [name, value] of Object.entries(payload.constants)) {
    constChecked++
    if (api.constants[name] !== value) {
      console.error(`✗ 常量不一致 ${name}: python=${value} ts=${api.constants[name]}`)
      constFail++
    }
  }
  if (constFail > 0) failed = true
  console.log(`常量比对（Python ↔ 前端真实源码）：${constChecked} 项${constFail ? ` 有 ${constFail} 项差异` : '全部一致'}`)

  // ---- b) 部位 → 字段映射 + 该部位阈值 ----
  let mapFail = 0
  const tsParts = api.PARTS.map((p) => [p[0], p[1], p[2]])
  for (let i = 0; i < payload.parts.length; i++) {
    const py = payload.parts[i]
    const ts = tsParts[i]
    if (!ts || py[0] !== ts[0] || py[1] !== ts[1] || py[2] !== ts[2]) {
      console.error(`✗ 部位映射不一致 [${i}]: python=${JSON.stringify(py)} ts=${JSON.stringify(ts)}`)
      mapFail++
    }
  }
  if (mapFail > 0) failed = true
  console.log(`部位→字段映射（含阈值）：${payload.parts.length} 项${mapFail ? ` 有 ${mapFail} 项差异` : '全部一致'}`)

  // ---- c) 用例逐字段比对 ----
  let pass = 0
  let mismatch = 0
  for (const c of payload.cases) {
    const got = tsResult(api, c.rows)
    const diffs = diffFields(got, c.expected)
    if (diffs.length === 0) {
      pass++
    } else {
      mismatch++
      if (mismatch <= 6) {
        console.error(`✗ 不一致「${c.name}」n=${c.rows.length}`)
        for (const d of diffs.slice(0, 6)) console.error(`    ${d}`)
      }
    }
  }
  console.log(`\n日聚合等价性：${pass} 通过 / ${mismatch} 失败（共 ${payload.cases.length} 条）`)
  if (mismatch > 0) failed = true

  // ---- d) 合并用例 ----
  let mergePass = 0
  let mergeFail = 0
  for (const c of payload.merge_cases) {
    const merged = api.mergeDays(c.days)
    const got = {
      ...merged,
      avg_score: api.dailyAvgScore(merged),
      bad_pct: {
        head: api.dailyBadPct(merged, 'head'),
        shoulder: api.dailyBadPct(merged, 'shoulder'),
        spine: api.dailyBadPct(merged, 'spine'),
      },
    }
    const diffs = diffFields(got, c.expected)
    if (diffs.length === 0) mergePass++
    else {
      mergeFail++
      console.error(`✗ 合并不一致「${c.name}」`)
      for (const d of diffs.slice(0, 6)) console.error(`    ${d}`)
    }
  }
  console.log(`合并等价性：${mergePass} 通过 / ${mergeFail} 失败（共 ${payload.merge_cases.length} 条）`)
  if (mergeFail > 0) failed = true

  // ---- d2) 合并必须是**精确相加**，不是"日均分的平均" ----
  // 这是归档层最容易被改错的地方：如果哪天有人图省事在表里存 avg_score 然后再求平均，
  // 计数不同的两天就会被等权对待（4 条的一天与 2 条的一天同样重）。
  let sumFail = 0
  for (const [name, exp] of Object.entries(payload.merge_sums)) {
    const c = payload.merge_cases.find((x) => x.name === name)
    if (!c) {
      console.error(`✗ 合并精确相加用例缺失：${name}`)
      sumFail++
      continue
    }
    const merged = api.mergeDays(c.days)
    for (const k of EXACT_FIELDS) {
      if (merged[k] !== exp[k]) {
        console.error(`✗ 合并「${name}」字段 ${k}: ts=${merged[k]} py=${exp[k]}（精确相加被破坏）`)
        sumFail++
      }
    }
  }
  if (sumFail > 0) failed = true
  console.log(sumFail ? `✗ 合并精确相加：${sumFail} 处失败` : '✓ 合并是精确相加（和相加、计数相加、min 取最小）')

  // ---- e) 本地日口径 ----
  let dayFail = 0
  let dayChecked = 0
  for (const [day, bounds] of Object.entries(payload.day_bounds)) {
    dayChecked++
    const got = api.localDay.dayBoundsIso(day)
    if (got[0] !== bounds[0] || got[1] !== bounds[1]) {
      console.error(`✗ 日边界不一致 ${day}: ts=${JSON.stringify(got)} py=${JSON.stringify(bounds)}`)
      dayFail++
    }
    // 边界必须连续：end(day) === start(day+1)
    const next = api.localDay.dayBoundsIso(api.localDay.shiftDay(day, 1))
    if (next[0] !== got[1]) {
      console.error(`✗ 日边界不连续 ${day}: end=${got[1]} 下一天 start=${next[0]}`)
      dayFail++
    }
  }
  for (const s of payload.shift_cases) {
    dayChecked++
    const got = api.localDay.shiftDay(s.day, s.delta)
    if (got !== s.expected) {
      console.error(`✗ shiftDay 不一致 ${s.day} ${s.delta}: ts=${got} py=${s.expected}`)
      dayFail++
    }
  }
  if (dayFail > 0) failed = true
  console.log(`本地日口径（日边界区间 + ±N 天）：${dayChecked} 项${dayFail ? ` 有 ${dayFail} 项差异` : '全部一致'}`)

  // ---- f1) 阈值语义硬断言：恰等于阈值不算问题、超一点点就算 ----
  const boundary = [
    { name: '边界·头部恰等于阈值（不算问题）', expect: 0 },
    { name: '边界·头部刚超阈值（算问题）', expect: 1 },
    { name: '边界·肩部恰等于阈值（不算问题）', expect: 0 },
    { name: '边界·肩部刚超阈值（算问题）', expect: 1 },
    { name: '边界·脊柱恰等于阈值（不算问题）', expect: 0 },
    { name: '边界·脊柱刚超阈值（算问题）', expect: 1 },
  ]
  let semFail = 0
  for (const b of boundary) {
    const c = payload.cases.find((x) => x.name === b.name)
    if (!c) {
      console.error(`✗ 语义用例缺失：${b.name}`)
      semFail++
      continue
    }
    const agg = api.aggregateDay(c.rows)
    const total = agg.head_bad_count + agg.shoulder_bad_count + agg.spine_bad_count
    if (total !== b.expect) {
      console.error(`✗ 阈值语义「${b.name}」：问题数 ${total}，应为 ${b.expect}`)
      semFail++
    }
  }
  if (semFail > 0) failed = true
  console.log(semFail ? `✗ 阈值语义：${semFail} 条失败` : `✓ 阈值语义成立：严格大于阈值才算问题（${boundary.length} 条）`)

  // ---- f2) 空的一天 ----
  const empty = tsResult(api, [])
  const emptyOk =
    empty.sample_count === 0 &&
    empty.score_sum === 0 &&
    empty.min_score === 0 &&
    empty.avg_score === 0 &&
    PARTS.every((p) => empty.bad_pct[p] === 0)
  if (!emptyOk) {
    console.error(`✗ 空的一天应全为 0（不是 NaN），实际：${JSON.stringify(empty)}`)
    failed = true
  } else {
    console.log('✓ 空的一天返回全 0（不是 NaN）')
  }

  // ---- f3) 可结合性不变量 ----
  // 先按天聚合、再跨天合并  ===  把两天的原始行拼起来一次聚合。
  // 这条不变量保证"归档 + 合并"与"直接算全部"给出同一个数 —— 也就是
  // 归档层在数学上是无损的。它同时会抓住 min_score / bad_count 之类忘记合并的字段。
  let assocFail = 0
  let assocChecked = 0
  const assocSources = payload.cases.filter((c) => c.rows.length >= 4)
  for (const c of assocSources) {
    for (const frac of [0.5, 0.25]) {
      const cut = Math.floor(c.rows.length * frac)
      const a = c.rows.slice(0, cut)
      const b = c.rows.slice(cut)
      const split = api.mergeDays([api.aggregateDay(a), api.aggregateDay(b)])
      const whole = api.aggregateDay(c.rows)
      assocChecked++
      for (const k of EXACT_FIELDS) {
        if (split[k] !== whole[k]) {
          console.error(`✗ 可结合性被破坏「${c.name}」split=${frac} 字段 ${k}: 分天合并=${split[k]} 整体=${whole[k]}`)
          assocFail++
        }
      }
    }
  }
  if (assocFail > 0) failed = true
  console.log(
    assocFail
      ? `✗ 可结合性：${assocFail} 处失败`
      : `✓ 可结合性成立：${assocChecked} 组「先分天聚合再合并」== 「整体一次性聚合」`,
  )

  // ---- f4) 取整灵敏度自检（守卫的守卫）----
  const mathRound = makeMathRoundVariant(api)
  let sensitive = 0
  const sensitiveNames = []
  for (const c of payload.cases) {
    const a = tsResult(api, c.rows)
    const b = mathRound(c.rows)
    if (a.avg_score !== b.avg_score || PARTS.some((p) => a.bad_pct[p] !== b.bad_pct[p])) {
      sensitive++
      if (sensitiveNames.length < 4) sensitiveNames.push(c.name)
    }
  }
  if (sensitive === 0) {
    console.error('✗ 取整灵敏度为 0：没有任何用例能区分「平局取偶」与「Math.round」')
    console.error('  → 这条守卫对取整实现的漂移毫无灵敏度，请补充取整平局点用例')
    failed = true
  } else {
    console.log(`✓ 取整灵敏度自检：${sensitive} 条用例能区分平局取偶 / Math.round（例：${sensitiveNames.join('、')}）`)
  }

  if (failed) process.exit(1)
  console.log('✓ 前端 TS 与 Python 后端的日聚合/合并/日界口径完全一致')
}

main()
