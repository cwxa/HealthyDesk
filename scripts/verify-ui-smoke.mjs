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
 *   - **活动收尾屏**（`#/` 上真实点「开始活动」→「结束活动」）：
 *     逐动作得分列表、零明细时成绩显示 `--`（不是 0）、7 个动作逐个如实标「未判定」、
 *     旧口径标签已消失；**再查落库**（走 IndexedDB 的用例才把记录留在同一个源上）：
 *     `action_scores` 的规范文本逐字节、`avg_score` 与明细同源，
 *     并在仪表盘历史里回读 —— 零明细显示 `--`、**迁移前的老记录照常显示分数且被标出「旧口径」**。
 *     这是 S10「逐动作评分」唯一的用户可见出口，ROUTES 那种"页面渲染得出来"的断言覆盖不到它。
 *   - **新手引导**（首次打开时盖在界面上那层）：清掉标志重新加载 → 引导出现 →
 *     逐步点完 4 步（**每步标题都要变**；只验"遮罩出现了"会漏掉"卡在第 1 步不动"）→
 *     点「开始使用」→ 遮罩消失 + 「已看过」标志真的落盘 → **再次加载后不再自动出现** →
 *     设置页「重新查看新手引导」能把它叫回来 → 「跳过」能关掉。
 *     ⚠️ 这一段必须在 ROUTES **之前**跑完：引导的遮罩盖在页面上，但下层仍在 DOM 里，
 *     开着它去断言页面文案等于把"被盖住了"验成"渲染得出来"（`innerText` 两层都读得到）。
 *   - `?platform=` / `?os=` 覆盖是否真的改变界面（平台专属文案的**出现与消失**）
 *   - 客户端路由（点导航后 URL 变化但**不整页刷新**、目标页渲染出来）
 *   - 设置页显示的版本号 = `package.json` 的版本（版本漂移在界面层也能抓到）
 *   - 未捕获异常、非预期的控制台错误、非预期资源加载失败
 *   - 可选：截图留证（`--evidence=<目录>`）—— 每页一张，另加**新手引导的第 1 / 第 4 步**各一张
 *     （引导是视觉产品，"排版塌了/按钮被遮"这类问题断言看不出来）
 * 不覆盖（如实记录，别读成"验过了"）：
 *   - **摄像头与姿态推理**：无头环境没有摄像头；plain `vite build` 的 dist 里
 *     也没有 MediaPipe 的 wasm/模型（那是 `cap-build` 才补的）。
 *     冒烟只保证"界面走到了取流这一步"，不保证"能出分"。
 *   - **有真实帧时的收尾分数**：收尾屏那条断言跑的是"零采样"分支，
 *     "判出来的分数对不对"只能靠 `verify:exercise-quality`（数值层）与真机层。
 *   - **HTTP 落库的端到端**：桌面/electron 用例只验到"请求发出去时带的是规范文本"
 *     （探针拦的是 `fetch` 的入参），**没有后端**去收它 —— 真正的写库由
 *     `verify:schema` 与后端的迁移守卫覆盖。
 *   - **引导与提醒弹窗的互斥**（`App.tsx` 里那条 `&& !onboardingOpen`）：无头环境里
 *     没有提醒会弹（桌面端要后端推、移动端定时器不会立刻触发），这里**验不到**。
 *     它只在真机上看得出来 —— 与"提醒相关的一切"同属真机层。
 *   - **`localStorage` 写不进去时的降级**（隐私模式 / 配额满）：那样引导会每次启动都出现。
 *     无头 Chrome 的临时 profile 复现不出这个环境，只能靠代码里的 try/catch 兜住。
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
 *
 * `systemTray` / `autoStart` 是**能力期望**，必须与 `runtime.ts` 的 `CAPABILITIES` 一致。
 * 新手引导的第 4 步按这两个能力选文案，所以它们不只是描述，而是断言依据。
 */
