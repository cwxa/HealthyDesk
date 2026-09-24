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
 * 校验六层：
 *   a) 常量：Python 导出的评分常量 vs **从真实源码 bundle 读出的**常量，逐项相等
 *   b) 用例：每个用例的 score 与 issues 必须与 Python 完全一致（80 条，含全部档位边界）
 *   c) 平滑器：逐帧 EMA 序列的两端结果必须逐位相等（含 40 个取整平局点回归用例）
 *   d) 不变量硬断言（**仅静息态**）：出现任何提醒（issues 非空） ⟺ 分数 < 80
 *   e) 运动态通道：score / activity / completed / issues 两端一致，
 *      且**不得**出现静息类措辞（「侧倾」「不平衡」「倾斜」）；
 *      运动态自己的不变量是「issues 非空 ⟺ 分数 < EXERCISE_SCORE_BASE」
 *   f) 语音隔离：`speakPostureIssue` 的每一处调用都必须在 `mode === 'monitor'` 分支内
 *      （运动态不得语音批评用户 —— 它在做它被要求做的事）
 *
 * d) 是静息态模型的约束，也是「提醒了却还显示 95 分」这类问题的根源，
 * 所以它不是"顺便看看"，而是必须拦住发布的一条断言。
 * e)/f) 是 2026-09 分通道后新增的：在此之前，做对康复动作的用户会被判
 * 「头部严重侧倾」并收到语音批评 —— 产品在惩罚用户做它要求做的事。
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
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

  // 评分常量现在统一在 scoringModel.ts（localPoseEngine 只是使用方），
  // 所以常量从该模块整体取出；EMA_ALPHA 属于平滑器，仍在引擎模块内。
  const EXPOSE = `
export { computeScore as __computeScore, PoseSmoother as __PoseSmoother };
import * as __scoringModel from './scoringModel';
export const __constants = { ...__scoringModel, EMA_ALPHA };
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
  // 文件名带 pid 是必要的：避免 node 的 ESM 缓存导致第二次运行仍用旧 bundle。
  // 导入完成后即可删除（模块已在内存里），不往系统临时目录堆垃圾。
  try {
    unlinkSync(out)
  } catch {
    /* 删除失败不影响校验结果 */
  }
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

  // ---- d) 不变量（分域：只对静息态成立）----
  // 「issues 非空 ⟺ 分数 < 80」是**静息态模型**的约束（它保证提醒与分数严格同步）。
  // 运动态有自己的达标线（EXERCISE_SCORE_BASE），那条不变量不适用于它 —— 见 e)。
  if (invariantFail > 0) {
    console.error(`\n✗ 不变量被破坏：${invariantFail} 条不满足「有提醒 ⟺ 分数 < ${GOOD_SCORE}」`)
    for (const s of invariantSamples) console.error(`    ${s}`)
    failed = true
  } else {
    console.log(`✓ 静息态不变量成立：${cases.length} 条用例 + ${frameTotal} 帧平滑序列均满足「有提醒 ⟺ 分数 < ${GOOD_SCORE}」`)
  }

  // ---- e) 运动态通道 ----
  // 运动态问的是「这个动作做到位了吗」，判定方向与静息态相反 ——
  // 未分通道时，用户把「颈部左侧屈」做到 20° 会被判「头部严重侧倾」拿 45 分。
  const exerciseCases = payload.exerciseCases ?? []
  const BANNED_IN_EXERCISE = ['侧倾', '不平衡', '倾斜']
  const exerciseBase = payload.constants.EXERCISE_SCORE_BASE
  let exPass = 0
  let exMismatch = 0
  let exWordFail = 0
  let exInvariantFail = 0
  const exSamples = []

  for (const c of exerciseCases) {
    const { head, shoulder, spine } = c.input
    const got = computeScore(head, shoulder, spine, 'exercise')

    const ok =
      got.score === c.score &&
      JSON.stringify(got.issues) === JSON.stringify(c.issues) &&
      got.activity === c.activity &&
      got.completed === c.completed &&
      got.mode === 'exercise'
    if (ok) {
      exPass++
    } else {
      exMismatch++
      if (exMismatch <= 8) {
        console.error(`✗ 运动态不一致 input=(head=${head}, shoulder=${shoulder}, spine=${spine})`)
        console.error(`    Python: score=${c.score} activity=${c.activity} completed=${c.completed} issues=${JSON.stringify(c.issues)}`)
        console.error(`    TS:     score=${got.score} activity=${got.activity} completed=${got.completed} issues=${JSON.stringify(got.issues)}`)
      }
    }

    // 运动态**不得**出现静息类措辞：「头部严重侧倾」这类话在运动态是错的。
    for (const w of BANNED_IN_EXERCISE) {
      if (got.issues.some((i) => i.includes(w))) {
        exWordFail++
        if (exSamples.length < 8) {
          exSamples.push(`运动态含静息类措辞「${w}」：head=${head} → ${JSON.stringify(got.issues)}`)
        }
      }
    }

    // 运动态自己的不变量：issues 非空 ⟺ 分数低于达标线。
    if ((got.issues.length > 0) !== (got.score < exerciseBase)) {
      exInvariantFail++
      if (exSamples.length < 8) {
        exSamples.push(`运动态不变量被破坏：score=${got.score} issues=${JSON.stringify(got.issues)}（达标线 ${exerciseBase}）`)
      }
    }
  }

  console.log(`\n运动态等价性：${exPass} 通过 / ${exMismatch} 失败（共 ${exerciseCases.length} 条，达标线 ${exerciseBase}）`)
  if (exMismatch > 0) failed = true
  if (exWordFail > 0) {
    console.error(`✗ 运动态出现静息类措辞 ${exWordFail} 处`)
    for (const s of exSamples) console.error(`    ${s}`)
    failed = true
  } else if (exerciseCases.length > 0) {
    console.log(`✓ 运动态措辞干净：${exerciseCases.length} 条用例均不含「${BANNED_IN_EXERCISE.join('」「')}」`)
  }
  if (exInvariantFail > 0) {
    console.error(`✗ 运动态不变量被破坏 ${exInvariantFail} 处`)
    for (const s of exSamples) console.error(`    ${s}`)
    failed = true
  } else if (exerciseCases.length > 0) {
    console.log(`✓ 运动态不变量成立：issues 非空 ⟺ 分数 < ${exerciseBase}`)
  }

  // ---- f) 语音隔离（源码级守卫）----
  // 运动态**不得**调用 speakPostureIssue（会把「动作幅度不足」这种中性的
  // 运动提示，变成对用户姿态的批评）。这条是 React 里的行为，node 侧没有渲染
  // 环境，所以退一步做**源码断言**：每一处调用都必须落在 `mode === 'monitor'`
  // 的条件块内。它拦不住所有写法，但足以拦住「有人删掉 mode 判断」这个回归。
  const activitySrc = readFileSync(join(ROOT, 'src', 'pages', 'NeckActivity.tsx'), 'utf8')
  const voiceCalls = [...activitySrc.matchAll(/speakPostureIssue\s*\(/g)]
  let voiceFail = 0
  if (voiceCalls.length === 0) {
    console.error('✗ 语音隔离守卫失效：NeckActivity.tsx 里找不到 speakPostureIssue 调用，守卫已无法证明任何事情')
    voiceFail++
  }
  for (const m of voiceCalls) {
    const before = activitySrc.slice(Math.max(0, m.index - 400), m.index)
    if (!before.includes("mode === 'monitor'")) {
      voiceFail++
      console.error('✗ speakPostureIssue 未被 mode === \'monitor\' 保护（运动态会语音批评用户）')
    }
  }
  if (voiceFail > 0) failed = true
  else console.log(`✓ 语音隔离：${voiceCalls.length} 处 speakPostureIssue 调用均在静息态分支内`)

  if (failed) process.exit(1)
  console.log('✓ 前端 TS 与 Python 后端的评分/平滑/运动态逻辑完全一致')
}

main()
