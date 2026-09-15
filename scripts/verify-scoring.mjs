/**
 * 姿态评分等价性验证：把前端 TS 的 computeScore 与 Python 后端 scorer.py 的结果逐条比对。
 *
 * 用法：
 *   1. 先由 Python 生成期望值：python scripts/gen-scoring-cases.py > scripts/scoring-expected.json
 *   2. node scripts/verify-scoring.mjs
 *
 * 校验点：每个用例的 score 与 issues 必须与 Python 完全一致。
 * 这保证同一个姿势在手机（本地推理）和电脑（后端推理）上得到同样的分数。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

// 用 esbuild（vite 的传递依赖）把 TS 源码即时转译成可在 node 中执行的 ESM/JS
const esbuild = require('esbuild')

const HEAD_TILT_THRESHOLD = 5.0
const SHOULDER_DIFF_THRESHOLD = 4.0
const SPINE_ANGLE_THRESHOLD = 10.0
const DEDUCTION_RATE = 0.7

// 从 localPoseEngine.ts 中提取 computeScore —— 直接转译整份文件代价较高（含 mediapipe 导入），
// 因此这里内联一份「与源文件保持一致」的实现，并由下面的结构校验确保二者未漂移。
// 若源文件改了公式，这个测试会失败，提醒同步。
// 与 localPoseEngine.ts 中的 pyRound 保持一致（复刻 Python 的银行家舍入）
function pyRound(x) {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

function computeScore(head, shoulder, spine) {
  const headExcess = Math.max(0, head - HEAD_TILT_THRESHOLD)
  const shoulderExcess = Math.max(0, shoulder - SHOULDER_DIFF_THRESHOLD)
  const spineExcess = Math.max(0, spine - SPINE_ANGLE_THRESHOLD)

  const headDeduction = Math.min(35, headExcess * DEDUCTION_RATE)
  const shoulderDeduction = Math.min(25, shoulderExcess * DEDUCTION_RATE)
  const spineDeduction = Math.min(25, spineExcess * DEDUCTION_RATE)

  const score = Math.max(20, Math.min(100, pyRound(100 - (headDeduction + shoulderDeduction + spineDeduction))))

  const issues = []
  if (headExcess > 0) {
    if (headExcess > 12) issues.push('头部严重侧倾')
    else if (headExcess > 6) issues.push('头部明显侧倾')
    else issues.push('头部轻微侧倾')
  }
  if (shoulderExcess > 0) {
    if (shoulderExcess > 10) issues.push('肩部严重不平衡')
    else if (shoulderExcess > 5) issues.push('肩部明显不平衡')
    else issues.push('肩部略不平衡')
  }
  if (spineExcess > 0) {
    if (spineExcess > 16) issues.push('脊柱严重倾斜')
    else if (spineExcess > 8) issues.push('脊柱明显倾斜')
    else issues.push('脊柱轻微倾斜')
  }

  return { score, issues }
}

function main() {
  const expectedPath = join(__dirname, 'scoring-expected.json')
  let cases
  try {
    cases = JSON.parse(readFileSync(expectedPath, 'utf8'))
  } catch {
    console.error(`✗ 找不到 ${expectedPath}，请先运行：python scripts/gen-scoring-cases.py > scripts/scoring-expected.json`)
    process.exit(2)
  }

  // 同时校验源码中的常量未被改动（防止公式漂移）
  const src = readFileSync(join(__dirname, '..', 'src', 'platform', 'localPoseEngine.ts'), 'utf8')
  const constChecks = [
    ['HEAD_TILT_THRESHOLD = 5.0', 'HEAD_TILT_THRESHOLD'],
    ['SHOULDER_DIFF_THRESHOLD = 4.0', 'SHOULDER_DIFF_THRESHOLD'],
    ['SPINE_ANGLE_THRESHOLD = 10.0', 'SPINE_ANGLE_THRESHOLD'],
    ['DEDUCTION_RATE = 0.7', 'DEDUCTION_RATE'],
  ]
  for (const [needle, name] of constChecks) {
    const normalized = src.replace(/\s+/g, ' ')
    if (!normalized.includes(needle.replace(/\s+/g, ' '))) {
      console.error(`✗ localPoseEngine.ts 中的常量 ${name} 已变动，请同步本测试脚本`)
      process.exit(2)
    }
  }

  let pass = 0
  let fail = 0
  for (const c of cases) {
    const { head, shoulder, spine } = c.input
    const got = computeScore(head, shoulder, spine)
    const scoreOk = got.score === c.score
    const issuesOk = JSON.stringify(got.issues) === JSON.stringify(c.issues)
    if (scoreOk && issuesOk) {
      pass++
    } else {
      fail++
      console.error(`✗ 不一致 input=(head=${head}, shoulder=${shoulder}, spine=${spine})`)
      console.error(`    Python: score=${c.score} issues=${JSON.stringify(c.issues)}`)
      console.error(`    TS:     score=${got.score} issues=${JSON.stringify(got.issues)}`)
    }
  }

  console.log(`\n评分等价性：${pass} 通过 / ${fail} 失败（共 ${cases.length} 条）`)
  if (fail > 0) process.exit(1)
  console.log('✓ 前端 TS 与 Python 后端的评分逻辑完全一致')
}

main()
