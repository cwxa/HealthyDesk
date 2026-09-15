/**
 * 角度计算等价性验证：把前端 TS 的三个角度函数与 Python 后端逐条比对。
 *
 * 用法：
 *   python scripts/gen-angle-cases.py > scripts/angle-expected.json
 *   node scripts/verify-angles.mjs
 *
 * 覆盖 headTiltAngle / shoulderRatio / spineAngle 的正常值与边界保护
 * （dx 过小、肩宽过小、超过 30°、dy≈0 等）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---- 与 localPoseEngine.ts 逐行一致（含 pyRound 与全部边界保护） ----
function pyRound(x) {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

function headTiltAngle(leftEar, rightEar) {
  const dx = Math.abs(rightEar.x - leftEar.x)
  const dy = Math.abs(rightEar.y - leftEar.y)
  if (dx < 0.03) return 0
  const angle = (Math.atan2(dy, dx) * 180) / Math.PI
  if (angle > 30) return 0
  return angle
}

function shoulderRatio(leftShoulder, rightShoulder) {
  const width = Math.abs(leftShoulder.x - rightShoulder.x)
  if (width < 0.01) return 0
  const dy = Math.abs(leftShoulder.y - rightShoulder.y)
  return (dy / width) * 100
}

function spineAngle(leftShoulder, rightShoulder, leftHip, rightHip) {
  const sMidX = (leftShoulder.x + rightShoulder.x) / 2
  const sMidY = (leftShoulder.y + rightShoulder.y) / 2
  const hMidX = (leftHip.x + rightHip.x) / 2
  const hMidY = (leftHip.y + rightHip.y) / 2
  const dx = hMidX - sMidX
  const dy = hMidY - sMidY
  if (dy < 0.001) return 90
  return Math.abs((Math.atan2(dx, dy) * 180) / Math.PI)
}

const pt = (p) => ({ x: p[0], y: p[1] })

function main() {
  const expectedPath = join(__dirname, 'angle-expected.json')
  let cases
  try {
    cases = JSON.parse(readFileSync(expectedPath, 'utf8'))
  } catch {
    console.error(`✗ 找不到 ${expectedPath}，请先运行：python scripts/gen-angle-cases.py > scripts/angle-expected.json`)
    process.exit(2)
  }

  let pass = 0
  let fail = 0
  for (const c of cases) {
    const lm = c.landmarks
    const head = pyRound(headTiltAngle(pt(lm.left_ear), pt(lm.right_ear)) * 100) / 100
    const shoulder = pyRound(shoulderRatio(pt(lm.left_shoulder), pt(lm.right_shoulder)) * 100) / 100
    const spine =
      pyRound(
        spineAngle(
          pt(lm.left_shoulder),
          pt(lm.right_shoulder),
          pt(lm.left_hip),
          pt(lm.right_hip),
        ) * 100,
      ) / 100

    const ok =
      Math.abs(head - c.head_angle) < 1e-9 &&
      Math.abs(shoulder - c.shoulder_diff) < 1e-9 &&
      Math.abs(spine - c.spine_angle) < 1e-9

    if (ok) {
      pass++
    } else {
      fail++
      console.error(`✗ 不一致 case=${c.name}`)
      console.error(`    Python: head=${c.head_angle} shoulder=${c.shoulder_diff} spine=${c.spine_angle}`)
      console.error(`    TS:     head=${head} shoulder=${shoulder} spine=${spine}`)
    }
  }

  console.log(`\n角度等价性：${pass} 通过 / ${fail} 失败（共 ${cases.length} 条）`)
  if (fail > 0) process.exit(1)
  console.log('✓ 前端 TS 与 Python 后端的角度计算完全一致')
}

main()
