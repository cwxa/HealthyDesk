#!/usr/bin/env node
/**
 * 假摄像头案例 · **消费端**：把 `scenarios.json` 里的逐帧序列喂给**移动端**的实现
 * （`src/platform/exerciseQuality.ts`），与桌面端（Python）登记下来的结论**逐项对拍**。
 *
 * ## 这条路补的是什么
 *
 * `scripts/fake-camera/build-frames.py` 是用**真人照片**跑出结论的，但它的结论只由
 * **Python 一侧**产生 —— 也就是说它证明的是「桌面端的判定在真人素材上是什么样」，
 * **没有**证明手机端在同样素材上给一样的结论。这正是本项目最贵的那类 bug
 * （手机上说你完成了、电脑上说你没做）。本脚本用 esbuild 把**真实前端源码** bundle 出来，
 * 拿同一份已登记的序列跑一遍，六个字段逐项比。
 *
 * 与 `scripts/verify-exercise-quality.mjs` 的分工（**不重叠**）：
 *   - 那条守卫跑的是**合成数值用例**（`gen-exercise-quality-cases.py` 生成），
 *     盯的是算法等价性与边界，**不需要 mediapipe**，覆盖 39+ 条构造用例。
 *   - 本脚本跑的是**真人照片派生**的序列（由 mediapipe 实跑产生），
 *     盯的是「真实素材上的结论两端一致」，**结论在构建期落盘**，
 *     所以本脚本自己**也不需要 mediapipe** —— 只有重新生成案例时才需要。
 *     ⇒ 因此它可以进 CI（`verify:all` 的第 7 项）。
 *
 * ## 三条断言（每条都有它盯的坏法）
 *
 * 1. **六字段逐项相等**：`grade/hint/peak_activity/held_ms/hold_ratio/cycles`
 *    两端必须逐位相同。盯的是「一端改了另一端没改」。
 * 2. **与期望判定相等**：`expect_grade` / `expect_hint` 是**语义期望**，
 *    `verdict` 是**实测登记值**。两者由构建期断言必须相等（`build-frames.py` 的红线），
 *    这里再独立验一次 —— 因为**只有构建期跑过一次**的期望，会在"有人手改 JSON"后失效。
 * 3. **阈值同源**：fixture 里登记的阈值必须等于**当前** TS 常量。改了阈值而没重建案例
 *    ⇒ 案例的结论已经过期，必须重建（这条把「悄悄改阈值」变成必须显式重建的动作）。
 *
 * ## 已知语义偏差（登记，不是失败）
 *
 * `still-person-12s` 的期望与实测**不相等**是有意为之：真人一动不动时，
 * 跟踪器漂移把它推到 `insufficient`，而设计意图是 `idle`。
 * 详见 `scenarios.json` 的 `findings` 与 build-frames.py 的文件头。
 * 本脚本把它标成 ⚠️ 并**要求它保持在** `insufficient`（与登记值一致），
 * 哪天真被修好了（判成 `idle`）反而会红 —— 那时应当回来更新登记值。
 *
 * 用法：
 *   node scripts/fake-camera/replay.mjs            # 断言模式（CI 跑这个）
 *   node scripts/fake-camera/replay.mjs --dump     # 只打印结论表，不判红绿
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const require = createRequire(join(ROOT, 'package.json'))
const DUMP = process.argv.includes('--dump')

const FIELDS = ['grade', 'hint', 'peak_activity', 'held_ms', 'hold_ratio', 'cycles']

/**
 * 按**显示宽度**补齐（中文字符占 2 列）。
 * `String.padEnd` 数的是 UTF-16 码元，用它排中文表必然错位 —— 表格错位本身无害，
 * 但会让「哪一列是 TS、哪一列是 Python」看不出来，而那正是这张表唯一的作用。
 */
const width = (s) => [...String(s)].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e80 ? 2 : 1), 0)
const padR = (s, n) => String(s) + ' '.repeat(Math.max(0, n - width(s)))
const padL = (s, n) => ' '.repeat(Math.max(0, n - width(s))) + String(s)

/** 把前端真实源码 bundle 出来（与 verify-exercise-quality.mjs 同一套手法）。 */
async function loadFrontendSource() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    console.error('✗ 找不到 esbuild（vite 的依赖）。请先 npm install。')
    process.exit(2)
  }
  const built = await esbuild.build({
    stdin: {
      contents: `import * as eq from './exerciseQuality'\nexport const __eq = eq\n`,
      resolveDir: join(ROOT, 'src', 'platform'),
      loader: 'ts',
      sourcefile: 'fake-camera-entry.ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
  })
  const out = join(tmpdir(), `neckguardian-fake-camera-${process.pid}.mjs`)
  writeFileSync(out, built.outputFiles[0].text)
  const mod = await import(pathToFileURL(out).href)
  try {
    unlinkSync(out)
  } catch {
    /* 删除失败不影响校验结果 */
  }
  return mod.__eq
}

