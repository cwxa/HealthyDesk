#!/usr/bin/env node
/**
 * UI 冒烟：在无头 Chrome 里把「三页 × 各运行时平台」真实渲染一遍并做断言。
 *
 * 为什么需要它
 * ------------
 * 项目现有守卫全在**数值层**（双端对拍）与**产物层**（同源 / magic bytes）。
 * 中间那层——「界面还画得出来吗」——一直没人管：
 * `npm run build` 成功、类型检查通过、产物 sha256 对得上，但页面白屏、
 * 路由指不到、`?platform=` 覆盖失效，这些在现有守卫里全是绿的。
 * 真机验证能抓到，但真机验证贵、且只在发布前做一次。
 *
 * 所以这一层要一张**最便宜的网**：CI 每次跑，几秒钟内回答
 * 「本次构建的前端，在五种运行时平台下是否都能渲染出应有的界面」。
 *
 * 为什么不用 playwright / puppeteer
 * --------------------------------
 * 两条硬理由：
 *   1. 这是一个「不该拖垮 CI」的守卫。playwright 要下 100MB+ 浏览器，
 *      而本机 / CI runner 本来就有 Chrome。
 *   2. 依赖越少，守卫自己坏掉的概率越低——守卫坏了会伪装成"全绿"。
 * 所以：node 内置 http 起静态服务 + Chrome DevTools Protocol 直连。
 * Node 22 起自带全局 `WebSocket`，连 ws 客户端依赖都不需要。
 *
 * 覆盖与**不覆盖**（故意划清，免得把"没验"当成"验过了"）
 * ----------------------------------------------------
 * 覆盖：
 *   - 五种运行时平台 × 三个路由，逐页渲染 + 导航标记
 *   - `?platform=` / `?os=` 覆盖是否真的改变界面（平台专属文案的**出现与消失**）
 *   - 客户端路由（点导航后 URL 变化但**不整页刷新**、目标页渲染出来）
 *   - 设置页显示的版本号 = `package.json` 的版本（版本漂移在界面层也能抓到）
 *   - 未捕获异常、非预期的控制台错误、非预期资源加载失败
 *   - 可选：每页截图留证（`--evidence=<目录>`）
 * 不覆盖（如实记录，别读成"验过了"）：
 *   - **摄像头与姿态推理**：无头环境没有摄像头；plain `vite build` 的 dist 里
 *     也没有 MediaPipe 的 wasm/模型（那是 `cap-build` 才补的）。
 *     冒烟只保证"界面走到了取流这一步"，不保证"能出分"。
 *   - 样式细节 / 视觉回归：不做像素比对。
 *   - 真机 WebView 行为：这是**桌面无头 Chrome**，与安卓/iOS 的 WebView 不是同一个内核版本。
 *     真机那部分见 `docs/device-matrix.md`。
 *
 * 与"本机是否恰好有个后端在跑"无关（刻意如此）
 * ---------------------------------------------
 * 冒烟自己不启动后端。但本机开发时 18920 上**可能真有**一个后端在跑 ——
 * 这时前端调 `/api/*` 会得到 `blocked by CORS policy`，而没后端时是 `ERR_CONNECTION_REFUSED`。
 * 两种形态都已归入"预期失败"（见 `BENIGN_CONSOLE`）：**结论不该取决于环境**。
 * 实测踩到过：后端在跑时，CORS 那条日志的 `url` 是**页面地址**，按 URL 判会误报成"非预期失败"。
 *
 * 用法
 * ----
 *   npm run verify:ui                      # 需要先 npm run build:web
 *   node scripts/verify-ui-smoke.mjs --evidence=.buildenv/ui-shots
 *   node scripts/verify-ui-smoke.mjs --case=android        # 只跑一个平台组合
 *   node scripts/verify-ui-smoke.mjs --dist=dist --timeout=15000
 *   node scripts/verify-ui-smoke.mjs --dump                # 守卫红了先看这个，别猜
 *
 * 环境变量：`NG_CHROME` / `CHROME_PATH` 可指定浏览器可执行文件。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')

// ───────────────────────────── 参数 ─────────────────────────────

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) out[m[1]] = m[2] === undefined ? true : m[2]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const DIST = path.resolve(ROOT, args.dist || 'dist')
const ONLY = args.case || ''
const EVIDENCE_DIR = args.evidence ? path.resolve(ROOT, args.evidence) : ''
const SETTLE_MS = Number(args.settle || 700)
const WAIT_MS = Number(args.timeout || 12000)
/** `--dump`：把每页实际渲染出来的文本打出来。守卫失败时靠它定位，比猜强。 */
const DUMP = !!args.dump