const PLATFORM_CASES = [
  {
    name: 'web',
    query: 'platform=web',
    viewport: DESKTOP_VIEWPORT,
    label: '网页版',
    form: '桌面端',
    systemTray: false,
    autoStart: false,
  },
  {
    name: 'electron-windows',
    query: 'platform=electron&os=windows',
    viewport: DESKTOP_VIEWPORT,
    label: '桌面版 (Windows)',
    form: '桌面端',
    systemTray: true,
    autoStart: true,
  },
  {
    name: 'electron-macos',
    query: 'platform=electron&os=macos',
    viewport: DESKTOP_VIEWPORT,
    label: '桌面版 (macOS)',
    form: '桌面端',
    systemTray: true,
    autoStart: true,
  },
  {
    name: 'android',
    query: 'platform=android',
    viewport: MOBILE_VIEWPORT,
    label: '安卓版',
    form: '移动端',
    systemTray: false,
    autoStart: false,
  },
  {
    name: 'ios',
    query: 'platform=ios',
    viewport: MOBILE_VIEWPORT,
    label: 'iOS 版',
    form: '移动端',
    systemTray: false,
    autoStart: false,
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

// ─────────────────────── 新手引导（首次打开） ───────────────────────

/**
 * 「已看过」标志写在哪个 `localStorage` 键上 —— **从源码里读**，不在这里再写一份。
 *
 * 键盘名是**持久化契约**：换了键，所有老用户的"已看过"当场作废、每个人再被引导一次。
 * 那可以接受，但必须是**有意识的**决定 —— 所以下面的断言把期望值钉死，
 * 改键名会让守卫红，而不是悄悄换一个键继续跑。
 */
/** 期望的键名。改它 = 有意让所有老用户再看一次引导（见 main 里那条断言）。 */
const EXPECTED_ONBOARDING_KEY = 'neckguardian:onboarding'

function readOnboardingKey() {
  const src = fs.readFileSync(path.join(ROOT, 'src/platform/onboarding.ts'), 'utf8')
  const m = /ONBOARDING_KEY\s*=\s*['"]([^'"]+)['"]/.exec(src)
  return m ? m[1] : ''
}

/** 源码里实际用的键（由上面的函数读出）。 */
const ONBOARDING_KEY = readOnboardingKey()

/**
 * 新手引导那一段的全部断言。返回时把 URL 交还给后面的 ROUTES 段。
 *
 * 进入本函数前，调用方已经**清掉标志并重新加载**过 —— 所以这里从"没见过引导的新用户"
 * 这个状态开始（同一浏览器 profile 下 `localStorage` 是跨用例共享的，
 * 少了调用方那次清理，第二个平台用例开始就再也看不到引导了）。
 */
async function checkOnboarding(cdp, sessionId, run, c, key) {
  const where = `${c.name} 新手引导`
  const SEL = '[data-ng="onboarding"]'
  const SEL_Q = JSON.stringify(SEL)

  const clickByText = (text) => `(() => {
       const b = [...document.querySelectorAll('button')]
         .find((x) => x.textContent.replace(/\\s/g, '') === ${JSON.stringify(text)});
       if (!b) return false;
       b.click();
       return true;
     })()`

  const readStep = `(() => {
       const root = document.querySelector(${SEL_Q});
       if (!root) return null;
       const h2 = root.querySelector('h2');
       const dots = root.querySelector('[data-ng="onboarding-dots"]');
       const texts = [...root.querySelectorAll('button')].map((b) => b.textContent.replace(/\\s/g, ''));
       return {
         title: h2 ? h2.textContent : '',
         progress: dots ? dots.textContent.replace(/\\s/g, '') : '',
         body: root.innerText.replace(/\\s/g, ''),
         next: texts.indexOf('下一步') >= 0,
         done: texts.indexOf('开始使用') >= 0,
         skip: texts.indexOf('跳过') >= 0,
       };
     })()`

  // ① 首次打开必须出现（判定读的是 localStorage，同步 —— 所以它与应用壳同一帧）
  try {
    await waitFor(cdp, sessionId, `!!document.querySelector(${SEL_Q})`, {
      timeout: WAIT_MS,
      label: `${where} 出现`,
    })
    run.ok(`${where} 首次打开时出现`)
  } catch (e) {
    run.fail(`${where} 首次打开时出现`, `没等到引导 —— 判定失效或遮罩没渲染：${e.message}`)
    return
  }

  /**
   * 截图留证（仅 `--evidence=` 时）。
   *
   * 引导是**视觉**产品：断言只能证明"文案对、行为对"，而**排版塌了 / 文字溢出 /
   * 按钮被遮住**它一条都看不见。所以第 1 步与最后一步各留一张图给人看 ——
   * 改文案或改步数的人应该顺手翻一眼这两张。
   */
  const shoot = async (tag) => {
    if (!EVIDENCE_DIR) return
    await sleep(SETTLE_MS)
    const shot = await cdp.send(
      'Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: false },
      sessionId,
    )
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, `${c.name}-onboarding-${tag}.png`),
      Buffer.from(shot.data, 'base64'),
    )
  }

  // ② 起始位置
  const first = await evaluate(cdp, sessionId, readStep)
  const info = first.value
  if (!info) {
    run.fail(`${where} 读得到当前步骤`, '引导节点在，但读不到标题/进度')
    return
  }
  run.check(
    /^1\/4$/.test(info.progress),
    `${where} 从第 1 步开始、共 4 步`,
    `进度显示「${info.progress}」—— 改了步数？同步改这里与 docs/ROADMAP.md 的需求 11`,
  )
  run.check(info.next, `${where} 第 1 步有「下一步」`)
  run.check(info.skip, `${where} 第 1 步能跳过（不是强制走完）`, '没有「跳过」按钮')
  await shoot('1')

  // ③ 逐步走完：每点一次，标题都必须**变**  //    只断言"遮罩还在"会漏掉"卡在第 1 步不动"；只断言"点了有反应"会漏掉"四步同一份文案"。
  const titles = [info.title]
  const bodies = [info.body]
  let last = info
  for (let n = 2; n <= 4; n++) {
    const clicked = await evaluate(cdp, sessionId, clickByText('下一步'))
    if (!clicked.ok || clicked.value !== true) {
      run.fail(`${where} 点得到「下一步」（去第 ${n} 步）`, '按钮不存在')
      break
    }
    await sleep(180) // 等这一次切换落定，别读到上一帧的标题
    const r = await evaluate(cdp, sessionId, readStep)
    if (!r.ok || !r.value) {
      run.fail(`${where} 第 ${n} 步读得到内容`, r.error || '引导节点不见了')
      break
    }
    last = r.value
    titles.push(last.title)
    bodies.push(last.body)
  }
  run.check(titles.length === 4, `${where} 4 步全走到了`, `实际走到 ${titles.length} 步`)
  run.check(
    titles.length === 4 && new Set(titles).size === 4 && titles.every((t) => t && t.trim()),
    `${where} 4 步的标题互不相同且非空`,
    `实际：${JSON.stringify(titles)}`,
  )
  run.check(
    !last.next && last.done,
    `${where} 最后一步是「开始使用」而不是「下一步」`,
    `next=${last.next} done=${last.done}`,
  )

  // ③b 平台差异：第 2 步的形态措辞、第 4 步的托盘/自启措辞都**来自能力矩阵**。
  //     「出现」和「消失」两边都断言 —— 只验一边抓不到"两边都渲染"
  //     （`isMobile()` 恒 false、`supports()` 读错字段之类都会漏过去）。
  const mobileCase = c.form === '移动端'
  const step2 = bodies[1] || ''
  const step4 = bodies[3] || ''
  const want2 = mobileCase ? '手机架在面前' : '摄像头对准自己'
  const wrong2 = mobileCase ? '摄像头对准自己' : '手机架在面前'
  run.check(
    step2.includes(want2),
    `${where} 第 2 步按形态给对措辞（${want2}）`,
    `第 2 步实际文案：${step2.slice(0, 120)}`,
  )
  run.check(
    !step2.includes(wrong2),
    `${where} 第 2 步不出现另一种形态的措辞（${wrong2}）`,
    'isMobile() 判定失效：两边都渲染，或判定反了',
  )
  run.check(
    c.systemTray ? step4.includes('系统托盘') : step4.includes('不会常驻后台'),
    `${where} 第 4 步按托盘能力给对措辞（${c.systemTray ? '有托盘' : '无托盘'}）`,
    `第 4 步实际文案：${step4.slice(0, 140)}`,
  )
  run.check(
    c.systemTray ? !step4.includes('不会常驻后台') : !step4.includes('系统托盘'),
    `${where} 第 4 步不出现另一种托盘措辞`,
    'supports("systemTray") 判定失效：两边都渲染，或判定反了',
  )
  run.check(
    c.autoStart === step4.includes('开机自启'),
    `${where} 第 4 步的自启说明与能力一致（${c.autoStart ? '应有' : '应无'}）`,
    `第 4 步实际文案：${step4.slice(0, 140)}`,
  )
  await shoot('4')

  // ③c 小屏兜底：把视口压到 **375×340**（刻意比任何在售机型都矮）再读**卡片**的位置。
  //
  // 为什么用这么极端的尺寸：真实小屏这一档**当前文案量放得下** —— 实测卡片高 **376px**
  // （375×420 下 `bottom=398 < 420` 照样通过），所以拿真实尺寸去断言等于写一条
  // **永远绿的断言**，本项目明令禁止（变异脚本 O10 第一次就是这么栽的）。
  // 压到 340 之后可用高度只剩 308 ⇒ 内容必定溢出，验的是**兜底机制**：
  // 卡片必须仍被限制在视口内且可滚动。少了 `maxHeight` / `overflowY`，
  // 卡片会比视口还高、底部主按钮被推出屏幕，而遮罩挡着底层、页面又不能滚
  // ⇒ 用户**卡死在引导里**。
  // ⚠️ 别把这一步读成"真实小屏上有问题"：它压的是兜底，不是当前观感。
  if (c.form === '移动端') {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: 375, height: 340, deviceScaleFactor: 2, mobile: true },
      sessionId,
    )
    await sleep(300)
    const fit = await evaluate(cdp, sessionId, `(() => {
         const root = document.querySelector(${SEL_Q});
         const card = root && root.firstElementChild;
         if (!card) return null;
         const r = card.getBoundingClientRect();
         return {
           top: Math.round(r.top),
           bottom: Math.round(r.bottom),
           innerH: window.innerHeight,
           scrollable: card.scrollHeight > card.clientHeight + 4,
         };
       })()`)
    const v = fit.value
    run.check(
      !!(v && v.top >= 0 && v.bottom <= v.innerH + 1),
      `${where} 内容比视口高时卡片仍被限制在视口内（maxHeight 兜底）`,
      `卡片 ${JSON.stringify(v)} —— 卡片比视口还高，底部按钮被推出屏幕`,
    )
    run.check(
      !!(v && v.scrollable),
      `${where} 内容比视口高时卡片内容可滚动（overflowY 兜底）`,
      `卡片 ${JSON.stringify(v)} —— 放不下又滚不动，用户点不到按钮`,
    )
    await cdp.send('Emulation.setDeviceMetricsOverride', { ...c.viewport }, sessionId)
    await sleep(200)
  }

  // ④ 收尾：遮罩消失 + 标志落盘
  const clickedDone = await evaluate(cdp, sessionId, clickByText('开始使用'))
  run.check(clickedDone.ok && clickedDone.value === true, `${where} 点得到「开始使用」`, '按钮不存在')
  try {
    await waitFor(cdp, sessionId, `!document.querySelector(${SEL_Q})`, {
      timeout: 5000,
      label: `${where} 遮罩消失`,
    })
    run.ok(`${where} 走完后遮罩消失`)
  } catch (e) {
    run.fail(`${where} 走完后遮罩消失`, e.message)
  }

  const flagOf = `(() => { try { return localStorage.getItem(${JSON.stringify(key)}) } catch (e) { return null } })()`
  const flag = await evaluate(cdp, sessionId, flagOf)
  run.check(
    flag.ok && flag.value !== null && Number(flag.value) >= 1,
    `${where} 「已看过」标志真的落盘`,
    `localStorage[${key}] = ${JSON.stringify(flag.value)}（没落盘 ⇒ 每次启动都会再讲一遍）`,
  )

  // ⑤ 再次加载：不再自动出现 —— "只讲一次"这件事唯一的证据
  await cdp.send('Page.reload', {}, sessionId)
  await waitFor(cdp, sessionId, `document.readyState === 'complete'`, { label: `${where} 重新加载` })
  try {
    await waitFor(cdp, sessionId, `!!document.querySelector('a[href="#/dashboard"]')`, {
      timeout: WAIT_MS,
      label: `${where} 重新加载后应用壳就绪`,
    })
    await sleep(400) // 壳与引导同一帧判定；这点余量只是免得断言跑在 React 提交之前
    const again = await evaluate(cdp, sessionId, `!!document.querySelector(${SEL_Q})`)
    run.check(
      again.ok && again.value === false,
      `${where} 再次打开时不再出现`,
      '引导又弹了一次（标志没生效？）',
    )
  } catch (e) {
    run.fail(`${where} 再次打开时不再出现`, e.message)
  }

  // ⑥ 回看入口：设置页能把它叫回来，「跳过」能关掉，且不动标志
  await evaluate(cdp, sessionId, `(() => {
       const a = document.querySelector('a[href="#/settings"]'); if (a) a.click(); return true;
     })()`)
  try {
    await waitFor(cdp, sessionId, `document.body.innerText.includes('重新查看新手引导')`, {
      timeout: 8000,
      label: `${where} 设置页出现回看入口`,
    })
    run.ok(`${where} 设置页有「重新查看新手引导」入口`)

    const reopened = await evaluate(cdp, sessionId, clickByText('重新查看新手引导'))
    run.check(reopened.ok && reopened.value === true, `${where} 点得到回看入口`, '按钮不存在')
    await waitFor(cdp, sessionId, `!!document.querySelector(${SEL_Q})`, {
      timeout: 5000,
      label: `${where} 回看时引导再次出现`,
    })
    run.ok(`${where} 回看时引导再次出现`)

    // 回看必须**从第 1 步开始**（上一轮走到过第 4 步；不清内部 step 就会停在那里）
    const back = await evaluate(cdp, sessionId, readStep)
    run.check(
      !!(back.value && /^1\/4$/.test(back.value.progress)),
      `${where} 回看从第 1 步开始（不是停在上次的步骤）`,
      `进度显示「${back.value ? back.value.progress : '(读不到)'}」`,
    )

    const skipped = await evaluate(cdp, sessionId, clickByText('跳过'))
    run.check(skipped.ok && skipped.value === true, `${where} 点得到「跳过」`, '按钮不存在')
    await waitFor(cdp, sessionId, `!document.querySelector(${SEL_Q})`, {
      timeout: 5000,
      label: `${where} 跳过后遮罩消失`,
    })
    run.ok(`${where} 跳过后遮罩消失`)

    const still = await evaluate(cdp, sessionId, flagOf)
    run.check(
      still.ok && still.value !== null && Number(still.value) >= 1,
      `${where} 回看 / 跳过都不会清掉「已看过」标志`,
      `标志变成 ${JSON.stringify(still.value)} —— 回看不该改变"下次启动是否显示"`,
    )
  } catch (e) {
    run.fail(`${where} 回看入口`, e.message)
  }

  // 把 URL 交还给 ROUTES 段：`#/` 那一条**不点导航**（它假定启动就落在活动页），
  // 所以必须先回到 `/`，否则它会拿设置页的内容去对活动页的文案。
  //
  // ⚠️ 这段单独包 try/catch：它失败只该记一条断言失败，**不该让整轮守卫崩掉**。
  //    未捕获的 `waitFor` 超时会冒到 main 的 catch，把结论变成
  //    `::error::UI 冒烟执行失败`（一条 `✗` 都没有）—— 那是"假红"，
  //    与"假绿"一样有害：变异脚本会把这种轮次误读成"变异没被抓住"（实测踩到）。
  try {
    await evaluate(cdp, sessionId, `(() => {
         const a = document.querySelector('a[href="#/"]'); if (a) a.click(); return true;
       })()`)
    await waitFor(cdp, sessionId, `location.hash === '#/' || location.hash === ''`, {
      timeout: 6000,
      label: `${where} 回到活动页`,
    })
  } catch (e) {
    run.fail(`${where} 回到活动页`, e.message)
  }
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

  /**
   * 钉住新手引导的**持久化契约**：标志所在的那个 `localStorage` 键。
   *
   * 🔴 换了键名 ⇒ 所有老用户的"已看过"当场作废、每个人再被引导一次。
   * 可以接受，但不能**悄悄**发生 —— 所以这里把期望值钉死，改了就红。
   */
  run.check(
    ONBOARDING_KEY === EXPECTED_ONBOARDING_KEY,
    `新手引导的持久化键仍是 ${EXPECTED_ONBOARDING_KEY}`,
    `源码里读到的是 ${JSON.stringify(ONBOARDING_KEY)} —— 换键会让老用户的「已看过」作废；` +
      `若确属有意，同步改本脚本的 EXPECTED_ONBOARDING_KEY 并接受"老用户再看一次引导"`,
  )

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

      // 🔴 清掉「新手引导已看过」标志并**重新加载**，让本用例回到"第一次打开应用"
      //    那个状态。同一个浏览器 profile 下 `localStorage` 是**跨用例共享**的：
      //    上一个平台用例走完引导就把标志写成了 1，不清掉的话从第二个用例起
      //    引导根本不会出现 —— 而"没出现"会被后面那句 `run.ok` 读成通过（假绿）。
      await evaluate(
        cdp,
        sessionId,
        `(() => { try { localStorage.removeItem(${JSON.stringify(ONBOARDING_KEY)}) } catch (e) {} return true })()`,
      )
      await cdp.send('Page.reload', {}, sessionId)
      await waitFor(cdp, sessionId, `document.readyState === 'complete'`, {
        label: `${c.name} 清标志后重新加载`,
      })

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
      // ── 新手引导 ─────────────────────────────────────────────────────────
      // 必须跑在 ROUTES **之前**（引导段自己会把它关掉）：引导的遮罩盖在页面上，
      // 但下层仍挂在 DOM 里，`innerText` 两层都读得到 —— 开着遮罩去断言页面文案，
      // 等于把"被盖住了"验成"渲染得出来"。
      //
      // ⚠️ 整段包 try/catch：段落内部任何未捕获异常（多为 Chrome 抖动导致的
      //    `waitFor` 超时）都只记一条失败，**不让整轮守卫变成"执行失败"**。
      try {
        await checkOnboarding(cdp, sessionId, run, c, ONBOARDING_KEY)
      } catch (e) {
        run.fail(`${c.name} 新手引导`, `段落异常：${e.message}`)
      }
      // 引导段内部 reload 过一次（验"再次打开不再出现"），哨兵随之消失 → 重挂。
      // ROUTES 靠它证明"点导航没有整页刷新"，少了这一步会全线误报。
      await evaluate(cdp, sessionId, `window.__ngSmokeSentinel = 'alive'; true`)

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

      // ── 活动收尾屏：「本次动作成绩」+ 逐动作得分 ────────────────────────────
      //
      // ROUTES 只证明"页面上得来"，覆盖不到**一次活动走完之后那一屏** ——
      // 而那一屏是 S10「逐动作评分」唯一的用户可见出口（分数、逐动作明细、
      // "无数据不显示 0"这三件事全在那里）。所以在这里补一段真实交互：
      // 开始活动 → 结束活动 → 检查收尾屏。
      //
      // 🔴 无头环境没有摄像头 ⇒ 一帧都没采到 ⇒ 这里恰好是**零明细**那条边界：
      //    必须显示 `--`（不是 0 —— 0 分是可达的，代表"全程没动"），
      //    且 7 个动作**逐个列出**并如实标「未判定」，一个都不能漏、一个都不能编。
      // ⚠️ 不覆盖：有真实帧时的分数（那要摄像头，属真机层，见 device-matrix.md）。
      try {
        const where = `${c.name} 活动收尾屏`
        await evaluate(cdp, sessionId, `(() => {
             const a = document.querySelector('a[href="#/"]'); if (a) a.click(); return true;
           })()`)
        await waitFor(cdp, sessionId, `location.hash === '#/' || location.hash === ''`, {
          timeout: 4000,
          label: `${where} 回到肩颈活动页`,
        })

        const clickedStart = await evaluate(cdp, sessionId, `(() => {
             const b = [...document.querySelectorAll('button')]
               .find(x => x.textContent.replace(/\\s/g, '').includes('开始活动'));
             if (!b) return false;
             b.click();
             return true;
           })()`)
        run.check(clickedStart.ok && clickedStart.value === true, `${where} 点得到「开始活动」`, '按钮不存在')

        // 进活动态后「结束活动」才会出现 —— 它出现在动作面板底部
        await waitFor(cdp, sessionId, `(() => {
             const b = [...document.querySelectorAll('button')]
               .find(x => x.textContent.replace(/\\s/g, '') === '结束活动');
             return !!b;
           })()`, { timeout: 5000, label: `${where} 出现「结束活动」` })

        // 装一个**落库探针**：桌面（electron，有本机后端）走 HTTP，
        // 网页 / 安卓 / iOS 没有后端、走 IndexedDB —— **两条路都要能捕获**。
        // 少了这条，"分数算得对"与"分数真的写下去了"之间那段路就没人验：
        // 写进去的是不是**规范文本**、`avg_score` 与明细是不是**同源**，全在那一段上。
        await evaluate(cdp, sessionId, `(() => {
             window.__ngRec = null;
             if (!window.__ngOrigFetch) {
               window.__ngOrigFetch = window.fetch;
               window.fetch = function (input, init) {
                 try {
                   const url = typeof input === 'string' ? input : (input && input.url) || '';
                   if (url.indexOf('/api/activity/record') >= 0) {
                     window.__ngRec = { via: 'http', body: String((init && init.body) || '') };
                   }
                 } catch (e) { /* 探针不许影响被测代码 */ }
                 return window.__ngOrigFetch.apply(this, arguments);
               };
             }
             return true;
           })()`)

        const clickedEnd = await evaluate(cdp, sessionId, `(() => {
             const b = [...document.querySelectorAll('button')]
               .find(x => x.textContent.replace(/\\s/g, '') === '结束活动');
             if (!b) return false;
             b.click();
             return true;
           })()`)
        run.check(clickedEnd.ok && clickedEnd.value === true, `${where} 点得到「结束活动」`, '按钮不存在')

        const done = await waitFor(cdp, sessionId, `(() => {
             const ps = [...document.querySelectorAll('p')];
             const lbl = ps.find(p => p.textContent.trim() === '本次动作成绩');
             if (!lbl) return null;
             const val = lbl.previousElementSibling ? lbl.previousElementSibling.textContent.trim() : '';
             const t = document.body.innerText;
             return {
               score: val,
               hasRows: t.includes('逐动作得分'),
               undecided: (t.match(/未判定/g) || []).length,
               oldLabel: t.includes('平均达成度'),
             };
           })()`, { timeout: 5000, label: `${where} 渲染出「本次动作成绩」` })

        run.check(done.hasRows, `${where} 列出「逐动作得分」`, '逐动作明细没渲染')
        // 零明细 → `--`。显示 0 会被读成"得了 0 分"，而 0 分是可达的（全程没动）。
        run.check(done.score === '--', `${where} 无明细时成绩显示 --（不是 0）`, `实际显示「${done.score}」`)
        // 7 个动作逐个列出（3 个可判定但零采样 + 4 个指标测不到），如实标「未判定」。
        run.check(
          done.undecided === 7,
          `${where} 7 个动作全部如实标「未判定」`,
          `实际出现 ${done.undecided} 次（漏动作 或 编造了分数）`,
        )
        // 旧口径（逐帧达成度的平均）已经换掉；留着它就是"文案与数字"两套口径并存。
        run.check(!done.oldLabel, `${where} 不再出现旧口径「平均达成度」`, '旧标签仍在渲染')

        // 读落库结果：HTTP 探针优先，其次 IndexedDB（落库是异步的，给它最多 3 秒）
        const rec = await evaluate(cdp, sessionId, `(async () => {
             if (window.__ngRec) return window.__ngRec;
             const readLatest = () => new Promise((resolve) => {
               let req;
               try { req = indexedDB.open('neckguardian'); } catch (e) { resolve(null); return; }
               req.onerror = () => resolve(null);
               req.onsuccess = () => {
                 const db = req.result;
                 if (!db.objectStoreNames.contains('activity_log')) { db.close(); resolve(null); return; }
                 const all = db.transaction('activity_log', 'readonly').objectStore('activity_log').getAll();
                 all.onerror = () => { db.close(); resolve(null); };
                 all.onsuccess = () => {
                   const rows = all.result || [];
                   db.close();
                   const last = rows[rows.length - 1];
                   resolve(last ? { via: 'idb', body: JSON.stringify(last) } : null);
                 };
               };
             });
             for (let i = 0; i < 30; i++) {
               const r = await readLatest();
               if (r) return r;
               await new Promise((s) => setTimeout(s, 100));
             }
             return null;
           })()`)

        const gotRecord = rec.ok && rec.value
        run.check(
          !!gotRecord,
          `${where} 收尾结果真的落库（HTTP / IndexedDB 两条路都查）`,
          `两种路径都没捕获到：${rec.error || '本次活动没写进任何存储'}`,
        )
        if (gotRecord) {
          let row = null
          try {
            row = JSON.parse(rec.value.body)
          } catch (e) {
            run.fail(`${where} 落库记录可解析`, `payload 不是 JSON：${String(rec.value.body).slice(0, 80)}`)
          }
          if (row) {
            // 🔴 写进去的必须是**规范文本**（紧凑无空格、键序固定）——
            // 它与 `serializeActionScores()` 的输出逐字节相同，导出/导入才能跨端互换。
            // 零明细的规范文本恰好是 `{"v":1,"items":[]}`：
            // **不是** `{"v":1,"items":[]}` 之外的任何形态（多一个空格就红）。
            run.check(
              row.action_scores === '{"v":1,"items":[]}',
              `${where} 落库的 action_scores 是规范文本（零明细）`,
              `实际：${JSON.stringify(row.action_scores)}`,
            )
            // 总分与明细**同源**：零明细 ⇒ 0（"没有成绩"）。若哪天有人把总分改回
            // 「逐帧达成度平均」，这里立刻对不上 —— 那正是本次要修的口径。
            run.check(
              row.avg_score === 0,
              `${where} 落库的 avg_score 与明细同源（零明细 ⇒ 0）`,
              `实际：${JSON.stringify(row.avg_score)}`,
            )
          }
          console.log(`    · 落库通道 ${rec.value.via}`)

          // 只有走 IndexedDB 的用例才把记录留在了**同一个源**上（桌面/electron 发 HTTP，
          // 冒烟里没有后端 → 没落地），所以历史列表这一段只在 idb 通道上验。
          // 它证的是「写 → 读 → 解析明细 → 渲染」整条链：少一段就会出现
          // "详情页说没有成绩、历史里却显示 0 分"这种自相矛盾。
          if (rec.value.via === 'idb') {
            // 再插一条**迁移前的老记录**（没有 `action_scores` 键 —— 对应 SQLite 的 NULL）。
            // 这是本次改动唯一会影响到**存量数据**的地方：老记录的 `avg_score` 是旧算法的
            // 产物，与现在的成绩不可比。S10 的验收标准要求「旧数据的显示不崩、能区分或明确标注」，
            // 而"不崩"和"标注"都只能在这里证 —— 光有代码分支不算数。
            await evaluate(cdp, sessionId, `(async () => {
                 const db = await new Promise((res, rej) => {
                   const r = indexedDB.open('neckguardian');
                   r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
                 });
                 await new Promise((res, rej) => {
                   const tx = db.transaction('activity_log', 'readwrite');
                   tx.objectStore('activity_log').put({
                     timestamp: new Date(Date.now() - 3600e3).toISOString(),
                     activity_type: 'exercise', exercise_count: 7, duration_sec: 82, avg_score: 63,
                   });
                   tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
                 });
                 db.close();
                 return true;
               })()`)

            await evaluate(cdp, sessionId, `(() => {
                 const a = document.querySelector('a[href="#/dashboard"]'); if (a) a.click(); return true;
               })()`)
            await waitFor(cdp, sessionId, `document.body.innerText.includes('肩颈放松活动')`, {
              timeout: 6000,
              label: `${where} 历史列表里出现刚记下的活动`,
            })
            const hist = await evaluate(cdp, sessionId, `(() => {
                 const badges = [...document.querySelectorAll('div[title]')]
                   .filter(d => /本次动作成绩|旧记录|没有可判定的动作/.test(d.getAttribute('title') || ''));
                 return {
                   n: badges.length,
                   texts: badges.map(d => d.textContent.trim()),
                   legacyTagged: document.body.innerText.includes('旧口径'),
                 };
               })()`)
            const texts = (hist.ok && hist.value && hist.value.texts) || []
            run.check(
              texts.length > 0,
              `${where} 历史行带上了可解释的 title（新记录/旧记录/无判定三态之一）`,
              '一行都没匹配到 —— ActivityRow 的分支没生效',
            )
            // 零明细的那条记录在历史里**必须**是 `--`：写 0 会被读成"得了 0 分"。
            run.check(
              texts.includes('--') && !texts.includes('0分'),
              `${where} 历史里零明细记录显示 --（不是 0分）`,
              `实际：${JSON.stringify(texts)}`,
            )
            // 老记录（无明细）必须**照常显示分数**并**标出"旧口径"** ——
            // 不显示 = 把用户的历史数据藏起来；不标注 = 让新旧两个不可比的数看起来可比。
            run.check(
              texts.includes('63分'),
              `${where} 老记录（无明细）照常显示分数`,
              `实际：${JSON.stringify(texts)}`,
            )
            run.check(hist.ok && hist.value && hist.value.legacyTagged === true, `${where} 老记录被标出「旧口径」`, '没有可区分的标注')
          }
        }
      } catch (e) {
        run.fail(`${c.name} 活动收尾屏`, e.message)
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
  console.log(
    `✅ UI 冒烟通过：${cases.length} 个平台组合 × ${ROUTES.length} 个路由` +
      ` + 新手引导 ${cases.length} 次 + 活动收尾屏/历史行 ${cases.length} 次，${run.passed} 项断言`,
  )
  if (EVIDENCE_DIR) console.log(`   截图已存：${path.relative(ROOT, EVIDENCE_DIR)}`)
}

main()
