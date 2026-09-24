/**
 * 动作完成度判定等价性验证 + 离线样本回放。
 *
 * 用法：
 *   1. 先由 Python 生成期望值：
 *        python scripts/gen-exercise-quality-cases.py > scripts/exercise-quality-expected.json
 *   2. node scripts/verify-exercise-quality.mjs
 *      node scripts/verify-exercise-quality.mjs --replay   # 只回放样本，打印结论
 *
 * 为什么需要这条守卫：活动完成度判定同时存在于桌面端（`backend/services/exercise_quality.py`）
 * 与移动端（`src/platform/exerciseQuality.ts`）。**两端给出不同结论**是这一层最贵的 bug ——
 * 手机上说你完成了、电脑上说你没做，用户不知道该信谁；而 S10 还要拿这个结论当活动成绩。
 *
 * 校验五层：
 *   a) 常量：阈值 / 结论 / 引导文案两端逐项相等（改一端不改另一端会红）
 *   b) 样本文件一致性：载荷里的 frames/spec 必须与 scripts/samples/*.json 逐字段相同
 *      （防止"改了文件忘了重新生成"这种静默漂移）
 *   c) 用例：30 条（含边界、数据中断、滞回计数、取整平局点）六个字段逐条相等
 *   d) 语义硬断言：三段样本三种结论、负样本必须失败、中断不计入、滞回不重复计数、
 *      hint 与 grade 一一对应、onset 与 S1 同源
 *   e) 取整灵敏度自检（守卫的守卫）
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const require = createRequire(join(ROOT, 'package.json'))

const FIELDS = ['grade', 'hint', 'peak_activity', 'held_ms', 'hold_ratio', 'cycles']

/** 把前端真实源码 bundle 出来，同时拿到 exerciseQuality 与 scoringModel 的导出。 */
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
      contents: `
import * as eq from './exerciseQuality'
import * as sm from './scoringModel'
export const __eq = eq
export const __sm = sm
`,
      resolveDir: join(ROOT, 'src', 'platform'),
      loader: 'ts',
      sourcefile: 'parity-entry.ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
  })

  const out = join(tmpdir(), `neckguardian-exercise-quality-${process.pid}.mjs`)
  writeFileSync(out, built.outputFiles[0].text)
  const mod = await import(pathToFileURL(out).href)
  try {
    unlinkSync(out)
  } catch {
    /* 删除失败不影响校验结果 */
  }
  return { eq: mod.__eq, sm: mod.__sm }
}

/**
 * 与源码逐行相同、**只把两处取整换成 `Math.round`** 的变体，用于证明
 * 「取整实现被换掉」能被本测试发现（见 §e 灵敏度自检）。它不参与任何被测断言，只是一把尺子。
 */
function makeMathRoundVariant(sm, eq) {
  const r1 = (x) => Math.round(x * 10) / 10 // ← 唯一差异之一
  return (frames, spec) => {
    const kind = spec?.kind ?? 'hold'
    const durationMs = spec?.duration_ms != null ? Number(spec.duration_ms) : 0
    const minCycles = spec?.min_cycles != null ? spec.min_cycles : kind === 'cyclic' ? eq.DEFAULT_MIN_CYCLES : 0
    if (frames.length === 0) {
      return { grade: 'idle', hint: eq.HINT_IDLE, peak_activity: 0, held_ms: 0, hold_ratio: 0, cycles: 0 }
    }
    const acts = frames.map((f) => r1(sm.exerciseActivity(f.head_angle, f.shoulder_diff, f.spine_angle)))
    let peak = acts[0]
    for (let i = 1; i < acts.length; i++) if (acts[i] > peak) peak = acts[i]
    let heldMs = 0
    for (let i = 0; i < frames.length - 1; i++) {
      if (acts[i] < eq.ACTIVITY_ONSET) continue
      const gap = frames[i + 1].t - frames[i].t
      if (gap <= 0 || gap > eq.MAX_FRAME_GAP_MS) continue
      heldMs += gap
    }
    const holdRatio = durationMs > 0 ? Math.min(1, r1(heldMs / durationMs)) : 0 // ← 另一处差异
    let cycles = 0
    let hot = false
    const trough = eq.ACTIVITY_ONSET * eq.CYCLE_TROUGH_RATIO
    for (const a of acts) {
      if (!hot) {
        if (a >= eq.ACTIVITY_ONSET) hot = true
      } else if (a <= trough) {
        cycles += 1
        hot = false
      }
    }
    let grade
    let hint
    if (peak < eq.ACTIVITY_IDLE_MAX) {
      grade = 'idle'
      hint = eq.HINT_IDLE
    } else if (peak < eq.ACTIVITY_ONSET) {
      grade = 'insufficient'
      hint = eq.HINT_AMPLITUDE
    } else if (kind === 'cyclic' && cycles < minCycles) {
      grade = 'insufficient'
      hint = eq.HINT_CYCLES
    } else if (kind === 'hold' && holdRatio < eq.HOLD_TARGET_RATIO) {
      grade = 'insufficient'
      hint = eq.HINT_HOLD
    } else {
      grade = 'completed'
      hint = eq.HINT_COMPLETED
    }
    return { grade, hint, peak_activity: peak, held_ms: heldMs, hold_ratio: holdRatio, cycles }
  }
}