// ─────────────────────────── 用例定义 ───────────────────────────

const DESKTOP_VIEWPORT = { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false }
const MOBILE_VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }

/**
 * 每个平台组合一条。`label` 必须与 `src/platform/runtime.ts:platformLabel()` 逐字一致 ——
 * 断言「界面里显示的平台名」等于「URL 覆盖声明的平台」，才能证明覆盖真的生效了，
 * 而不是"页面碰巧也渲染出来了"。
 */
const PLATFORM_CASES = [
  {
    name: 'web',
    query: 'platform=web',
    viewport: DESKTOP_VIEWPORT,
    label: '网页版',
    form: '桌面端',
  },
  {
    name: 'electron-windows',
    query: 'platform=electron&os=windows',
    viewport: DESKTOP_VIEWPORT,
    label: '桌面版 (Windows)',
    form: '桌面端',
  },
  {
    name: 'electron-macos',
    query: 'platform=electron&os=macos',
    viewport: DESKTOP_VIEWPORT,
    label: '桌面版 (macOS)',
    form: '桌面端',
  },
  {
    name: 'android',
    query: 'platform=android',
    viewport: MOBILE_VIEWPORT,
    label: '安卓版',
    form: '移动端',
  },
  {
    name: 'ios',
    query: 'platform=ios',
    viewport: MOBILE_VIEWPORT,
    label: 'iOS 版',
    form: '移动端',
  },
]

/** 路由 → 该页必须出现 / 必须不出现的文案。 */
const ROUTES = [
  {
    hash: '#/',
    name: '肩颈活动',
    must: ['🧘 肩颈活动'],
    mustNot: [],
    // 该页挂载时会自动取流。断言它**落到确定态**（出画面，或给出可照做的错误提示），
    // 而不是永久停在过程文案上 —— 见下方 settles 的用法说明。
    settles: 'camera',
  },
  {
    hash: '#/dashboard',
    name: '仪表盘',
    must: ['📊 仪表盘', '您的肩颈健康概览', '健康指数'],
    mustNot: [],
    // 桌面端才有的 AI 面板（`{!isMobile() && <AIAnalysisPanel/>}`）
    desktopOnly: ['AI 肩颈分析'],
  },
  {
    hash: '#/settings',
    name: '系统设置',
    must: ['⚙ 系统设置', '数据管理', '导出备份 (JSON)', '导入备份', '关于 NeckGuardian'],
    mustNot: [],
    // 桌面端与移动端**互斥**的一对文案：证明 `isMobile()` 真的切换了
    desktopOnly: ['AI 增强模式', '电脑的备份可以导进手机'],
    mobileOnly: ['手机的备份可以导回电脑'],
  },
]

/**
 * 「预期内」的资源/接口失败（按 **URL** 判）。
 *
 * 冒烟刻意**不**启动 Python 后端、也**不**补 MediaPipe 的 wasm（见文件头"不覆盖"），
 * 所以这两类 404 / 连接失败必然出现。把它们和**真问题**区分开，
 * 否则只能把"有错就失败"退化成"什么都不查"。
 */
const BENIGN_URL = [
  /\/mediapipe\//, // 模型与 wasm 由 cap-build 补，plain dist 没有
  /\/api\//, // 后端接口
  /\/ws\//, // WebSocket 通道
  /18920/, // 后端端口
  /favicon/i,
  /^chrome-extension:\/\//,
  /^devtools:\/\//,
]

/**
 * 「预期内」的错误（按**文本**判，不看 URL）。
 *
 * 🔴 这里必须按文本判，因为**同一件事在两种环境下报错形态完全不同**：
 *    - 18920 上没有后端在跑 → `net::ERR_CONNECTION_REFUSED`，`entry.url` 是那个 18920 地址；
 *    - 18920 上**有**后端在跑（本机开发时就是如此，实测踩到）→ 变成
 *      `blocked by CORS policy: ... No 'Access-Control-Allow-Origin' header`，
 *      而这时 `entry.url` 是**页面 URL**，URL 规则一条都匹配不上 → 误报成"非预期"。
 * 于是"是否恰好有个后端在跑"会决定冒烟绿不绿 —— 那是环境噪音，不是回归。
 * 这道网要抓的是**前端资源**（JS / CSS / 图标 / wasm 404），所以按文本归类是安全的。
 */
