/**
 * 姿态评分等价性验证：把前端 **真实源码** src/platform/localPoseEngine.ts 与
 * Python 后端做数值比对。
 *
 * 用法：
 *   1. 先由 Python 生成期望值：python scripts/gen-scoring-cases.py > scripts/scoring-expected.json
 *   2. node scripts/verify-scoring.mjs
 *
 * 前端不是用内联副本，而是用 esbuild 把源码 bundle 出来直接执行 ——
 * 内联副本一旦和源码漂移，「两端一致」就成了自我安慰：
 * 副本与源码可以各错各的，测试却全绿。
 *
 * 校验四层：
 *   a) 常量：Python 导出的评分常量 vs **从真实源码 bundle 读出的**常量，逐项相等
 *   b) 用例：每个用例的 score 与 issues 必须与 Python 完全一致（80 条，含全部档位边界）
 *   c) 平滑器：逐帧 EMA 序列的两端结果必须逐位相等（含 40 个取整平局点回归用例）
 *   d) 不变量硬断言：**出现任何提醒（issues 非空） ⟺ 分数 < 80**
 *
 * 核心不变量 d) 是评分模型的约束，也是「提醒了却还显示 95 分」这类问题的根源，
 * 所以它不是"顺便看看"，而是必须拦住发布的一条断言。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const require = createRequire(join(ROOT, 'package.json'))

/** 该分数以下的姿势被视为「有问题」——与 UI 的 80 分档、以及「有提醒」必须三者一致。 */
const GOOD_SCORE = 80

/**
 * 把前端源码 bundle 出来，并额外导出内部未 export 的符号供测试使用。
 * 源码本身不需要为测试而改动。
 */
async function loadFrontendSource() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    console.error('✗ 找不到 esbuild（vite 的依赖）。请先 npm install。')
    process.exit(2)
  }

  // 模块顶层会读 document.baseURI，并 new 一个引擎实例，补最小全局即可
  if (typeof globalThis.document === 'undefined') {
    globalThis.document = { baseURI: 'https://localhost/' }
  }

  const EXPOSE = `
export { computeScore as __computeScore, PoseSmoother as __PoseSmoother };
export const __constants = {
  HEAD_TILT_THRESHOLD, SHOULDER_DIFF_THRESHOLD, SPINE_ANGLE_THRESHOLD,
  WARN_ZONE_RATIO, WARN_ZONE_MAX, SECONDARY_WEIGHT,
  MILD_BASE, MILD_MAX, MODERATE_BASE, MODERATE_MAX, SEVERE_BASE, SEVERE_MAX,
  SCORE_MIN, SCORE_MAX,
  HEAD_MILD_HI, HEAD_MODERATE_HI, SHOULDER_MILD_HI, SHOULDER_MODERATE_HI,
  SPINE_MILD_HI, SPINE_MODERATE_HI,
  EMA_ALPHA,
};
`

  const built = await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'platform', 'localPoseEngine.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
    plugins: [
      {
        name: 'expose-internals',
        setup(b) {
          b.onLoad({ filter: /localPoseEngine\.ts$/ }, (args) => ({
            contents: readFileSync(args.path, 'utf8') + EXPOSE,
            loader: 'ts',
          }))
          // mediapipe 只影响推理，评分逻辑用不到，stub 掉避免把 wasm 相关代码一起打进来
          b.onResolve({ filter: /^@mediapipe\/tasks-vision$/ }, () => ({
            path: 'mediapipe-stub',
            namespace: 'stub',
          }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: 'export const FilesetResolver = {}; export const PoseLandmarker = {};',
            loader: 'js',
          }))
        },
      },
    ],
  })

  const out = join(tmpdir(), `neckguardian-frontend-${process.pid}.mjs`)
  writeFileSync(out, built.outputFiles[0].text)
  const mod = await import(pathToFileURL(out).href)
  return { computeScore: mod.__computeScore, PoseSmoother: mod.__PoseSmoother, constants: mod.__constants }
}

/** 浮点逐位相等（平滑值必须完全一致，允许 nan 语义） */
const sameNum = (a, b) => a === b || (Number.isNaN(a) && Number.isNaN(b))

