/** 用可控模型、视频与时钟执行真实引擎/hook/传输代码，覆盖异步竞争。 */
import assert from 'node:assert/strict'
import { loadSource } from './verify-pose.mjs'

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
globalThis.document = { baseURI: 'https://localhost/', hidden: false }
globalThis.window = globalThis
let closed = 0, delegate = []
let creation
let points = Array.from({ length: 33 }, () => ({ x: .5, y: .2, visibility: .99 }))
const upright = () => {
  points = Array.from({ length: 33 }, () => ({ x: .5, y: .2, visibility: .99 }))
  for (const [i, x, y] of [[7, .4, .2], [8, .6, .2], [11, .3, .4], [12, .7, .4], [23, .35, .8], [24, .65, .8]]) points[i] = { x, y, visibility: .99 }
}
let throwInference = false, failGpu = false
globalThis.__poseModel = {
  async create(options) {
    delegate.push(options.baseOptions.delegate)
    if (failGpu && options.baseOptions.delegate === 'GPU') throw new Error('Mock GPU failure')
    if (creation) await creation.promise
    return { detectForVideo() { if (throwInference) throw new Error('Mock inference failure'); return { landmarks: [points] } }, close() { closed++ } }
  },
}
const mediapipe = {
  name: 'controlled-pose-model', setup(b) {
    b.onResolve({ filter: /^@mediapipe\/tasks-vision$/ }, () => ({ path: 'model', namespace: 'mock' }))
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const FilesetResolver = { forVisionTasks: async () => ({}) }; export const PoseLandmarker = { createFromOptions: (vision, options) => globalThis.__poseModel.create(options) };', loader: 'js' }))
  },
}
const { LocalPoseEngine } = await loadSource('src/platform/localPoseEngine.ts', [mediapipe])
upright()
const engine = new LocalPoseEngine()
await Promise.all([engine.init(), engine.init()])
assert.deepEqual(delegate, ['GPU'])
const video = { currentTime: 0, videoWidth: 1280, videoHeight: 720 }
const neutralResult = engine.detect(video, 0)
assert.equal(neutralResult.score, 100)
assert.deepEqual(neutralResult.signed_metrics, { head_angle: 0, shoulder_diff: 0, spine_angle: 0 })
assert.equal(engine.detect(video, 1), null)
video.currentTime++
points[8].y += Math.tan(40 * Math.PI / 180) * .2 * 1280 / 720
assert.equal(engine.detect(video, 200, 'exercise').head_angle, 40)
upright(); video.currentTime++
assert.equal(engine.detect(video, 400, 'monitor').head_angle, 0)
points[23].visibility = .1; video.currentTime++
const partial = engine.detect(video, 600)
assert.equal(partial.type, 'partial_pose')
assert.equal(partial.score, undefined)
assert.equal(partial.spine_angle, undefined)
assert.equal(partial.signed_metrics.spine_angle, undefined)
assert.equal(partial.frame_width, 1280)
throwInference = true; video.currentTime++
assert.equal(engine.detect(video, 800).type, 'no_pose')
throwInference = false
engine.resetSession(); upright()
assert.equal(engine.detect(video, 1000).score, 100)
engine.close()
assert.equal(engine.ready, false)
assert.equal(closed, 1)
creation = deferred()
const pending = engine.init()
await Promise.resolve()
engine.close()
creation.resolve()
await assert.rejects(pending, /cancelled/)
assert.equal(engine.ready, false)
creation = null; failGpu = true
await engine.init()
assert.deepEqual(delegate.slice(-2), ['GPU', 'CPU'])
engine.close()