function sameVerdict(a, b) {
  return FIELDS.every((k) => a[k] === b[k])
}

async function main() {
  const expectedPath = join(__dirname, 'exercise-quality-expected.json')
  let payload
  try {
    payload = JSON.parse(readFileSync(expectedPath, 'utf8'))
  } catch {
    console.error(`✗ 找不到 ${expectedPath}，请先运行：python scripts/gen-exercise-quality-cases.py > scripts/exercise-quality-expected.json`)
    process.exit(2)
  }

  const { eq, sm } = await loadFrontendSource()
  const replayOnly = process.argv.includes('--replay')
  let failed = false

  // ---- 离线样本回放（直接读样本文件，不看生成的载荷）----
  console.log('=== 离线样本回放（scripts/samples/）===')
  const sampleVerdicts = []
  for (const filename of payload.sample_files) {
    const file = join(__dirname, 'samples', filename)
    let raw
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      console.error(`✗ 读不到样本 ${filename}: ${e.message}`)
      failed = true
      continue
    }
    const got = eq.judgeExercise(raw.frames, raw.spec)
    sampleVerdicts.push({ filename, raw, got })
    console.log(
      `  ${String(raw.name).padEnd(18)} ${got.grade.padEnd(13)}` +
        ` peak=${got.peak_activity} held=${got.held_ms}ms ratio=${got.hold_ratio} cycles=${got.cycles}`,
    )
  }
  if (replayOnly) {
    process.exit(failed ? 1 : 0)
  }

  // ---- a) 常量比对 ----
  let constFail = 0
  let constChecked = 0
  for (const [name, value] of Object.entries(payload.constants)) {
    constChecked++
    // EXERCISE_ACTIVITY_START 在 scoringModel 里，其余在 exerciseQuality 里
    const actual = name === 'EXERCISE_ACTIVITY_START' ? sm[name] : eq[name]
    if (actual !== value) {
      console.error(`✗ 常量不一致 ${name}: python=${value} ts=${actual}`)
      constFail++
    }
  }
  if (constFail > 0) failed = true
  console.log(`\n常量比对（Python ↔ 前端真实源码）：${constChecked} 项${constFail ? ` 有 ${constFail} 项差异` : '全部一致'}`)

  // ---- b) 样本文件一致性 ----
  // 载荷里的样本是从文件读出来生成的；这里再读一遍文件，确保两者没漂移
  // （典型翻车：改了 samples/*.json 但忘了重新跑生成器，于是守卫拿旧期望值比对。）
  let driftFail = 0
  for (const s of payload.samples) {
    const gone = sampleVerdicts.find((x) => x.filename === s.source_file.replace(/^samples\//, ''))
    if (!gone) {
      console.error(`✗ 载荷里的样本 ${s.source_file} 不在回放结果中`)
      driftFail++
      continue
    }
    if (JSON.stringify(gone.raw.frames) !== JSON.stringify(s.frames)) {
      console.error(`✗ 样本漂移 ${s.source_file}：载荷里的 frames 与文件不一致（重新跑生成器）`)
      driftFail++
    }
    if (JSON.stringify(gone.raw.spec) !== JSON.stringify(s.spec)) {
      console.error(`✗ 样本漂移 ${s.source_file}：载荷里的 spec 与文件不一致（重新跑生成器）`)
      driftFail++
    }
    if (gone.raw.expected_grade !== s.expected_grade) {
      console.error(`✗ 样本漂移 ${s.source_file}：expected_grade 与文件不一致`)
      driftFail++
    }
    if (!sameVerdict(gone.got, s.expected)) {
      console.error(`✗ 样本判定两端不一致 ${s.source_file}`)
      console.error(`    Python: ${JSON.stringify(s.expected)}`)
      console.error(`    TS:     ${JSON.stringify(gone.got)}`)
      driftFail++
    }
  }
  if (driftFail > 0) failed = true
  console.log(
    driftFail
      ? `✗ 样本一致性：${driftFail} 处问题`
      : `✓ 样本一致性：${payload.samples.length} 段样本与文件一致，且两端判定相同`,
  )

  // ---- c) 用例逐条比对 ----
  let pass = 0
  let mismatch = 0
  for (const c of payload.cases) {
    const got = eq.judgeExercise(c.frames, c.spec)
    if (sameVerdict(got, c.expected)) {
      pass++
    } else {
      mismatch++
      if (mismatch <= 8) {
        console.error(`✗ 不一致「${c.name}」n=${c.frames.length}`)
        console.error(`    Python: ${JSON.stringify(c.expected)}`)
        console.error(`    TS:     ${JSON.stringify(got)}`)
      }
    }
  }
  console.log(`\n完成度判定等价性：${pass} 通过 / ${mismatch} 失败（共 ${payload.cases.length} 条）`)
  if (mismatch > 0) failed = true

  const byName = (n) => payload.cases.find((x) => x.name === n)
  const gotOf = (n) => {
    const c = byName(n)
    return c ? eq.judgeExercise(c.frames, c.spec) : null
  }

  // ---- d) 语义硬断言 ----
  let hardFail = 0

  // d1) 三段固定样本必须给出三种**互不相同**的结论，且负样本不得被判为「完成」。
  //     这是 S2 验收标准里唯一一条真正能证伪"判定函数到底有没有在工作"的断言。
  const grades = sampleVerdicts.map((s) => s.got.grade)
  const unique = new Set(grades)
  if (sampleVerdicts.length !== 3 || unique.size !== 3) {
    console.error(`✗ 三段样本应给出三种不同结论，实际：${sampleVerdicts.map((s) => `${s.raw.name}=${s.got.grade}`).join(', ')}`)
    hardFail++
  } else {
    console.log(`✓ 三段样本给出三种不同结论：${sampleVerdicts.map((s) => `${s.raw.name}→${s.got.grade}`).join('、')}`)
  }
  for (const s of sampleVerdicts) {
    if (s.got.grade !== s.raw.expected_grade) {
      console.error(`✗ 样本 ${s.raw.name} 结论应为 ${s.raw.expected_grade}，实际 ${s.got.grade}`)
      hardFail++
    }
  }
  const negative = sampleVerdicts.find((s) => s.raw.expected_grade === 'idle')
  if (!negative) {
    console.error('✗ 样本集里缺少负样本（expected_grade=idle）—— 没有它就无法证明"不动会被判为没做"')
    hardFail++
  } else if (negative.got.grade === 'completed') {
    console.error(`✗ 负样本 ${negative.raw.name} 被判为「完成」—— 判定函数失效`)
    hardFail++
  } else {
    console.log(`✓ 负样本必须失败：${negative.raw.name} 没有被判为「完成」（grade=${negative.got.grade}）`)
  }

  // d2) 空序列不能假装完成
  const empty = gotOf('空序列·保持类')
  if (!empty || empty.grade !== 'idle' || empty.peak_activity !== 0 || empty.held_ms !== 0 || empty.cycles !== 0) {
    console.error(`✗ 空序列应判 idle 且各量为 0，实际 ${JSON.stringify(empty)}`)
    hardFail++
  } else {
    console.log('✓ 空序列判「没动」（不假装完成）')
  }

  // d3) 数据中断不计入保持时长（同一组帧，只有间隔不同）
  const gapOk = gotOf('中断·间隔 1000ms（计入）')
  const gapBad = gotOf('中断·间隔 2000ms（不计入）')
  if (!gapOk || !gapBad || gapOk.held_ms !== 3000 || gapBad.held_ms !== 0) {
    console.error(`✗ 数据中断未被正确排除：1000ms 间隔 held=${gapOk?.held_ms}（应 3000），2000ms 间隔 held=${gapBad?.held_ms}（应 0）`)
    hardFail++
  } else {
    console.log('✓ 数据中断（间隔 > MAX_FRAME_GAP_MS）不计入保持时长：3000ms → 0ms')
  }

  // d4) 非正间隔被排除（重复时间戳）
  const dup = gotOf('异常·重复时间戳')
  if (!dup || dup.held_ms !== 1000) {
    console.error(`✗ 重复时间戳未被排除：held=${dup?.held_ms}，应 1000`)
    hardFail++
  } else {
    console.log('✓ 非正间隔被排除（重复时间戳的 held 只算真实经过的那 1000ms）')
  }

  // d5) 滞回计数：在起点附近抖动不得被计成多次循环
  const flap = gotOf('往复·在起点附近抖动（滞回防重复计数）')
  const threeCycles = gotOf('往复·恰好 3 次循环')
  if (!flap || flap.cycles !== 0) {
    console.error(`✗ 抖动序列的 cycles 应为 0（滞回失效），实际 ${flap?.cycles}`)
    hardFail++
  } else if (!threeCycles || threeCycles.cycles !== 3) {
    console.error(`✗ 三次循环序列的 cycles 应为 3，实际 ${threeCycles?.cycles}`)
    hardFail++
  } else {
    console.log('✓ 往复计数带滞回：抖动序列 cycles=0，真实三次循环 cycles=3')
  }

  // d6) 往复类不看保持比例（它为往复动作定义，本身没有"保持"的概念）
  if (!threeCycles || threeCycles.hold_ratio >= payload.constants.HOLD_TARGET_RATIO) {
    console.error(`✗ 往复用例的 hold_ratio 应低于保持线以证明「往复类不看它」，实际 ${threeCycles?.hold_ratio}`)
    hardFail++
  } else if (threeCycles.grade !== 'completed') {
    console.error(`✗ 往复类在循环数达标时应判完成（不受 hold_ratio 影响），实际 ${threeCycles.grade}`)
    hardFail++
  } else {
    console.log(`✓ 往复类不受保持比例影响：ratio=${threeCycles.hold_ratio} < ${payload.constants.HOLD_TARGET_RATIO} 仍判完成`)
  }

  // d7) hint 与 grade 必须一一对应（防止"结论说完成、文案说再大一点"）
  const hintByGrade = {
    idle: [payload.constants.HINT_IDLE],
    insufficient: [payload.constants.HINT_AMPLITUDE, payload.constants.HINT_HOLD, payload.constants.HINT_CYCLES],
    completed: [payload.constants.HINT_COMPLETED],
  }
  let hintBad = 0
  const all = [...payload.cases.map((c) => ({ name: c.name, v: eq.judgeExercise(c.frames, c.spec) })), ...sampleVerdicts.map((s) => ({ name: s.raw.name, v: s.got }))]
  for (const { name, v } of all) {
    if (!hintByGrade[v.grade] || !hintByGrade[v.grade].includes(v.hint)) {
      console.error(`✗ 文案与结论不匹配「${name}」grade=${v.grade} hint=${v.hint}`)
      hintBad++
    }
  }
  if (hintBad > 0) {
    hardFail++
  } else {
    console.log(`✓ 引导文案与结论一一对应（检查 ${all.length} 条）`)
  }

  // d8) onset 必须与 S1 运动态共用一个取值（"确实动起来了"的定义只有一处）
  if (eq.ACTIVITY_ONSET !== sm.EXERCISE_ACTIVITY_START) {
    console.error(
      `✗ ACTIVITY_ONSET (${eq.ACTIVITY_ONSET}) 与 EXERCISE_ACTIVITY_START (${sm.EXERCISE_ACTIVITY_START}) 脱钩 —— ` +
        '完成度判定与运动态评分会用两套"算不算动起来"的标准',
    )
    hardFail++
  } else {
    console.log(`✓ 有效活动起点与 S1 同源（ACTIVITY_ONSET = EXERCISE_ACTIVITY_START = ${eq.ACTIVITY_ONSET}）`)
  }

  if (hardFail > 0) failed = true

  // ---- e) 取整灵敏度自检（守卫的守卫）----
  // 如果没有一条用例能把 `pyRound1` 与 `Math.round` 区分开，
  // 那「取整实现被偷偷换掉」本测试就发现不了 —— 这条守卫就是摆设。
  const mathRound = makeMathRoundVariant(sm, eq)
  const sensitive = []
  for (const c of payload.cases) {
    const a = eq.judgeExercise(c.frames, c.spec)
    const b = mathRound(c.frames, c.spec)
    if (!sameVerdict(a, b)) sensitive.push(c.name)
  }
  for (const s of sampleVerdicts) {
    const a = eq.judgeExercise(s.raw.frames, s.raw.spec)
    const b = mathRound(s.raw.frames, s.raw.spec)
    if (!sameVerdict(a, b)) sensitive.push(s.raw.name)
  }
  if (sensitive.length === 0) {
    console.error('✗ 取整灵敏度为 0：没有任何用例能区分「平局取偶」与「Math.round」')
    console.error('  → 这条守卫对取整实现的漂移毫无灵敏度，请补充取整平局点用例')
    failed = true
  } else {
    console.log(`✓ 取整灵敏度自检：${sensitive.length} 条用例能区分平局取偶 / Math.round（例：${sensitive.slice(0, 3).join('、')}）`)
  }

  if (failed) process.exit(1)
  console.log('✓ 前端 TS 与 Python 后端的动作完成度判定完全一致')
}

main()
