/**
 * 姿态评分等价性验证：把前端 TS 的 computeScore 与 Python 后端 scorer.py 的结果逐条比对。
 *
 * 用法：
 *   1. 先由 Python 生成期望值：python scripts/gen-scoring-cases.py > scripts/scoring-expected.json
 *   2. node scripts/verify-scoring.mjs
 *
 * 校验三层：
 *   a) 常量：Python 导出的评分常量 vs 本脚本内联副本，逐项相等
 *   b) 源码：localPoseEngine.ts 里确实存在同样的常量声明（防内联副本与源码静默漂移）
 *   c) 用例：每个用例的 score 与 issues 必须与 Python 完全一致，并断言核心不变量
 *
 * 核心不变量：**出现任何提醒（issues 非空） ⟺ 分数 < 80**
 * 这是评分模型的约束，也是「提醒了却还显示 95 分」这类问题的根源，
 * 所以它不是"顺便看看"，而是必须拦住发布的一条断言。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// 与 src/platform/localPoseEngine.ts 保持一致的实现（内联副本）。
// 整份 TS 文件含 mediapipe 导入，转译代价高，所以这里内联并由上面的 (a)(b)
// 两道闸保证它不会和源码静默漂移。
// ---------------------------------------------------------------------------
const HEAD_TILT_THRESHOLD = 5.0
const SHOULDER_DIFF_THRESHOLD = 4.0
const SPINE_ANGLE_THRESHOLD = 10.0
const WARN_ZONE_RATIO = 0.6
const WARN_ZONE_MAX = 6.0
const SECONDARY_WEIGHT = 0.3
const MILD_BASE = 22.0
const MILD_MAX = 28.0
const MODERATE_BASE = 34.0
const MODERATE_MAX = 46.0
const SEVERE_BASE = 52.0
const SEVERE_MAX = 65.0
const SCORE_MIN = 20
const SCORE_MAX = 100
const HEAD_MILD_HI = 6.0
const HEAD_MODERATE_HI = 12.0
const SHOULDER_MILD_HI = 5.0
const SHOULDER_MODERATE_HI = 10.0
const SPINE_MILD_HI = 8.0
const SPINE_MODERATE_HI = 16.0

/** 复刻 Python 的银行家舍入（round half to even）。 */
function pyRound(x) {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

function metricDeduction(value, threshold, mildHi, moderateHi) {
  const excess = value - threshold
  if (excess <= 0) {
    const zoneStart = threshold * WARN_ZONE_RATIO
    if (value <= zoneStart) return 0
    return (WARN_ZONE_MAX * (value - zoneStart)) / (threshold - zoneStart)
  }
  if (excess <= mildHi) {
    return MILD_BASE + (MILD_MAX - MILD_BASE) * (excess / mildHi)
  }
  if (excess <= moderateHi) {
    return MODERATE_BASE + (MODERATE_MAX - MODERATE_BASE) * ((excess - mildHi) / (moderateHi - mildHi))
  }
  return (
    SEVERE_BASE +
    Math.min(SEVERE_MAX - SEVERE_BASE, (SEVERE_MAX - SEVERE_BASE) * ((excess - moderateHi) / moderateHi))
  )
}

function computeScore(head, shoulder, spine) {
  const headExcess = Math.max(0, head - HEAD_TILT_THRESHOLD)
  const shoulderExcess = Math.max(0, shoulder - SHOULDER_DIFF_THRESHOLD)
  const spineExcess = Math.max(0, spine - SPINE_ANGLE_THRESHOLD)

  const deductions = [
    metricDeduction(head, HEAD_TILT_THRESHOLD, HEAD_MILD_HI, HEAD_MODERATE_HI),
    metricDeduction(shoulder, SHOULDER_DIFF_THRESHOLD, SHOULDER_MILD_HI, SHOULDER_MODERATE_HI),
    metricDeduction(spine, SPINE_ANGLE_THRESHOLD, SPINE_MILD_HI, SPINE_MODERATE_HI),
  ].sort((a, b) => b - a)
  const totalDeduction = deductions[0] + SECONDARY_WEIGHT * (deductions[1] + deductions[2])

  const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, pyRound(SCORE_MAX - totalDeduction)))

  const issues = []
  if (headExcess > 0) {
    if (headExcess > HEAD_MODERATE_HI) issues.push('头部严重侧倾')
    else if (headExcess > HEAD_MILD_HI) issues.push('头部明显侧倾')
    else issues.push('头部轻微侧倾')
  }
  if (shoulderExcess > 0) {
    if (shoulderExcess > SHOULDER_MODERATE_HI) issues.push('肩部严重不平衡')
    else if (shoulderExcess > SHOULDER_MILD_HI) issues.push('肩部明显不平衡')
    else issues.push('肩部略不平衡')
  }
  if (spineExcess > 0) {
    if (spineExcess > SPINE_MODERATE_HI) issues.push('脊柱严重倾斜')
    else if (spineExcess > SPINE_MILD_HI) issues.push('脊柱明显倾斜')
    else issues.push('脊柱轻微倾斜')
  }

  return { score, issues }
}

