/** 隐藏 Chrome 中验证真实个人校准组件及持久化失败处理。 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findChrome, launchChrome, shutdownBrowser, startStaticServer, Cdp, evaluate, waitFor } from './verify-ui-smoke.mjs'
const dir = resolve('.buildenv/calibration-ui-test')
mkdirSync(dir, { recursive: true })
const result = await build({ entryPoints: ['scripts/calibration-ui-browser.tsx'], bundle: true, write: false, format: 'esm', platform: 'browser', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' })
writeFileSync(resolve(dir, 'test.js'), result.outputFiles[0].text)
writeFileSync(resolve(dir, 'index.html'), '<!doctype html><script type="module">import { runCalibrationUiTests } from "./test.js"; runCalibrationUiTests().then(r => window.__result = r).catch(e => window.__result = { error: e.stack });</script>')
const { server, port } = await startStaticServer(dir)
let browser, cdp
try {
  const chrome = findChrome(); assert.ok(chrome, 'Chrome is required for calibration regression')
  browser = await launchChrome(chrome)
  cdp = new Cdp(`ws://127.0.0.1:${browser.port}${browser.wsPath}`); await cdp.connect()
  const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${port}/` })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await waitFor(cdp, sessionId, '!!window.__result', { timeout: 20000, label: 'Personal posture calibration UI' })
  const evaluated = await evaluate(cdp, sessionId, 'window.__result')
  assert.equal(evaluated.value?.passed, true, JSON.stringify(evaluated.value))
  console.log(`Posture calibration UI: ${evaluated.value.checks} real React/DOM/localStorage checks passed`)
} finally {
  if (browser && cdp) await shutdownBrowser(cdp, browser.child, browser.userDataDir, browser.port)
  server.close()
}
