/**
 * 导出/导入格式等价性验证：把前端 **真实源码** src/platform/exportFormat.ts
 * （+ dailyAgg.ts 的保留策略常量）与 Python 后端 services/export_format.py 做逐字比对。
 *
 * 用法：
 *   1. 先由 Python 生成期望值：python scripts/gen-export-cases.py > scripts/export-expected.json
 *   2. node scripts/verify-export-format.mjs
 *
 * 为什么需要这条守卫：导出文件的**唯一价值**就是"两端能互相导入"。
 * 表名/字段名/类型转换规则/排序/错误码，任何一处两端不一致，结果都是
 * "能导入但数字对不上"或者"根本导不进去" —— 而这恰恰是用户唯一的数据出路
 * （移动端卸载即清除）。所以这里比对到"逐字"级别。
 *
 * 校验五层：
 *   a) 常量：格式标识/版本/BOM/表顺序/每表字段与类型/排序键/CSV 表头/保留天数上下界
 *   b) build_export：规范化 + 稳定排序 + 脏行跳过计数（3 条）
 *   c) validate_export：合法包 + 每种错误码（14 条）
 *   d) CSV 精确文本 + clamp_retention_days 回落值
 *   e) 硬断言：round-trip、禁止隐式类型转换、CSV 数字格式灵敏度自检
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const require = createRequire(join(ROOT, 'package.json'))

async function loadFrontendSource() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    console.error('✗ 找不到 esbuild（vite 的依赖）。请先 npm install。')
    process.exit(2)
  }

  // ⚠️ 导出名不能与 import 名相同（同一模块作用域里会重复声明，esbuild 会静默改名）
  const EXPOSE = `
import * as __dailyAggMod from './dailyAgg';
export const __dailyAgg = __dailyAggMod;
`

  const built = await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'platform', 'exportFormat.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [
      {
        name: 'expose-internals',
        setup(b) {
          b.onLoad({ filter: /exportFormat\.ts$/ }, (args) => ({
            contents: readFileSync(args.path, 'utf8') + EXPOSE,
            loader: 'ts',
          }))
        },
      },
    ],
  })

  const out = join(tmpdir(), `neckguardian-export-${process.pid}.mjs`)
  writeFileSync(out, built.outputFiles[0].text)
  const mod = await import(pathToFileURL(out).href)
  try {
    unlinkSync(out)
  } catch {
    /* 删除失败不影响校验结果 */
  }
  return mod
}

/** 递归深比较（只用 JSON 可表示的值：对象/数组/字符串/数字/布尔/null）。 */
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b)
  const ka = Object.keys(a)
  const kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false
    if (!deepEqual(a[k], b[k])) return false
  }
  return true
}

function firstDiff(a, b, path = '') {
  if (deepEqual(a, b)) return null
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return `${path}: ts=${JSON.stringify(a)} py=${JSON.stringify(b)}`
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], path ? `${path}.${k}` : k)
    if (d) return d
  }
  return `${path}: (结构不同)`
}