async function main() {
  const expectedPath = join(__dirname, 'scoring-expected.json')
  let payload
  try {
    payload = JSON.parse(readFileSync(expectedPath, 'utf8'))
  } catch {
    console.error(`✗ 找不到 ${expectedPath}，请先运行：python scripts/gen-scoring-cases.py > scripts/scoring-expected.json`)
    process.exit(2)
  }

  const { computeScore, PoseSmoother, constants: tsConstants } = await loadFrontendSource()

  const cases = payload.cases
  const pyConstants = payload.constants
  const pySmootherConstants = payload.smootherConstants ?? {}
  const sequences = payload.smootherSequences ?? []
  let failed = false

  // ---- a) 常量比对（Python ↔ 真实前端源码）----
  let constFail = 0
  let constChecked = 0
  for (const [name, value] of Object.entries(pyConstants)) {
    constChecked++
    if (tsConstants[name] !== value) {
      console.error(`✗ 常量不一致 ${name}: python=${value} ts=${tsConstants[name]}`)
      constFail++
    }
  }
  for (const [name, value] of Object.entries(pySmootherConstants)) {
    constChecked++
    if (tsConstants[name] !== value) {
      console.error(`✗ 常量不一致 ${name}: python=${value} ts=${tsConstants[name]}`)
      constFail++
    }
  }
  if (constFail > 0) failed = true
  console.log(`常量比对（Python ↔ 前端真实源码）：${constChecked} 项${constFail ? ` 有 ${constFail} 项差异` : '全部一致'}`)

  // ---- b) 用例逐条比对 ----
  let pass = 0
  let mismatch = 0
  const invariantSamples = []
  let invariantFail = 0

  for (const c of cases) {
    const { head, shoulder, spine } = c.input
    const got = computeScore(head, shoulder, spine)

    if (got.score === c.score && JSON.stringify(got.issues) === JSON.stringify(c.issues)) {
      pass++
    } else {
      mismatch++
      if (mismatch <= 8) {
        console.error(`✗ 不一致 input=(head=${head}, shoulder=${shoulder}, spine=${spine})`)
        console.error(`    Python: score=${c.score} issues=${JSON.stringify(c.issues)}`)
        console.error(`    TS:     score=${got.score} issues=${JSON.stringify(got.issues)}`)
      }
    }

    // 核心不变量：有提醒 ⟺ 分数 < 80。
    // 只对 Python 期望值断言即可 —— TS 结果已逐条与之比对，因此两端同时被验证。
    if ((c.issues.length > 0) !== (c.score < GOOD_SCORE)) {
      invariantFail++
      if (invariantSamples.length < 8) {
        invariantSamples.push(
          `head=${head} shoulder=${shoulder} spine=${spine} → score=${c.score} issues=${JSON.stringify(c.issues)}`,
        )
      }
    }
  }

  console.log(`\n评分等价性：${pass} 通过 / ${mismatch} 失败（共 ${cases.length} 条）`)
  if (mismatch > 0) failed = true

  // ---- c) 平滑器逐帧比对 ----
  let frameTotal = 0
  let frameMismatch = 0
  let seqMismatch = 0
  for (const seq of sequences) {
    const smoother = new PoseSmoother()
    let bad = false
    for (let i = 0; i < seq.frames.length; i++) {
      const f = seq.frames[i]
      if (f === null || f === undefined) {
        smoother.reset()
        continue
      }
      const r = smoother.update({ head_angle: f[0], shoulder_diff: f[1], spine_angle: f[2] })
      const want = seq.smoothed[i]
      frameTotal++
      const ok = want && sameNum(r.head_angle, want[0]) && sameNum(r.shoulder_diff, want[1]) && sameNum(r.spine_angle, want[2])
      if (!ok) {
        frameMismatch++
        bad = true
        if (frameMismatch <= 8) {
          console.error(`✗ 平滑值不一致 第${i}帧 输入=${JSON.stringify(f)}`)
          console.error(`    Python: ${JSON.stringify(want)}`)
          console.error(`    TS:     ${JSON.stringify([r.head_angle, r.shoulder_diff, r.spine_angle])}`)
        }
      }
      // 平滑后的值也要满足不变量（用户看到的是平滑后的分数）
      const scored = computeScore(r.head_angle, r.shoulder_diff, r.spine_angle)
      if ((scored.issues.length > 0) !== (scored.score < GOOD_SCORE)) {
        invariantFail++
        if (invariantSamples.length < 8) {
          invariantSamples.push(`平滑后 head=${r.head_angle} shoulder=${r.shoulder_diff} spine=${r.spine_angle} → score=${scored.score}`)
        }
      }
    }
    if (bad) seqMismatch++
  }

  console.log(`平滑器等价性：${frameTotal} 帧中 ${frameMismatch} 帧不一致（${sequences.length} 条序列）`)
  if (frameMismatch > 0) failed = true

  // ---- d) 不变量 ----
  if (invariantFail > 0) {
    console.error(`\n✗ 不变量被破坏：${invariantFail} 条不满足「有提醒 ⟺ 分数 < ${GOOD_SCORE}」`)
    for (const s of invariantSamples) console.error(`    ${s}`)
    failed = true
  } else {
    console.log(`✓ 不变量成立：${cases.length} 条用例 + ${frameTotal} 帧平滑序列均满足「有提醒 ⟺ 分数 < ${GOOD_SCORE}」`)
  }

  if (failed) process.exit(1)
  console.log('✓ 前端 TS 与 Python 后端的评分/平滑逻辑完全一致')
}

main()