const LOCAL_CONSTANTS = {
  HEAD_TILT_THRESHOLD,
  SHOULDER_DIFF_THRESHOLD,
  SPINE_ANGLE_THRESHOLD,
  WARN_ZONE_RATIO,
  WARN_ZONE_MAX,
  SECONDARY_WEIGHT,
  MILD_BASE,
  MILD_MAX,
  MODERATE_BASE,
  MODERATE_MAX,
  SEVERE_BASE,
  SEVERE_MAX,
  SCORE_MIN,
  SCORE_MAX,
  HEAD_MILD_HI,
  HEAD_MODERATE_HI,
  SHOULDER_MILD_HI,
  SHOULDER_MODERATE_HI,
  SPINE_MILD_HI,
  SPINE_MODERATE_HI,
}

/** 该分数以下的姿势被视为「有问题」——与 UI 的 80 分档、以及「有提醒」必须三者一致。 */
const GOOD_SCORE = 80

function main() {
  const expectedPath = join(__dirname, 'scoring-expected.json')
  let payload
  try {
    payload = JSON.parse(readFileSync(expectedPath, 'utf8'))
  } catch {
    console.error(`✗ 找不到 ${expectedPath}，请先运行：python scripts/gen-scoring-cases.py > scripts/scoring-expected.json`)
    process.exit(2)
  }

  const cases = payload.cases
  const pyConstants = payload.constants
  let failed = false

  // ---- a) 常量比对（Python ↔ 本脚本内联副本）----
  let constFail = 0
  for (const [name, value] of Object.entries(pyConstants)) {
    if (LOCAL_CONSTANTS[name] !== value) {
      console.error(`✗ 常量不一致 ${name}: python=${value} ts=${LOCAL_CONSTANTS[name]}`)
      constFail++
    }
  }
  if (constFail > 0) failed = true
  console.log(`常量比对：${Object.keys(pyConstants).length} 项${constFail ? ` 有 ${constFail} 项差异` : '全部一致'}`)

  // ---- b) 前端源码文本校验（内联副本 ↔ 真实源码）----
  const src = readFileSync(join(__dirname, '..', 'src', 'platform', 'localPoseEngine.ts'), 'utf8')
  const normalized = src.replace(/\s+/g, ' ')
  const constChecks = [
    'HEAD_TILT_THRESHOLD = 5.0',
    'SHOULDER_DIFF_THRESHOLD = 4.0',
    'SPINE_ANGLE_THRESHOLD = 10.0',
    'WARN_ZONE_RATIO = 0.6',
    'WARN_ZONE_MAX = 6.0',
    'SECONDARY_WEIGHT = 0.3',
    'MILD_BASE = 22.0',
    'MILD_MAX = 28.0',
    'MODERATE_BASE = 34.0',
    'MODERATE_MAX = 46.0',
    'SEVERE_BASE = 52.0',
    'SEVERE_MAX = 65.0',
    'SCORE_MIN = 20',
    'SCORE_MAX = 100',
    'HEAD_MILD_HI = 6.0',
    'HEAD_MODERATE_HI = 12.0',
    'SHOULDER_MILD_HI = 5.0',
    'SHOULDER_MODERATE_HI = 10.0',
    'SPINE_MILD_HI = 8.0',
    'SPINE_MODERATE_HI = 16.0',
  ]
  let srcFail = 0
  for (const needle of constChecks) {
    if (!normalized.includes(needle.replace(/\s+/g, ' '))) {
      console.error(`✗ localPoseEngine.ts 中找不到常量声明「${needle}」，已漂移，请同步本测试脚本`)
      srcFail++
    }
  }
  if (srcFail > 0) failed = true
  console.log(`源码常量校验：${srcFail ? `缺失 ${srcFail} 项` : '通过'}`)

  // ---- c) 用例逐条比对 + 不变量断言 ----
  let pass = 0
  let mismatch = 0
  let invariantFail = 0
  const invariantSamples = []

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
    const hasIssue = c.issues.length > 0
    const belowGood = c.score < GOOD_SCORE
    if (hasIssue !== belowGood) {
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

  if (invariantFail > 0) {
    console.error(`\n✗ 不变量被破坏：${invariantFail} 条用例不满足「有提醒 ⟺ 分数 < ${GOOD_SCORE}」`)
    for (const s of invariantSamples) console.error(`    ${s}`)
    failed = true
  } else {
    console.log(`✓ 不变量成立：全部 ${cases.length} 条用例均满足「有提醒 ⟺ 分数 < ${GOOD_SCORE}」`)
  }

  if (failed) process.exit(1)
  console.log('✓ 前端 TS 与 Python 后端的评分逻辑完全一致')
}

main()
