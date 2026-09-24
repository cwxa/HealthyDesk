/**
 * 部位健康度等价性验证：把前端 **真实源码** src/platform/partHealth.ts 与
 * Python 后端 services/part_health.py 做数值比对。
 *
 * 用法：
 *   1. 先由 Python 生成期望值：python scripts/gen-part-health-cases.py > scripts/part-health-expected.json
 *   2. node scripts/verify-part-health.mjs
 *
 * 为什么需要这条守卫：Dashboard 的「部位健康度」此前是编造的（头部写死 85、
 * 肩部 = 今日总分 + 5）。改为按分项真实聚合后，聚合逻辑同时存在于
 * Python（桌面端）与 TS（移动端两处），**两端给出不同数字**就是新的
 * 「手机和电脑看到的不一样」——和 scorer 当初踩过的坑一模一样。
 *
 * 校验四层：
 *   a) 常量：阈值与档位边界两端逐项相等（改一端不改另一端会红）
 *   b) 映射：head↔head_angle / shoulder↔shoulder_diff / spine↔spine_angle
 *   c) 用例：18 条（含方向性反例、时间混合、浮点长链、取整平局点）逐条相等
 *   d) 方向性硬断言 + 取整灵敏度自检
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const require = createRequire(join(ROOT, 'package.json'))

/** 把前端源码 bundle 出来，并额外导出内部符号（评分常量）供比对。 */
async function loadFrontendSource() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    console.error('✗ 找不到 esbuild（vite 的依赖）。请先 npm install。')
    process.exit(2)
  }

  const EXPOSE = `
import * as __scoringModel from './scoringModel';
export const __constants = { ...__scoringModel };
`

  const built = await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'platform', 'partHealth.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
    plugins: [
      {
        name: 'expose-internals',
        setup(b) {
          b.onLoad({ filter: /partHealth\.ts$/ }, (args) => ({
            contents: readFileSync(args.path, 'utf8') + EXPOSE,
            loader: 'ts',
          }))
        },
      },
    ],
  })

  const out = join(tmpdir(), `neckguardian-part-health-${process.pid}.mjs`)
  writeFileSync(out, built.outputFiles[0].text)
  const mod = await import(pathToFileURL(out).href)
  try {
    unlinkSync(out)
  } catch {
    /* 删除失败不影响校验结果 */
  }
  return { computePartHealth: mod.computePartHealth, constants: mod.__constants }
}

const KEYS = ['head', 'shoulder', 'spine']

/**
 * 与源码逐行相同、**只把取整换成 `Math.round`** 的变体，
 * 用于证明「取整实现被换掉」这件事能被本测试发现（见 §d 灵敏度自检）。
 * 它不参与任何被测断言，只是一把尺子。
 */
function makeMathRoundVariant(sm) {
  const parts = [
    ['head', 'head_angle', sm.HEAD_TILT_THRESHOLD, sm.HEAD_MILD_HI, sm.HEAD_MODERATE_HI],
    ['shoulder', 'shoulder_diff', sm.SHOULDER_DIFF_THRESHOLD, sm.SHOULDER_MILD_HI, sm.SHOULDER_MODERATE_HI],
    ['spine', 'spine_angle', sm.SPINE_ANGLE_THRESHOLD, sm.SPINE_MILD_HI, sm.SPINE_MODERATE_HI],
  ]
  return (rows) => {
    if (rows.length === 0) return { head: null, shoulder: null, spine: null }
    const out = { head: null, shoulder: null, spine: null }
    for (const [key, field, threshold, mildHi, moderateHi] of parts) {
      let total = 0
      for (let i = 0; i < rows.length; i++) {
        total += 100 - sm.metricDeduction(rows[i][field], threshold, mildHi, moderateHi)
      }
      out[key] = Math.round((total / rows.length) * 10) / 10 // ← 唯一的差异
    }
    return out
  }
}