async function main() {
  const expectedPath = join(__dirname, 'export-expected.json')
  let payload
  try {
    payload = JSON.parse(readFileSync(expectedPath, 'utf8'))
  } catch {
    console.error(`✗ 找不到 ${expectedPath}，请先运行：python scripts/gen-export-cases.py > scripts/export-expected.json`)
    process.exit(2)
  }

  const mod = await loadFrontendSource()
  const agg = mod.__dailyAgg
  let failed = false

  // ---- a) 常量 ----
  const lookup = (name) => (name in mod ? mod[name] : agg[name])
  let constFail = 0
  const constNames = Object.keys(payload.constants)
  for (const name of constNames) {
    const ts = lookup(name)
    const py = payload.constants[name]
    // 只比较"形状与值"，不看顺序（对象键顺序在两端本就不同）
    if (!deepEqual(ts, py)) {
      console.error(`✗ 常量不一致 ${name}: ${firstDiff(ts, py) || '值不同'}`)
      constFail++
    }
  }
  if (constFail > 0) failed = true
  console.log(`常量比对（Python ↔ 前端真实源码）：${constNames.length} 项${constFail ? ` 有 ${constFail} 项差异` : '全部一致'}`)

  // ---- b) build_export ----
  let buildPass = 0
  let buildFail = 0
  for (const c of payload.build_cases) {
    const got = mod.buildExport(c.tables, c.app_version, c.schema_version, c.exported_at)
    if (deepEqual(got, c.expected)) buildPass++
    else {
      buildFail++
      console.error(`✗ 导出包不一致「${c.name}」`)
      console.error(`    ${firstDiff(got, c.expected)}`)
    }
  }
  console.log(`\n导出包组装：${buildPass} 通过 / ${buildFail} 失败（共 ${payload.build_cases.length} 条）`)
  if (buildFail > 0) failed = true

  // ---- c) validate_export ----
  let valPass = 0
  let valFail = 0
  for (const c of payload.validate_cases) {
    const got = mod.validateExport(c.raw)
    const ok = got.ok === c.expected.ok && got.error === c.expected.error && deepEqual(got.bundle, c.expected.bundle)
    if (ok) valPass++
    else {
      valFail++
      console.error(`✗ 校验结果不一致「${c.name}」`)
      console.error(`    ${firstDiff(got, c.expected)}`)
    }
  }
  console.log(`导入包校验：${valPass} 通过 / ${valFail} 失败（共 ${payload.validate_cases.length} 条）`)
  if (valFail > 0) failed = true

  // ---- d1) CSV 精确文本 ----
  let csvPass = 0
  let csvFail = 0
  for (const c of payload.csv_cases) {
    const got = mod.buildDailyCsv(c.rows)
    if (got === c.expected) csvPass++
    else {
      csvFail++
      console.error(`✗ CSV 不一致「${c.name}」`)
      console.error(`    ts=${JSON.stringify(got)}`)
      console.error(`    py=${JSON.stringify(c.expected)}`)
    }
  }
  console.log(`CSV 文本：${csvPass} 通过 / ${csvFail} 失败（共 ${payload.csv_cases.length} 条）`)
  if (csvFail > 0) failed = true

  // BOM 是"死常量"的高发点：CSV_BOM 定义了、两端都定义了，但生成函数忘了拼上去 ——
  // 于是对拍全绿，而 Windows Excel 打开中文表头是乱码（导出 CSV 的唯一用途场景）。
  // 所以这条断言盯的是**效果**（字符串真的以 BOM 开头），不是常量值。
  const csvWithBom =
    mod.buildDailyCsv(payload.csv_cases[0].rows).startsWith(payload.constants.CSV_BOM) &&
    mod.buildDailyCsv([]).startsWith(payload.constants.CSV_BOM)
  if (csvWithBom) {
    console.log('✓ CSV 以 BOM 开头：中文表头在 Windows Excel 里不会乱码')
  } else {
    console.error('✗ CSV 未以 BOM 开头（CSV_BOM 被定义了却没拼到输出里）')
    failed = true
  }

  // ---- d2) clamp_retention_days ----
  let clampFail = 0
  for (const c of payload.clamp_cases) {
    const got = agg.clampRetentionDays(c.input)
    if (got !== c.expected) {
      console.error(`✗ 保留天数收敛不一致 input=${JSON.stringify(c.input)}: ts=${got} py=${c.expected}`)
      clampFail++
    }
  }
  console.log(`保留天数收敛：${payload.clamp_cases.length} 项${clampFail ? ` 有 ${clampFail} 项差异` : '全部一致'}`)
  if (clampFail > 0) failed = true

  // ---- d3) 非有限数（inf / NaN）：JSON 表示不了，两端各自构造输入 ----
  const tsOf = (h) => `2026-09-25T0${h}:00:00.000Z`
  const nonFiniteValues = { inf: Infinity, neg_inf: -Infinity, nan: NaN }
  const rows = payload.non_finite.specs.map((spec) => ({
    timestamp: tsOf(3),
    head_angle: 1,
    shoulder_diff: 1,
    spine_angle: 1,
    score: nonFiniteValues[spec],
  }))
  rows.push({ timestamp: tsOf(4), head_angle: 1, shoulder_diff: 1, spine_angle: 1, score: 88 })
  const emptyTables = {}
  for (const t of payload.constants.TABLE_ORDER) emptyTables[t] = []
  const got = mod.validateExport({
    format: payload.constants.EXPORT_FORMAT,
    format_version: payload.constants.EXPORT_FORMAT_VERSION,
    tables: { ...emptyTables, posture_score: rows },
  })
  const nfOk =
    got.ok === payload.non_finite.expected_ok &&
    (got.skipped?.posture_score ?? 0) === payload.non_finite.expected_skipped &&
    deepEqual(got.bundle.tables.posture_score, payload.non_finite.expected_rows)
  if (!nfOk) {
    console.error(`✗ 非有限数（inf/NaN）处理不一致`)
    console.error(`    ${firstDiff(got.bundle, { tables: { posture_score: payload.non_finite.expected_rows } })}`)
    failed = true
  } else {
    console.log(`✓ 非有限数（inf / -inf / NaN）被跳过并计数（skipped=${payload.non_finite.expected_skipped}）`)
  }

  // ---- e1) round-trip：备份/恢复的直觉是"同一个文件" ----
  // 两件事都要成立：
  //   (1) 导入我导出的文件，数据逐字段不变
  //   (2) 用它再导出一次，得到**完全相同**的文件（这也是 `skipped` 不写进文件的原因）
  let rtFail = 0
  for (const c of payload.build_cases) {
    const built = mod.buildExport(c.tables, c.app_version, c.schema_version, c.exported_at)
    const back = mod.validateExport(JSON.parse(JSON.stringify(built.bundle)))
    if (!back.ok || !deepEqual(back.bundle, built.bundle)) {
      console.error(`✗ round-trip 失败「${c.name}」：${firstDiff(back.bundle, built.bundle)}`)
      rtFail++
      continue
    }
    const again = mod.buildExport(
      back.bundle.tables,
      back.bundle.app_version,
      back.bundle.schema_version,
      back.bundle.exported_at,
    )
    if (!deepEqual(again.bundle, built.bundle)) {
      console.error(`✗ 再导出不一致「${c.name}」：${firstDiff(again.bundle, built.bundle)}`)
      rtFail++
    }
  }
  if (rtFail > 0) failed = true
  console.log(rtFail ? `✗ round-trip：${rtFail} 条失败` : `✓ round-trip 成立：${payload.build_cases.length} 个包「导出 →（JSON 往返）→ 导入 → 再导出」逐字段不变`)

  // ---- e2) 禁止隐式类型转换 ----
  // 布尔/数字**不得**被悄悄转成字符串：Python 的 str(True) 是 "True"、JS 的 String(true) 是
  // "true" —— 一旦隐式转换，两端导出同一个布尔值会得到不同文件。
  // 断言方式：给 settings.value 塞布尔与数字，它们必须出现在 skipped 里而不是被转换。
  const coercion = mod.validateExport({
    format: payload.constants.EXPORT_FORMAT,
    format_version: payload.constants.EXPORT_FORMAT_VERSION,
    tables: {
      ...emptyTables,
      settings: [
        { key: 'a', value: true },
        { key: 'b', value: 5 },
        { key: 'c', value: 'ok' },
      ],
    },
  })
  const coercionOk =
    coercion.ok === true &&
    coercion.skipped?.settings === 2 &&
    coercion.bundle.tables.settings.length === 1 &&
    coercion.bundle.tables.settings[0].value === 'ok'
  if (!coercionOk) {
    console.error(`✗ 类型转换策略不一致：${JSON.stringify(coercion.bundle)} skipped=${JSON.stringify(coercion.skipped)}`)
    failed = true
  } else {
    console.log('✓ 禁止隐式类型转换：布尔/数字不会被悄悄转成字符串（跳过并计数）')
  }

  // ---- e3) CSV 数字格式灵敏度自检 ----
  // 如果没有任何一条 CSV 用例能区分 `toFixed(1)` 与 `String(x)`，那"整数日均分被输出成 90
  // 而不是 90.0"这件事这条守卫是发现不了的。用它当尺子量一下自己的灵敏度。
  //
  // ⚠️ `naive` 必须**同样带 BOM**：否则每次比较都只差一个 BOM，灵敏度自检会被
  // "BOM 差异"喂饱（每个用例都算"有区别"），真实的 `toFixed` 回归就再也抓不到了。
  const naive = (dailyRows) => {
    const sorted = [...dailyRows].sort((a, b) => ((a.date ?? '') < (b.date ?? '') ? -1 : 1))
    const lines = [payload.constants.DAILY_CSV_HEADER.join(',')]
    for (const r of sorted) {
      const n = Number(r.sample_count ?? 0)
      const avg = agg.dailyAvgScore({
        sample_count: n,
        score_sum: Number(r.score_sum ?? 0),
        min_score: Number(r.min_score ?? 0),
        head_bad_count: Number(r.head_bad_count ?? 0),
        shoulder_bad_count: Number(r.shoulder_bad_count ?? 0),
        spine_bad_count: Number(r.spine_bad_count ?? 0),
      })
      lines.push([r.date ?? '', String(n), String(avg), String(r.min_score ?? 0), '0', '0', '0'].join(','))
    }
    return payload.constants.CSV_BOM + lines.join('\r\n') + '\r\n'
  }
  let csvSensitive = 0
  for (const c of payload.csv_cases) {
    if (mod.buildDailyCsv(c.rows) !== naive(c.rows)) csvSensitive++
  }
  if (csvSensitive === 0) {
    console.error('✗ CSV 数字格式灵敏度为 0：没有用例能区分「固定一位小数」与 `String()`')
    console.error('  → 请补一条整数日均分的用例')
    failed = true
  } else {
    console.log(`✓ CSV 数字格式灵敏度自检：${csvSensitive} 条用例能区分固定一位小数 / String()`)
  }

  // ---- e4) 凭据不得进入导出文件 ----
  // 导出文件是用户会随手分享的东西，把 API Key 写进去等于泄露。
  // 这条断言同时守住两个方向：正规路径（buildExport）与导入回写路径（validateExport）。
  const withSecret = [
    { key: 'deepseek_api_key', value: 'sk-should-never-appear' },
    { key: 'voice_enabled', value: 'true' },
  ]
  const builtSecret = mod.buildExport({ settings: withSecret }, '', 0, '')
  const cleanedSecret = mod.validateExport({
    format: payload.constants.EXPORT_FORMAT,
    format_version: payload.constants.EXPORT_FORMAT_VERSION,
    tables: { ...emptyTables, settings: withSecret },
  })
  const secretLeak = (b) => JSON.stringify(b.tables.settings).includes('sk-should-never-appear')
  const secretOk =
    !secretLeak(builtSecret.bundle) &&
    !secretLeak(cleanedSecret.bundle) &&
    builtSecret.bundle.tables.settings.length === 1 &&
    // 被排除不等于"脏数据"：不能计入 skipped（否则界面会报"1 行被跳过"，误导用户）
    (builtSecret.skipped.settings ?? 0) === 0 &&
    (cleanedSecret.skipped.settings ?? 0) === 0
  if (!secretOk) {
    console.error('✗ 凭据排除策略被破坏：')
    console.error(`    build:    ${JSON.stringify(builtSecret)}`)
    console.error(`    validate: ${JSON.stringify(cleanedSecret.bundle?.tables?.settings)} skipped=${JSON.stringify(cleanedSecret.skipped)}`)
    failed = true
  } else {
    console.log('✓ 凭据排除：API Key 不进入导出文件，且不计入 skipped')
  }

  if (failed) process.exit(1)
  console.log('✓ 前端 TS 与 Python 后端的导出/导入格式完全一致')
}
main()