const BENIGN_CONSOLE = [
  /mediapipe/i,
  /websocket|ws:\/\//i,
  /failed to fetch|networkerror|err_connection|net::err|err_failed/i,
  /getusermedia|notfounderror|notallowederror|notreadableerror|device not found|permission|denied/i,
  /favicon/i,
  /cors|access-control-allow-origin|preflight/i, // 后端在跑时的形态
  /18920|\/api\//, // 指向后端的请求
]

// ─────────────────────────── 工具函数 ───────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function firstExistingPath(candidates) {
  for (const c of candidates) {
    if (!c) continue
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {
      /* 继续找下一个 */
    }
  }
  return ''
}

/** 在 PATH 里找一个可执行文件（自己实现，免得 spawn 一个 shell 在 Windows 上出编码问题）。 */
function which(cmd) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext)
      try {
        fs.accessSync(p, fs.constants.X_OK)
        return p
      } catch {
        /* 继续 */
      }
    }
  }
  return ''
}

/**
 * 找浏览器。**找不到要让调用方明确失败**，不能静默跳过 ——
 * 一个"检测不到就不查"的守卫，等于永远绿的守卫。
 */
function findChrome() {
  const local = process.env.LOCALAPPDATA || ''
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const explicit = firstExistingPath([
    process.env.NG_CHROME,
    process.env.CHROME_PATH,
    path.join(ROOT, '.buildenv', 'chrome-path.txt') &&
      (() => {
        try {
          const p = fs.readFileSync(path.join(ROOT, '.buildenv', 'chrome-path.txt'), 'utf8').trim()
          return fs.existsSync(p) ? p : ''
        } catch {
          return ''
        }
      })(),
  ])
  if (explicit) return explicit

  const byFile = firstExistingPath([
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    local && path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ])
  if (byFile) return byFile

  // Linux / CI：常见是 PATH 上的 google-chrome 或 chromium
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const p = which(name)
    if (p) return p
  }
  return ''
}

// ─────────────────────────── 静态服务 ───────────────────────────

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
}

function startStaticServer(dir) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0])
    if (rel.endsWith('/')) rel += 'index.html'
    const file = path.join(dir, rel)
    // 目录穿越防护：解析后必须仍在 dist 之内
    if (!path.resolve(file).startsWith(path.resolve(dir))) {
      res.writeHead(403).end('forbidden')
      return
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
        // SPA 回退：非资源请求一律给 index.html（HashRouter 下正常不会走到，
        // 但 `--headless` 偶尔会请求 /favicon.ico 之类，给个 404 更诚实）
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      })
      res.end(buf)
    })
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

// ────────────────────── CDP 客户端（零依赖） ──────────────────────

class Cdp {
  constructor(url) {
    this.url = url
    this.nextId = 0
    this.pending = new Map()
    this.handlers = new Map()
    this.closed = false
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url)
      this.ws = ws
      const onFail = (e) => reject(new Error(`CDP 连接失败：${e?.message || e}`))
      ws.addEventListener('open', () => {
        ws.removeEventListener('error', onFail)
        resolve()
      })
      ws.addEventListener('error', onFail, { once: true })
      ws.addEventListener('message', (ev) => {
        let msg
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
        } catch {
          return
        }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id)
          this.pending.delete(msg.id)
          if (msg.error) rej(new Error(`${msg.error.message}（${msg.error.code}）`))
          else res(msg.result)
          return
        }
        if (msg.method) {
          for (const h of this.handlers.get(msg.method) || []) h(msg.params, msg.sessionId)
        }
      })
      ws.addEventListener('close', () => {
        this.closed = true
      })
    })
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, [])
    this.handlers.get(method).push(fn)
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 30000)
      const done = (fn) => (v) => {
        clearTimeout(timer)
        fn(v)
      }
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) })
      this.ws.send(JSON.stringify(payload))
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* 忽略 */
    }
  }
}

// ─────────────────────────── 启动 Chrome ───────────────────────────