async function main() {
  const expectedPath = join(__dirname, 'part-health-expected.json')
  let payload
  try {
    payload = JSON.parse(readFileSync(expectedPath, 'utf8'))
  } catch {
    console.error(`✗ 找不到 ${expectedPath}，请先运行：python scripts/gen-part-health-cases.py > scripts/part-health-expected.json`)
    process.exit(2)
  }

  const { computePartHealth, constants: tsConstants } = await loadFrontendSource()
  let failed = false

  // ---- a) 常量比对 ----
  let constFail = 0
  let constChecked = 0
  for (const [name, value] of Object.entries(payload.constants)) {
    constChecked++
    if (tsConstants[name] !== value) {
      console.error(`✗ 常量不一致 ${name}: python=${value} ts=${tsConstants[name]}`)
      constFail++
    }
  }
  if (constFail > 0) failed = true
  console.log(`常量比对（Python ↔ 前端真实源码）：${constChecked} 项${constFail ? ` 有 ${constFail} 项差异` : '全部一致'}`)

  // ---- b) 部位 ↔ 字段映射比对 ----
  // 数值可能撞巧相等（例如三个部位恰好同分），所以映射关系单独钉一遍。
  const TS_PART_FIELDS = {
    head: 'head_angle',
    shoulder: 'shoulder_diff',
    spine: 'spine_angle',
  }
  let mapFail = 0
  for (const [key, field] of payload.parts) {
    if (TS_PART_FIELDS[key] !== field) {
      console.error(`✗ 部位映射不一致 ${key}: python=${field} ts=${TS_PART_FIELDS[key]}`)
      mapFail++
    }
  }
  if (mapFail > 0) failed = true
  console.log(`部位→字段映射：${payload.parts.length} 项${mapFail ? ` 有 ${mapFail} 项差异` : '全部一致'}`)

  // ---- c) 用例逐条比对 ----
  let pass = 0
  let mismatch = 0
  const toRows = (samples) =>
    samples.map(([head_angle, shoulder_diff, spine_angle]) => ({ head_angle, shoulder_diff, spine_angle }))

  for (const c of payload.cases) {
    const got = computePartHealth(toRows(c.samples))
    const ok = KEYS.every((k) => {
      const a = got[k]
      const b = c.expected[k]
      if (a === null || b === null) return a === b
      return a === b
    })
    if (ok) {
      pass++
    } else {
      mismatch++
      if (mismatch <= 8) {
        console.error(`✗ 不一致「${c.name}」n=${c.samples.length}`)
        console.error(`    Python: ${JSON.stringify(c.expected)}`)
        console.error(`    TS:     ${JSON.stringify(got)}`)
      }
    }
  }
  console.log(`\n部位健康度等价性：${pass} 通过 / ${mismatch} 失败（共 ${payload.cases.length} 条）`)
  if (mismatch > 0) failed = true

  // ---- d) 方向性硬断言 ----
  // 「最差的部位必须显示最低的分」—— 旧实现恰好在这条上翻车
  // （头部严重侧倾真实 35 分，界面却给写死的 85 分，比端正的肩部 40 分还高）。
  const dirCases = [
    { name: '反例·头部极差肩部极好', better: 'shoulder', worse: 'head' },
    { name: '反例·肩部极差头部极好', better: 'head', worse: 'shoulder' },
    { name: '反例·脊柱极差其余端正', better: 'head', worse: 'spine' },
  ]
  let dirFail = 0
  for (const d of dirCases) {
    const c = payload.cases.find((x) => x.name === d.name)
    if (!c) {
      console.error(`✗ 方向性用例缺失：${d.name}（生成脚本被改过？）`)
      dirFail++
      continue
    }
    const got = computePartHealth(toRows(c.samples))
    if (!(got[d.worse] < got[d.better])) {
      console.error(`✗ 方向性错误「${d.name}」：${d.worse}=${got[d.worse]} 应低于 ${d.better}=${got[d.better]}`)
      dirFail++
    }
  }
  if (dirFail > 0) failed = true
  console.log(dirFail ? `✗ 方向性断言：${dirFail} 条失败` : `✓ 方向性断言成立：最差的部位显示最低的分（${dirCases.length} 条）`)

  // ---- d2) 空序列必须返回 null，不能是 0 ----
  const empty = computePartHealth([])
  if (!KEYS.every((k) => empty[k] === null)) {
    console.error(`✗ 空序列应返回全 null（UI 显示「暂无数据」），实际：${JSON.stringify(empty)}`)
    failed = true
  } else {
    console.log('✓ 空序列返回全 null（与「健康度 0」区分开）')
  }

  // ---- d3) 取整灵敏度自检（守卫的守卫）----
  // 如果用例里没有任何一条能把 `pyRound1` 与 `Math.round` 区分开，
  // 那「取整实现被换成 Math.round」这件事本测试是发现不了的 —— 那这条守卫就是摆设。
  const mathRound = makeMathRoundVariant(tsConstants)
  let sensitive = 0
  let sensitiveNames = []
  for (const c of payload.cases) {
    const rows = toRows(c.samples)
    const a = computePartHealth(rows)
    const b = mathRound(rows)
    if (KEYS.some((k) => a[k] !== b[k])) {
      sensitive++
      if (sensitiveNames.length < 4) sensitiveNames.push(c.name)
    }
  }
  if (sensitive === 0) {
    console.error('✗ 取整灵敏度为 0：没有任何用例能区分「银行家舍入」与「Math.round」')
    console.error('  → 这条守核对取整实现的漂移毫无灵敏度，请补充取整平局点用例')
    failed = true
  } else {
    console.log(`✓ 取整灵敏度自检：${sensitive} 条用例能区分银行家舍入 / Math.round（例：${sensitiveNames.join('、')}）`)
  }

  if (failed) process.exit(1)
  console.log('✓ 前端 TS 与 Python 后端的部位健康度聚合完全一致')
}

main()
