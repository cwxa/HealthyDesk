import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import PostureCalibration from '../src/components/PostureCalibration'
import { BASELINE_KEY, parseBaseline, type CameraProfile } from '../src/platform/postureCalibration'
import type { PoseResult } from '../src/types'

/** 真实 React/DOM/localStorage；只控制帧与单调时钟，不替换校准实现。 */
export async function runCalibrationUiTests() {
  let checks = 0, time = 0, active = false
  const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); checks++ }
  const wait = () => new Promise(r => setTimeout(r, 0))
  const oldNow = Object.getOwnPropertyDescriptor(performance, 'now')
  Object.defineProperty(performance, 'now', { configurable: true, value: () => time })
  const container = document.createElement('div'); document.body.append(container)
  let root = createRoot(container)
  const camera = { key: 'browser-camera:640x480', aspect: 4 / 3 }
  let profile: CameraProfile = camera, enabled = true, result: PoseResult | null = null
  const onChange = (value: boolean) => { active = value }
  const render = async () => {
    flushSync(() => root.render(<StrictMode><PostureCalibration result={result} camera={profile} enabled={enabled} onCollectingChange={onChange} /></StrictMode>))
    await wait(); await wait()
  }
  const text = () => container.innerText
  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find(b => b.textContent?.includes(label))
    if (!button) throw new Error(`Missing button: ${label}; ${text()}`)
    button.click(); await wait(); await wait()
  }
  const frame = (t: number): PoseResult => ({ type: 'pose', mode: 'monitor', metric_version: 2,
    timestamp: new Date(Date.now() + t).toISOString(), frame_id: t, session_id: 'ui-test', frame_width: 640, frame_height: 480,
    score: 100, head_angle: 1, shoulder_diff: 1, spine_angle: 2,
    signed_metrics: { head_angle: 1, shoulder_diff: -1, spine_angle: 2 },
    quality: Object.fromEntries(['head_angle', 'shoulder_diff', 'spine_angle'].map(n => [n, { valid: true, confidence: .99 }])) })
  const feed = async () => {
    const start = time
    for (let i = 0; i <= 100; i++) { time = start + i * 100; result = frame(time); await render() }
  }
  localStorage.removeItem(BASELINE_KEY)
  try {
    await render(); check(text().includes('未校准'), 'Initial state')
    await click('个人姿势基线'); await click('开始校准')
    check(active, 'Start must immediately isolate recording and voice')
    await feed()
    check(!active && text().includes('已校准'), 'Successful collection exits active state')
    const stored = parseBaseline(localStorage.getItem(BASELINE_KEY))
    check(stored?.samples === 101, 'Real localStorage must contain valid baseline')
    check(text().includes('相对基线：头 0.0°'), 'Signed deviation appears')
    const saved = localStorage.getItem(BASELINE_KEY)
    await click('重新校准'); await click('取消校准')
    check(localStorage.getItem(BASELINE_KEY) === saved && text().includes('已校准'), 'Cancelling recalibration preserves original baseline')
    result = { ...frame(time + 100), signed_metrics: { head_angle: -1, shoulder_diff: 1, spine_angle: -2 } }; await render()
    check(text().includes('头 -2.0°') && text().includes('肩 +2.0%'), 'Opposite direction must retain sign')
    result = { ...frame(time + 200), type: 'no_pose' }; await render()
    check(!text().includes('相对基线：'), 'Invalid frame must hide old deviation')
    flushSync(() => root.unmount()); root = createRoot(container); result = frame(time); await render()
    check(text().includes('已校准'), 'Baseline survives component restart')
    profile = { ...camera, key: 'different-device' }; await render()
    check(text().includes('未校准') && localStorage.getItem(BASELINE_KEY) === null, 'Device change permanently invalidates stored baseline')
    profile = camera; await render(); await click('个人姿势基线'); await click('开始校准')
    profile = { ...camera, key: 'third-device' }; await render()
    check(!active && text().includes('校准取消'), 'Camera change cancels active collection')
    profile = camera; await render(); await click('开始校准')
    enabled = false; await render(); check(!active && text().includes('校准取消'), 'Exercise/stop cancels active collection')
    enabled = true; await render(); await click('开始校准')
    const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden')
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange')); await wait(); await wait()
    check(!active && text().includes('页面已隐藏'), 'Hidden page cancels active collection')
    if (hiddenDescriptor) Object.defineProperty(document, 'hidden', hiddenDescriptor); else delete (document as unknown as Record<string, unknown>).hidden
    await click('开始校准'); await click('取消校准'); check(!active, 'Explicit cancel restores recording')
    const originalTimeout = window.setTimeout
    let deadline: (() => void) | undefined
    window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay === 20000 && typeof handler === 'function') deadline = () => handler(...args)
      return originalTimeout(handler, delay === 20000 ? 60000 : delay, ...args)
    }) as typeof window.setTimeout
    try {
      await click('开始校准'); check(!!deadline, 'Collection needs an independent timeout even without frames')
      deadline!(); await wait(); await wait()
      check(!active && text().includes('校准超时'), 'No-frame timeout restores recording and voice')
    } finally { window.setTimeout = originalTimeout }
    const originalSet = Storage.prototype.setItem
    Storage.prototype.setItem = function(key, value) { if (key === BASELINE_KEY) throw new Error('Mock storage quota exceeded'); return originalSet.call(this, key, value) }
    try {
      await click('开始校准'); await feed()
      check(text().includes('保存失败') && text().includes('未校准') && !active, 'Save failure must not claim saved calibration')
    } finally { Storage.prototype.setItem = originalSet }
    await click('开始校准'); await feed(); await click('重置基线')
    check(localStorage.getItem(BASELINE_KEY) === null && text().includes('未校准'), 'Reset clears persistent and rendered baseline')
    await click('开始校准'); flushSync(() => root.unmount())
    check(!active, 'Unmount restores recording and voice gate')
    root = createRoot(container); localStorage.setItem(BASELINE_KEY, '{broken'); await render()
    check(text().includes('未校准'), 'Corrupt baseline must not crash UI')
    return { passed: true, checks }
  } finally {
    flushSync(() => root.unmount()); container.remove(); localStorage.removeItem(BASELINE_KEY)
    if (oldNow) Object.defineProperty(performance, 'now', oldNow); else delete (performance as unknown as Record<string, unknown>).now
  }
}