async function launchChrome(exe) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ng-smoke-'))
  const child = spawn(
    exe,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--mute-audio',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      // CI 容器常以 root 跑，沙箱会直接起不来；冒烟不加载外部页面，关掉是安全的
      '--no-sandbox',
      '--disable-dev-shm-usage',
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  )

  let stderr = ''
  child.stderr?.on('data', (d) => {
    stderr += String(d)
  })

  // Chrome 会把实际端口写进 <user-data-dir>/DevToolsActivePort：
  // 第一行是端口，第二行是**浏览器级 WebSocket 路径**（形如 /devtools/browser/<uuid>）。
  // 🔴 不能自己拼 `/devtools/browser` —— 少了那段 uuid 会握手失败
  //    （报 "Received network error or non-101 status code"），且看不出是路径问题。
  // 用 =0 让系统分配端口，避免与其他进程抢 9222。
  const portFile = path.join(userDataDir, 'DevToolsActivePort')
  const deadline = Date.now() + 25000
  let port = 0
  let wsPath = ''
  while (Date.now() < deadline) {
    if (fs.existsSync(portFile)) {
      const txt = fs.readFileSync(portFile, 'utf8').split('\n')
      port = Number(txt[0])
      wsPath = (txt[1] || '').trim()
      if (port > 0 && wsPath) break
    }
    if (child.exitCode != null) break
    await sleep(120)
  }

  if (!port || !wsPath) {
    child.kill()
    throw new Error(
      `Chrome 启动失败（未写出 DevToolsActivePort，exit=${child.exitCode}）\n` +
        `  exe: ${exe}\n  最近 stderr: ${stderr.slice(-600) || '(空)'}`,
    )
  }
  return { child, userDataDir, port, wsPath }
}

// ─────────────────────────── 断言执行 ───────────────────────────

