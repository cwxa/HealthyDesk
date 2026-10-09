/** 在隐藏 Chrome 的真实 IndexedDB 中执行生产迁移与归档。 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { findChrome, launchChrome, shutdownBrowser, startStaticServer, Cdp, evaluate, waitFor } from './verify-ui-smoke.mjs'

const dir = resolve('.buildenv/pose-storage-test')
mkdirSync(dir, { recursive: true })
const result = await build({ entryPoints: ['scripts/pose-storage-browser.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent' })
writeFileSync(resolve(dir, 'test.js'), result.outputFiles[0].text)
writeFileSync(resolve(dir, 'index.html'), '<!doctype html><script type="module">import { runStorageTests } from "./test.js"; runStorageTests().then(r => window.__result = r).catch(e => window.__result = { error: e.stack });</script>')
const { server, port } = await startStaticServer(dir)
let browser, cdp
try {
  const chrome = findChrome()
  assert.ok(chrome, 'Chrome is required for IndexedDB migration regression')
  browser = await launchChrome(chrome)
  cdp = new Cdp(`ws://127.0.0.1:${browser.port}${browser.wsPath}`)
  await cdp.connect()
  const { targetId } = await cdp.send('Target.createTarget', { url: `http://127.0.0.1:${port}/` })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await waitFor(cdp, sessionId, '!!window.__result', { timeout: 15000, label: 'IndexedDB posture migration' })
  const evaluated = await evaluate(cdp, sessionId, 'window.__result')
  assert.equal(evaluated.value?.passed, true, JSON.stringify(evaluated.value))
  console.log(`Pose storage: ${evaluated.value.checks} real IndexedDB checks passed; schema v${evaluated.value.schema}, legacy archive preserved, metric versions separated, round-trip import and CSV passed`)
} finally {
  if (browser && cdp) await shutdownBrowser(cdp, browser.child, browser.userDataDir, browser.port)
  server.close()
}