const eq = await loadFrontendSource()

const doc = JSON.parse(readFileSync(join(__dirname, 'scenarios.json'), 'utf8'))
const problems = []

// ── 断言 3：阈值同源 ────────────────────────────────────────────────────────
const t = doc.thresholds
const wantThresholds = {
  HEAD_TILT_THRESHOLD: eq.METRIC_THRESHOLD.head,
  ACTIVITY_ONSET: eq.ACTIVITY_ONSET,
  ACTIVITY_IDLE_MAX: eq.ACTIVITY_IDLE_MAX,
  HOLD_TARGET_RATIO: eq.HOLD_TARGET_RATIO,
  DEFAULT_MIN_CYCLES: eq.DEFAULT_MIN_CYCLES,
}
for (const [k, v] of Object.entries(wantThresholds)) {
  if (t[k] !== v) {
    problems.push(`阈值 ${k}：fixture 登记 ${t[k]} ≠ 当前 TS 常量 ${v} —— 改了阈值必须重建案例`)
  }
}

// ── 断言 1 / 2：逐案例六字段 + 期望判定 ─────────────────────────────────────
console.log(
  `\n假摄像头案例 · 双端对拍（${doc.cases.length} 个案例，序列来自真人照片 + mediapipe 实跑）`,
)
console.log(
  `${padR('案例', 24)}${padL('采用帧', 7)}${padL('峰值活动', 10)}${padL('保持(ms)', 10)}` +
    `${padL('占比', 8)}${padL('次数', 6)}${padL('TS 判定', 38)}${padL('Py 登记', 38)}  状态`,
)
console.log('-'.repeat(150))

let deviated = 0
for (const c of doc.cases) {
  const got = eq.judgeExercise(c.series ?? [], c.spec)
  const py = c.verdict
  const sixOk = FIELDS.every((f) => got[f] === py[f])
  const expectMatch = py.grade === c.expect_grade && py.hint === c.expect_hint

  if (!sixOk) {
    const diff = FIELDS.filter((f) => got[f] !== py[f])
      .map((f) => `${f}: TS ${got[f]} ≠ Py ${py[f]}`)
      .join('；')
    problems.push(`案例 ${c.id}：两端结论不一致 —— ${diff}`)
  }
  if (!expectMatch) {
    problems.push(
      `案例 ${c.id}：登记结论 ${py.grade}/${py.hint} 与期望 ${c.expect_grade}/${c.expect_hint} 不符`,
    )
  }

  let status = sixOk && expectMatch ? '✅ 两端一致' : '❌ 见问题清单'
  if (status.startsWith('✅') && c.semantics === 'known-deviation') {
    status = '⚠️ 一致（已登记的语义偏差）'
    deviated += 1
  }
  console.log(
    `${padR(c.id, 24)}${padL(c.accepted_frames, 7)}${padL(got.peak_activity, 10)}` +
      `${padL(got.held_ms, 10)}${padL(got.hold_ratio, 8)}${padL(got.cycles, 6)}` +
      `${padL(`${got.grade} / ${got.hint}`, 38)}${padL(`${py.grade} / ${py.hint}`, 38)}  ${status}`,
  )
}
console.log('-'.repeat(150))

const grades = [...new Set(doc.cases.map((c) => c.verdict.grade))].sort()
const hints = [...new Set(doc.cases.map((c) => c.verdict.hint))]
console.log(
  `覆盖：grade ${grades.join(' / ')}（${grades.length === 3 ? '三分类全中 ✅' : '❌ 缺'}）；` +
    `hint ${hints.length}/${5} 条${hints.length === 5 ? ' ✅' : ' ❌'}`,
)
console.log(`两端字段：${FIELDS.join(' / ')}`)

if (problems.length) {
  console.log('\n❌ 问题：')
  for (const p of problems) console.log(`   · ${p}`)
  process.exit(DUMP ? 0 : 1)
}
if (DUMP) {
  console.log('\n（--dump：只打印，不判红绿）')
  process.exit(0)
}
console.log(
  `\n✅ ${doc.cases.length} 个案例两端六字段逐项相同、与期望判定一致` +
    (deviated ? `（其中 ${deviated} 个为已登记的语义偏差）` : ''),
)
