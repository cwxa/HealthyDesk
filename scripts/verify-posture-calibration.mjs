/** 执行真实校准模块，覆盖时间、噪声、数据版本、机位及方向语义。 */
import assert from 'node:assert/strict'
import { loadSource } from './verify-pose.mjs'
const c = await loadSource('src/platform/postureCalibration.ts')
const camera = { key: 'test-camera:640x480', aspect: 4 / 3 }
const names = ['head_angle', 'shoulder_diff', 'spine_angle']
const wall = 1_000_000
let checks = 0
const check = (fn) => { fn(); checks++ }
const frame = (t, overrides = {}) => ({ type: 'pose', mode: 'monitor', metric_version: 2,
  timestamp: new Date(wall + t).toISOString(), frame_width: 640, frame_height: 480,
  signed_metrics: { head_angle: 1, shoulder_diff: -1, spine_angle: 2 },
  quality: Object.fromEntries(names.map(n => [n, { valid: true, confidence: .99 }])), ...overrides })
const collect = (fps, mutate = f => f) => {
  const collector = new c.PostureCalibrator(camera, 0)
  let state
  for (let i = 0; i <= fps * 12; i++) {
    const t = i * 1000 / fps
    state = collector.push(mutate(frame(t), t), t, wall)
    if (state.finished) break
  }
  return state
}
for (const fps of [3, 5, 10, 15, 30]) {
  const state = collect(fps)
  check(() => {
    assert.equal(state.finished, true); assert.equal(state.progress, 1)
    assert.deepEqual(state.baseline.center, frame(0).signed_metrics)
    assert.ok(state.baseline.duration_ms >= 10000 && state.baseline.duration_ms < 12000)
    assert.ok(state.baseline.samples >= 30 && state.baseline.samples <= 102)
    assert.deepEqual(c.parseBaseline(JSON.stringify(state.baseline), wall), state.baseline)
  })
}
const baseline = collect(10).baseline
check(() => {
  const state = collect(10, (f, t) => t === 4000 ? { ...f, signed_metrics: { head_angle: 4.9, shoulder_diff: -1, spine_angle: 2 } } : f)
  assert.equal(state.baseline.center.head_angle, 1)
  assert.equal(state.baseline.mad.head_angle, 0)
})
for (const override of [
  { type: 'partial_pose' }, { mode: 'exercise' }, { metric_version: 1 }, { frame_width: 1280, frame_height: 720 },
  { signed_metrics: { head_angle: NaN, shoulder_diff: -1, spine_angle: 2 } },
  { signed_metrics: { head_angle: 6, shoulder_diff: -1, spine_angle: 2 } },
  { signed_metrics: undefined },
  ...names.flatMap(name => [
    { quality: { ...frame(0).quality, [name]: { valid: false, confidence: .99 } } },
    { quality: { ...frame(0).quality, [name]: { valid: true, confidence: .79 } } },
    { quality: { ...frame(0).quality, [name]: { valid: true, confidence: NaN } } },
  ]),
]) {
  check(() => { const state = collect(10, f => ({ ...f, ...override })); assert.equal(state.baseline, undefined); assert.equal(state.progress, 0) })
}
check(() => {
  const state = collect(10, (f, t) => ({ ...f, signed_metrics: { ...f.signed_metrics, head_angle: t % 200 < 100 ? -3 : 3 } }))
  assert.equal(state.baseline, undefined)
})
check(() => {
  const collector = new c.PostureCalibrator(camera, 0)
  for (let t = 0; t <= 4800; t += 200) collector.push(frame(t), t, wall)
  assert.equal(collector.push(frame(5000, { type: 'no_pose' }), 5000, wall).progress, 0)
  for (let t = 5200; t < 15200; t += 200) assert.equal(collector.push(frame(t), t, wall).baseline, undefined)
  assert.equal(collector.push(frame(15200), 15200, wall).baseline.duration_ms, 10000)
})
check(() => {
  const collector = new c.PostureCalibrator(camera, 0)
  collector.push(frame(0), 0, wall); collector.push(frame(200), 200, wall)
  assert.equal(collector.push(frame(1000), 1000, wall).progress, 0)
  assert.equal(collector.push(frame(1000), 11000, wall).baseline, undefined)
  assert.equal(collector.push(frame(1000), 20000, wall).finished, true)
})
check(() => {
  const collector = new c.PostureCalibrator(camera, 0)
  collector.push(frame(200), 200, wall)
  assert.equal(collector.push(frame(100), 100, wall).finished, true)
})
for (const changes of [
  { baseline_version: 2 }, { metric_version: 1 }, { created_at: wall + 1 }, { created_at: wall - 31 * 86400000 },
  { samples: 0 }, { duration_ms: 9000 }, { camera: { key: '', aspect: 4 / 3 } },
  { center: { ...baseline.center, head_angle: 6 } }, { mad: { ...baseline.mad, spine_angle: -1 } },
  { mad: { ...baseline.mad, spine_angle: 1 } }, { center: {} },
]) check(() => assert.equal(c.parseBaseline(JSON.stringify({ ...baseline, ...changes }), wall), null))
check(() => { assert.equal(c.parseBaseline('{'), null); assert.equal(c.parseBaseline('null'), null); assert.equal(c.parseBaseline(' '.repeat(5000)), null) })
check(() => {
  const opposite = frame(0, { signed_metrics: { head_angle: -1, shoulder_diff: 1, spine_angle: -2 } })
  assert.deepEqual(c.baselineDeviation(baseline, opposite, camera), { head_angle: -2, shoulder_diff: 2, spine_angle: -4 })
  assert.equal(c.baselineDeviation(baseline, opposite, { ...camera, key: 'other-camera' }), null)
  assert.equal(c.baselineDeviation(baseline, frame(0, { type: 'partial_pose' }), camera), null)
  assert.equal(c.baselineDeviation(baseline, frame(0, { mode: 'exercise' }), camera), null)
  assert.equal(c.baselineDeviation(baseline, frame(0, { signed_metrics: {} }), camera), null)
  assert.equal(c.cameraMatches(baseline, { ...camera, aspect: 16 / 9 }), false)
})
console.log(`Posture calibration: ${checks} production checks passed; continuous timing, confidence, robust baseline, persistence validation and signed deviation`)
