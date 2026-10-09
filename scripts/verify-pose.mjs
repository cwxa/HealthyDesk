/** 直接验证生产模块，不复制角度或评分实现。 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

let moduleId = 0

export async function loadSource(entry, plugins = []) {
  const result = await build({ entryPoints: [resolve(entry)], bundle: true, write: false, format: 'esm', platform: 'node', plugins, logLevel: 'silent' })
  const path = resolve(tmpdir(), `ng-pose-${process.pid}-${moduleId++}.mjs`)
  writeFileSync(path, result.outputFiles[0].text)
  try { return await import(pathToFileURL(path).href) } finally { unlinkSync(path) }
}

async function pythonProbe(data) {
  const python = process.env.NG_PYTHON ?? (existsSync('.buildenv/Scripts/python.exe') ? resolve('.buildenv/Scripts/python.exe') : 'python')
  return new Promise((resolveProbe, reject) => {
    const child = spawn(python, ['scripts/pose-probe.py'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Pose probe timed out: ${stderr}`)) }, 20000)
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.on('error', error => { clearTimeout(timeout); reject(error) })
    child.on('close', code => {
      clearTimeout(timeout)
      if (code !== 0) reject(new Error(`Pose probe failed (${code}): ${stderr}`))
      else { try { resolveProbe(JSON.parse(stdout)) } catch (error) { reject(error) } }
    })
    child.stdin.end(JSON.stringify(data))
  })
}

export async function verifyGeometry() {
  const geo = await loadSource('src/platform/poseGeometry.ts')
  const smooth = await loadSource('src/platform/poseSmoother.ts')
  const policy = await loadSource('src/platform/poseResultPolicy.ts')
  const cases = []
  const fresh = (width, height, angle = 10) => {
    const points = Array.from({ length: 33 }, () => ({ x: .5, y: .2, visibility: .99 }))
    points[7] = { x: .4, y: .2, visibility: .99 }
    points[8] = { x: .6, y: .2 + Math.tan(angle * Math.PI / 180) * .2 * width / height, visibility: .99 }
    points[11] = { x: .3, y: .4, visibility: .99 }
    points[12] = { x: .7, y: .4 + .04 * .4 * width / height, visibility: .99 }
    points[23] = { x: .35, y: .8, visibility: .99 }
    points[24] = { x: .65, y: .8, visibility: .99 }
    return { points, width, height }
  }
  for (const [width, height] of [[640, 480], [1280, 720], [480, 640], [640, 640]]) {
    const c = fresh(width, height)
    const result = geo.measurePose(c.points, width, height)
    assert.equal(result.metrics.head_angle, 10)
    assert.equal(result.metrics.shoulder_diff, 4)
    assert.equal(result.complete, true)
    cases.push(c)
    const mirrored = structuredClone(c)
    mirrored.points.forEach(p => { p.x = 1 - p.x })
    assert.deepEqual(geo.measurePose(mirrored.points, width, height).metrics, result.metrics)
    cases.push(mirrored)
  }
  const tilt = fresh(640, 480, 40)
  assert.equal(geo.measurePose(tilt.points, 640, 480).metrics.head_angle, 40)
  cases.push(tilt)
  for (const [index, patch, reason] of [[23, { visibility: .1 }, 'low_visibility'], [24, { y: 1.1 }, 'out_of_frame'], [7, { presence: .1 }, 'low_visibility']]) {
    const c = fresh(640, 480)
    Object.assign(c.points[index], patch)
    const r = geo.measurePose(c.points, 640, 480)
    assert.equal(r.complete, false)
    assert.equal(r.quality[index > 20 ? 'spine_angle' : 'head_angle'].reason, reason)
    cases.push(c)
  }
  for (const [first, second, field] of [[7, 8, 'head_angle'], [11, 12, 'shoulder_diff']]) {
    const c = fresh(640, 480)
    c.points[second].x = c.points[first].x
    const r = geo.measurePose(c.points, 640, 480)
    assert.equal(r.metrics[field], undefined)
    assert.equal(r.quality[field].reason, 'degenerate_geometry')
    cases.push(c)
  }
  const invalid = fresh(640, 480)
  invalid.points[7].x = NaN
  assert.equal(geo.measurePose(invalid.points, 640, 480).quality.head_angle.reason, 'non_finite')
  assert.equal(geo.measurePose(fresh(640, 480).points, 0, 480).complete, false)

  const temporal = []
  const endings = []
  for (const fps of [5, 15, 30]) {
    const sequence = [{ t: 0, metrics: { head_angle: 0 } }]
    for (let i = 1; i <= fps; i++) sequence.push({ t: i * 1000 / fps, metrics: { head_angle: 20 } })
    const smoother = new smooth.PoseSmoother()
    let last
    for (const frame of sequence) last = smoother.update(frame.metrics, frame.t)
    endings.push(last.head_angle)
    temporal.push(sequence)
  }
  assert.ok(Math.max(...endings) - Math.min(...endings) <= .06, `Frame rate response differs: ${endings}`)
  temporal.push([{ t: 0, metrics: { head_angle: 25, spine_angle: 30 } }, { t: 200, metrics: { head_angle: 25 } }, { t: 400, metrics: { head_angle: 0, spine_angle: 0 } }, { t: 4000, metrics: { head_angle: 0 } }])
  const probe = await pythonProbe({ geometry: cases, temporal })
  const actual = cases.map(c => geo.measurePose(c.points, c.width, c.height))
  // Python protobuf 的 presence 语义与 JS 不同：无 protobuf 的 probe 同样模拟 HasField。
  assert.deepEqual(actual, probe.geometry)
  for (let i = 0; i < temporal.length; i++) {
    const smoother = new smooth.PoseSmoother()
    assert.deepEqual(temporal[i].map(f => smoother.update(f.metrics, f.t)), probe.temporal[i])
  }
  assert.equal(probe.session_tests, true)
  assert.equal(probe.version_tests, true)
  const partial = { type: 'partial_pose', mode: 'monitor', head_angle: 10, shoulder_diff: 4 }
  assert.equal(policy.canRecordPosture(partial), false)
  assert.equal(policy.canMeasureExercise(partial, 'head'), true)
  assert.equal(policy.canMeasureExercise(partial, 'spine'), false)
  assert.equal(policy.canMeasureExercise({ ...partial, head_angle: NaN }, 'head'), false)
  const full = { type: 'pose', head_angle: 0, shoulder_diff: 0, spine_angle: 0, score: 100 }
  assert.equal(policy.canRecordPosture(full), true)
  assert.equal(policy.canRecordPosture({ ...full, mode: 'exercise' }), false)
  console.log(`Pose geometry: ${cases.length} cross-language cases passed; analytical geometry, invalid-input policy, temporal smoothing, mode changes and versioned migration/rollup passed`)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/verify-pose.mjs')) await verifyGeometry()
