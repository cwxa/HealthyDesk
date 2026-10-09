import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadSource } from '../verify-pose.mjs'

// 直接运行生产判定函数；登记序列来自真实模型各采样率的跟踪与时间平滑。
const { ui_smoke: ui } = JSON.parse(readFileSync(new URL('./ui-smoke-v2.json', import.meta.url), 'utf8'))
const { judgeExercise } = await loadSource('src/platform/exerciseQuality.ts')
const { METRIC_VERSION } = await loadSource('src/platform/poseGeometry.ts')
assert.equal(ui.metric_version, METRIC_VERSION)
assert.equal(ui.frames.length, ui.frame_count)
for (const [fps, frames] of Object.entries(ui.rate_readings)) {
  const actual = judgeExercise(frames, { kind: 'hold', metric: 'head', duration_ms: ui.action_duration_ms })
  assert.equal(actual.grade, 'completed', `${fps}fps must complete with unchanged production thresholds`)
  for (const [key, expected] of Object.entries(ui.rate_sweep[fps])) {
    if (typeof expected === 'number') assert.ok(Math.abs(actual[key] - expected) < 1e-8, `${fps}fps ${key}`)
    else assert.equal(actual[key], expected, `${fps}fps ${key}`)
  }
}
assert.equal(Object.keys(ui.rate_readings).length, 4)
console.log('Pose v2 model recordings: 1.5/2/3/5fps production exercise verdicts match Python registration')