class Runner {
  constructor() {
    this.passed = 0
    this.failed = 0
    this.failures = []
  }
  ok(label) {
    this.passed++
    console.log(`    ✓ ${label}`)
  }
  fail(label, detail) {
    this.failed++
    this.failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`    ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
  check(cond, label, detail) {
    if (cond) this.ok(label)
    else this.fail(label, detail)
    return !!cond
  }
}

/** 在页面里求值；表达式抛错时返回 ok:false 而不是让整个脚本崩掉。 */
async function evaluate(cdp, sessionId, expression) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )
  if (r.exceptionDetails) {
    return { ok: false, error: r.exceptionDetails.exception?.description || 'evaluate 抛错', value: undefined }
  }
  return { ok: true, value: r.result?.value }
}

async function waitFor(cdp, sessionId, expression, { timeout = WAIT_MS, poll = 100, label = '' } = {}) {
  const deadline = Date.now() + timeout
  let last = ''
  while (Date.now() < deadline) {
    const r = await evaluate(cdp, sessionId, expression)
    if (r.ok && r.value) return r.value
    last = r.ok ? String(r.value) : r.error
    await sleep(poll)
  }
  throw new Error(`等待超时（${timeout}ms）：${label || expression}；最后一次取值=${last}`)
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error(`::error::UI 冒烟无法进行：${DIST}/index.html 不存在（先跑 npm run build:web）`)
    process.exit(1)
  }

  const requested = process.env.appVersion || ''
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const version = pkg.version || requested

  const chrome = findChrome()
  if (!chrome) {
    console.error('::error::UI 冒烟无法进行：没找到 Chrome / Chromium / Edge')
    console.error('  可用 NG_CHROME 或 CHROME_PATH 指定可执行文件路径。')
    console.error('  🔴 不要改成"找不到就跳过"——那样这个守卫会永远是绿的。')
    process.exit(1)
  }

  const cases = ONLY ? PLATFORM_CASES.filter((c) => c.name === ONLY) : PLATFORM_CASES
  if (cases.length === 0) {
    console.error(`::error::--case=${ONLY} 没有匹配的用例。可选：${PLATFORM_CASES.map((c) => c.name).join(' / ')}`)
    process.exit(2)
  }

  if (EVIDENCE_DIR) fs.mkdirSync(EVIDENCE_DIR, { recursive: true })

  const { server, port } = await startStaticServer(DIST)
  const origin = `http://127.0.0.1:${port}`
  console.log(`UI 冒烟 · 无头 Chrome`)
  console.log(`  静态目录  ${path.relative(ROOT, DIST) || '.'} → ${origin}`)
  console.log(`  浏览器    ${chrome}`)

  const { child, userDataDir, port: dbgPort, wsPath } = await launchChrome(chrome)
  const cdp = new Cdp(`ws://127.0.0.1:${dbgPort}${wsPath}`)

  const run = new Runner()
  let browserVersion = ''

  const cleanup = () => {
    cdp.close()
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
    try {
      server.close()
    } catch {
      /* 忽略 */
    }
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* Windows 上可能还被占用，忽略 */
    }
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(130)
  })

  try {
    await cdp.connect()
    const ver = await cdp.send('Browser.getVersion')
    browserVersion = ver.product || ''
    console.log(`  版本      ${browserVersion}`)
    console.log(`  用例      ${cases.length} 个平台组合 × ${ROUTES.length} 个路由\n`)

    for (const c of cases) {
      console.log(`── ${c.name}  (${c.query})`)
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })

      const consoleErrors = []
      const uncaught = []
      const badResources = []

      cdp.on('Runtime.consoleAPICalled', (p, sid) => {
        if (sid !== sessionId) return
        if (p.type !== 'error' && p.type !== 'assert') return
        const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')
        if (BENIGN_CONSOLE.some((re) => re.test(text))) return
        consoleErrors.push(text)
      })
      cdp.on('Runtime.exceptionThrown', (p, sid) => {
        if (sid !== sessionId) return
        const d = p.exceptionDetails || {}
        uncaught.push(d.exception?.description || d.text || '未知异常')
      })
      cdp.on('Log.entryAdded', (p, sid) => {
        if (sid !== sessionId) return
        const e = p.entry || {}
        if (e.level !== 'error') return
        const url = e.url || ''
        const text = `${e.text || ''}`
        if (BENIGN_URL.some((re) => re.test(url))) return
        // 按文本判（不看 URL）：后端在跑 / 不在跑，同一件事的报错形态不同。
        if (BENIGN_CONSOLE.some((re) => re.test(text))) return
        badResources.push(`${text}${url ? ` <${url}>` : ''}`)
      })

      await cdp.send('Page.enable', {}, sessionId)
      await cdp.send('Runtime.enable', {}, sessionId)
      await cdp.send('Log.enable', {}, sessionId)
      await cdp.send('Emulation.setDeviceMetricsOverride', { ...c.viewport }, sessionId)

      const url = `${origin}/?${c.query}`
      await cdp.send('Page.navigate', { url }, sessionId)

      try {
        await waitFor(cdp, sessionId, `document.readyState === 'complete'`, {
          label: '页面加载完成',
        })
      } catch (e) {
        run.fail(`${c.name} 页面加载`, e.message)
        await cdp.send('Target.closeTarget', { targetId })
        continue
      }

      // 挂一个哨兵：路由切换后它必须还在 —— 不在了说明发生了整页刷新
      await evaluate(cdp, sessionId, `window.__ngSmokeSentinel = 'alive'; true`)

      if (DUMP) {
        const info = await evaluate(
          cdp,
          sessionId,
          `(() => {
             const t = document.body ? document.body.innerText : '(无 body)';
             return {
               href: location.href,
               hash: location.hash,
               rootChildren: document.getElementById('root')?.childElementCount ?? -1,
               anchors: [...document.querySelectorAll('a')].map((a) => a.getAttribute('href')).slice(0, 10),
               text: t.slice(0, 400),
             };
           })()`,
        )
        console.log('    ┌ dump 首屏', JSON.stringify(info.value, null, 1).replace(/\n/g, '\n    │ '))
      }

      // 🔴 等「应用壳」真的渲染出来，而不是只等 readyState。
      //    `readyState === 'complete'` 时页面可能还停在启动闸门后面：
      //    App.tsx 里 `setTimeout(() => setBackendReady(true), mobile ? 300 : 5000)`
      //    —— 浏览器里没有 electronAPI，`onBackendReady` 永不触发，只能等这个兜底计时器。
      //    桌面端因此会先显示 5 秒「正在启动服务...」。不等它，后面找导航项必然落空。
      //    导航项存在 ⟺ 应用壳（Sidebar / BottomTabs）已挂载 —— 这本身就是一条有效断言。
      let shellOk = true
      try {
        await waitFor(cdp, sessionId, `!!document.querySelector('a[href="#/dashboard"]')`, {
          label: `${c.name} 应用壳渲染（导航项出现）`,
        })
      } catch (e) {
        run.fail(`${c.name} 应用壳渲染`, e.message)
        shellOk = false
      }
      if (!shellOk) {
        await cdp.send('Target.closeTarget', { targetId })
        console.log('')
        continue
      }
      if (DUMP) {
        const info = await evaluate(
          cdp,
          sessionId,
          `({ hash: location.hash, text: document.body.innerText.slice(0, 300) })()`,
        )
        console.log('    ┌ dump 壳就绪', JSON.stringify(info.value, null, 1).replace(/\n/g, '\n    │ '))
      }

      for (const r of ROUTES) {
        const where = `${c.name} ${r.hash}`
        try {
          // 首个路由是 `/`：应用启动时 URL 里**没有 hash**（HashRouter 不会去改它），
          // 所以这里不能断言 `location.hash === '#/'` —— 那是 `''`。
          // 只对「点导航切过去」的路由校验 URL 变化。
          if (r.hash !== '#/') {
            // 真实交互：点导航项（NavLink 渲染成 <a href="#/...">），
            // 而不是直接改 location.hash —— 那样就绕过了路由组件本身
            const clicked = await evaluate(
              cdp,
              sessionId,
              `(() => {
                 const a = document.querySelector('a[href="${r.hash}"]');
                 if (!a) return false;
                 a.click();
                 return true;
               })()`,
            )
            if (!clicked.ok || !clicked.value) {
              run.fail(`${where} 找到导航项并点击`, '页面上没有对应的导航链接')
              continue
            }
            await waitFor(cdp, sessionId, `location.hash === '${r.hash}'`, {
              timeout: 4000,
              label: `${where} URL 变化`,
            })
          }

          const bodyText = await waitFor(
            cdp,
            sessionId,
            `(() => {
               const t = document.body ? document.body.innerText : '';
               return ${JSON.stringify(r.must[0])} && t.includes(${JSON.stringify(r.must[0])}) ? t : '';
             })()`,
            { label: `${where} 渲染出「${r.must[0]}」` },
          )

          // 非空页面：既要有内容，也要挂载了 React 树
          const mounted = await evaluate(
            cdp,
            sessionId,
            `(() => {
               const root = document.getElementById('root');
               return !!root && root.childElementCount > 0 && document.body.innerText.trim().length > 40;
             })()`,
          )
          run.check(mounted.ok && mounted.value, `${where} 已挂载且非空白`, 'root 无子节点或正文字符过少')

          let pageOk = true
          for (const m of r.must) {
            if (!bodyText.includes(m)) {
              run.fail(`${where} 含「${m}」`, '文案缺失')
              pageOk = false
            }
          }
          if (pageOk) run.ok(`${where} 渲染 OK（${r.must.length} 处标记）`)

          // 「卡 loading 而不是报错」是本项目踩过的一类真 bug：
          // 某个 `await` 永不 settle，界面就一直停在过程文案上，不崩、不报错、
          // 所有日志都正常 —— 只有人盯着屏幕才发现。所以这里对**会自己发起异步流程**的
          // 页面断言「过程文案已经消失」，把这类问题变成一条能自动查的判据。
          // 无头环境没有摄像头，正常应在 1 秒内落到错误态（给出可照做的提示）。
          // 超时给到 20s（应用自身的取流超时是 30s，这里只作"是否卡住"的判据）。
          if (r.settles === 'camera') {
            try {
              await waitFor(
                cdp,
                sessionId,
                `(() => {
                   const t = document.body.innerText;
                   return !/(正在启动摄像头|正在申请相机权限并取流|正在启动画面|正在加载姿态模型|正在连接后端)/.test(t);
                 })()`,
                { timeout: 20000, label: `${where} 摄像头流程落到确定态` },
              )
              run.ok(`${where} 摄像头流程落到确定态（未永久停在加载中）`)
            } catch (e) {
              run.fail(`${where} 摄像头流程落到确定态`, `疑似卡在加载中：${e.message}`)
            }
          }

          for (const m of r.mustNot || []) {
            if (bodyText.includes(m)) run.fail(`${where} 不应含「${m}」`, '出现了不该出现的文案')
          }

          // 平台差异化文案：出现 / 消失**都要断言**。
          // 只断言"应有出现"是抓不到"两边都渲染"的（比如 isMobile() 恒为 false）。
          const isMobileCase = c.form === '移动端'
          for (const m of r.desktopOnly || []) {
            if (isMobileCase) {
              if (bodyText.includes(m)) run.fail(`${where} 移动端不应含「${m}」`, 'isMobile() 判定失效')
            } else if (!bodyText.includes(m)) {
              run.fail(`${where} 桌面端应含「${m}」`, '文案缺失')
            }
          }
          for (const m of r.mobileOnly || []) {
            if (isMobileCase) {
              if (!bodyText.includes(m)) run.fail(`${where} 移动端应含「${m}」`, '文案缺失')
            } else if (bodyText.includes(m)) {
              run.fail(`${where} 桌面端不应含「${m}」`, 'isMobile() 判定失效')
            }
          }

          // 设置页：界面自报的「平台 + 形态 + 版本」必须与 URL 覆盖 / package.json 一致
          if (r.hash === '#/settings') {
            const expectPlatform = `平台：${c.label}（${c.form}）`
            run.check(
              bodyText.includes(expectPlatform),
              `${where} 自报「${expectPlatform}」`,
              '?platform=/?os= 覆盖没生效，或 platformLabel() 与实际不符',
            )
            run.check(
              bodyText.includes(`版本：${version}`),
              `${where} 自报版本 ${version}`,
              '界面里的版本号与 package.json 不一致（五处同步漏了一处？）',
            )
          }

          if (EVIDENCE_DIR) {
            // 等动画落定再截图：页面里大量 framer-motion 的 `initial={{opacity:0}}`，
            // 立刻截图会拍到"下半屏还没淡入"的中间帧 —— 那种图看不出问题，还会误导人。
            await sleep(SETTLE_MS)
            const shot = await cdp.send(
              'Page.captureScreenshot',
              { format: 'png', captureBeyondViewport: false },
              sessionId,
            )
            const suffix = r.hash === '#/' ? 'root' : r.hash.slice(2)
            fs.writeFileSync(
              path.join(EVIDENCE_DIR, `${c.name}-${suffix}.png`),
              Buffer.from(shot.data, 'base64'),
            )
          }

          // 客户端路由：换了 URL 但**没整页刷新**
          const alive = await evaluate(cdp, sessionId, `window.__ngSmokeSentinel === 'alive'`)
          run.check(alive.ok && alive.value === true, `${where} 未整页刷新`, '哨兵丢了 = 发生了 reload')
        } catch (e) {
          run.fail(`${where} 渲染`, e.message)
        }
      }

      // 页面级错误汇总
      if (uncaught.length) {
        run.fail(`${c.name} 无未捕获异常`, `${uncaught.length} 条：${uncaught.slice(0, 2).join(' | ')}`)
      } else {
        run.ok(`${c.name} 无未捕获异常`)
      }
      if (consoleErrors.length) {
        run.fail(`${c.name} 无非预期控制台错误`, `${consoleErrors.length} 条：${consoleErrors.slice(0, 2).join(' | ')}`)
      } else {
        run.ok(`${c.name} 无非预期控制台错误`)
      }
      if (badResources.length) {
        run.fail(`${c.name} 无非预期资源加载失败`, `${badResources.length} 条：${badResources.slice(0, 2).join(' | ')}`)
      } else {
        run.ok(`${c.name} 无非预期资源加载失败`)
      }

      await cdp.send('Target.closeTarget', { targetId })
      console.log('')
    }
  } catch (e) {
    console.error(`::error::UI 冒烟执行失败：${e.message}`)
    cleanup()
    process.exit(1)
  }

  cleanup()

  console.log('─'.repeat(60))
  if (run.failed > 0) {
    console.error(`::error::UI 冒烟失败：${run.failed} 项断言未通过（${run.passed} 项通过）`)
    for (const f of run.failures.slice(0, 20)) console.error(`  ✗ ${f}`)
    process.exit(1)
  }
  console.log(`✅ UI 冒烟通过：${cases.length} 个平台组合 × ${ROUTES.length} 个路由，${run.passed} 项断言`)
  if (EVIDENCE_DIR) console.log(`   截图已存：${path.relative(ROOT, EVIDENCE_DIR)}`)
}

main()