// 最小 hook 宿主只替换 React 调度，回调/异步流程执行真实生产实现。
const realTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout
const realInterval = globalThis.setInterval, realClearInterval = globalThis.clearInterval
let nextId = 1
const timers = new Map(), rafs = new Map()
globalThis.setTimeout = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms, kind: 'timeout' }); return id }
globalThis.clearTimeout = id => timers.delete(id)
globalThis.setInterval = (fn, ms) => { const id = nextId++; timers.set(id, { fn, ms, kind: 'interval' }); return id }
globalThis.clearInterval = id => timers.delete(id)
globalThis.requestAnimationFrame = fn => { const id = nextId++; rafs.set(id, fn); return id }
globalThis.cancelAnimationFrame = id => rafs.delete(id)
let effects = [], states = []
globalThis.__hooks = {
  useRef: value => ({ current: value }),
  useState: value => { const box = { value }; states.push(box); return [value, next => { box.value = next }] },
  useCallback: fn => fn,
  useEffect: fn => { effects.push(fn) },
}
let initGate, detects = 0, resets = 0
globalThis.__engine = { init: () => initGate?.promise ?? Promise.resolve(), resetSession: () => resets++, invalidateResult: () => resets++, detect: () => { detects++; return { type: 'pose', timestamp: new Date().toISOString(), score: 100 } } }
const mocks = {
  name: 'hook-host', setup(b) {
    b.onResolve({ filter: /^(react|.*localPoseEngine|.*useWebSocket|.*platform\/runtime)$/ }, args => {
      const name = args.path === 'react' ? 'react' : args.path.endsWith('localPoseEngine') ? 'engine' : args.path.endsWith('useWebSocket') ? 'socket' : 'runtime'
      return { path: name, namespace: 'host' }
    })
    b.onLoad({ filter: /.*/, namespace: 'host' }, args => ({ contents: {
      react: 'export const { useRef, useState, useCallback, useEffect } = globalThis.__hooks;',
      engine: 'export const localPoseEngine = globalThis.__engine;',
      socket: 'export const useWebSocket = () => ({ connect(){}, disconnect(){}, sendFrame(){}, resetBackendError(){}, onPoseResult(){}, connected: false, poseResult: null, backendError: null });',
      runtime: 'export const hasLocalBackend = () => false;',
    }[args.path], loader: 'js' }))
  },
}
const { usePoseEngine } = await loadSource('src/hooks/usePoseEngine.ts', [mocks])
const hook = usePoseEngine()
const localReceived = []
hook.onPoseResult(r => localReceived.push(r))
const cleanup = effects.map(fn => fn()).filter(Boolean)
const fakeVideo = () => ({ listeners: new Map(), readyState: 2, play: async () => {}, addEventListener(name, fn) { this.listeners.set(name, fn) }, removeEventListener(name, fn) { if (this.listeners.get(name) === fn) this.listeners.delete(name) } })
const a = fakeVideo(), b = fakeVideo()
initGate = deferred()
const attaching = hook.attachVideo(a)
hook.stop()
assert.equal(localReceived.at(-1).reason, 'expired')
initGate.resolve()
await attaching
assert.equal(rafs.size, 0)
assert.equal(a.listeners.size, 0)
initGate = null
await hook.attachVideo(a)
assert.equal(rafs.size, 1)
await hook.attachVideo(b)
assert.equal(rafs.size, 1)
assert.equal(a.listeners.size, 0)
assert.equal(b.listeners.size, 1)
document.hidden = true
const [rafId, raf] = [...rafs][0]; rafs.delete(rafId); raf()
assert.equal(detects, 0)
document.hidden = false
for (const fn of cleanup) fn()
assert.equal(rafs.size, 0)
assert.equal(b.listeners.size, 0)
assert.equal(timers.size, 0)
assert.ok(resets >= 4)

// 真实 WebSocket hook：只有一个在途帧，过期回包/旧会话不得进入结果通道。
const sockets = []
globalThis.WebSocket = class {
  static OPEN = 1
  readyState = 0; bufferedAmount = 0; sent = []
  constructor() { sockets.push(this) }
  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3; this.onclose?.() }
}
effects = []; states = []
const reactOnly = { name: 'react-host', setup(b) {
  b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'react-host' }))
  b.onLoad({ filter: /.*/, namespace: 'react-host' }, () => ({ contents: 'export const { useRef, useState, useCallback, useEffect } = globalThis.__hooks;', loader: 'js' }))
} }
const { useWebSocket } = await loadSource('src/hooks/useWebSocket.ts', [reactOnly])
const socketHook = useWebSocket(), received = []
const socketCleanup = effects.map(fn => fn()).filter(Boolean)
socketHook.onPoseResult(r => received.push(r))
socketHook.connect()
const ws = sockets[0]; ws.readyState = 1; ws.onopen()
socketHook.sendFrame('frame', 'monitor'); socketHook.sendFrame('other', 'monitor')
assert.equal(ws.sent.length, 1)
const first = ws.sent[0]
ws.onmessage({ data: JSON.stringify({ ...first, type: 'pose', frame_id: first.frame_id + 1 }) })
assert.equal(received.length, 0)
ws.onmessage({ data: JSON.stringify({ ...first, type: 'partial_pose' }) })
assert.equal(received.length, 1)
socketHook.sendFrame('frame', 'exercise')
assert.equal(ws.sent.length, 2)
const ack = [...timers.values()].findLast(t => t.ms === 1500)
assert.ok(ack)
ack.fn()
assert.equal(received.at(-1).type, 'no_pose')
socketHook.disconnect()
socketHook.connect()
const failedSocket = sockets.at(-1)
failedSocket.readyState = 1
failedSocket.send = () => { throw new Error('Mock send failure') }
socketHook.sendFrame('frame', 'monitor')
assert.equal(received.at(-2).reason, 'inference_error')
assert.equal(received.at(-1).reason, 'connection_lost')
assert.equal(failedSocket.readyState, 3)
const oldClose = failedSocket.onclose, oldMessage = failedSocket.onmessage
socketHook.connect()
const replacement = sockets.at(-1)
replacement.readyState = 1
replacement.onmessage({ data: JSON.stringify({ type: 'ready' }) })
assert.equal(states[0].value, true)
oldClose()
oldMessage({ data: JSON.stringify({ type: 'error', message: 'Stale session error' }) })
assert.equal(states[0].value, true, 'Old connection must not disconnect the replacement')
assert.equal(states[2].value, null, 'Old connection must not replace backend error state')
replacement.close()
assert.equal(received.at(-1).reason, 'connection_lost')
for (const fn of socketCleanup) fn()
assert.equal(timers.size, 0)
globalThis.setTimeout = realTimeout; globalThis.clearTimeout = realClearTimeout
globalThis.setInterval = realInterval; globalThis.clearInterval = realClearInterval
console.log('Pose lifecycle: engine geometry, duplicate frames, mode switch, partial pose, inference errors, init cancellation, GPU fallback, stop-during-init, reattach cleanup, hidden-page pause, unmount cleanup and WebSocket backpressure/timeout passed')
