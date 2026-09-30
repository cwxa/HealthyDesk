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
 *     并在仪表盘历史里回读 —— 零明细显示 `--`、**迁移前的老记录照常显示分数且被标出「旧口径」**、
 *     **v1 明细（形态合法但分数是旧口径）也照常显示并标出「旧口径」**（v1.7.0 新增的第四态，
 *     与 NULL 那条走的是不同分支，各插一条分别验）。
 *     这是 S10「逐动作评分」唯一的用户可见出口，ROUTES 那种"页面渲染得出来"的断言覆盖不到它。
 *   - **新手引导**（首次打开时盖在界面上那层）：清掉标志重新加载 → 引导出现 →
 *     逐步点完 4 步（**每步标题都要变**；只验"遮罩出现了"会漏掉"卡在第 1 步不动"）→
 *     点「开始使用」→ 遮罩消失 + 「已看过」标志真的落盘 → **再次加载后不再自动出现** →
 *     设置页「重新查看新手引导」能把它叫回来 → 「跳过」能关掉。
 *     ⚠️ 这一段必须在 ROUTES **之前**跑完：引导的遮罩盖在页面上，但下层仍在 DOM 里，
 *     开着它去断言页面文案等于把"被盖住了"验成"渲染得出来"（`innerText` 两层都读得到）。
 *   - **假摄像头 · 实时引导 / 实时徽章**（移动端用例，`checkCameraGuidance`）：
 *     CDP 在 **document-start** 注入一条 `canvas.captureStream()` 假摄像头，
 *     然后把 `scenarios.json:ui_smoke.frames` 逐帧喂进去。**喂帧按墙上时间定长**
 *     （`ui_smoke.feed_ms` = 10 秒，起势 1 帧 + 拉伸帧），不是"把帧表喂完为止" ——
 *     无头页里推理同步占主线程，推帧会被拖到 2.0–5.0 帧/秒，按帧数定长会让"喂多久"
 *     取决于机器多忙（实测跨过动作计时器的 12 秒边界，后半段帧被记到下一个动作上）。
 *     于是「`getUserMedia` → 本地引擎（MediaPipe wasm）→ 帧序列 → `judgeExercise` →
 *     **实时引导浮层** + **实时动作达成度徽章**」这条链第一次有了自动化证据。
 *     断言只取**不变量**与**存在性**，不钉时间轴（见下）：
 *       ⓪ 环境够不够 —— 🔴 **两个下界各答一问，不合并**（v1.7.1 起）：
 *          `ui_smoke.rate_floor`（1.5）= **离线重放**里算法还判得出的最低档（模型问题）；
 *          `ui_smoke.rate_floor_browser`（2.0）= **浏览器**里读数还可信的门（环境问题）。
 *          两者**实测会分叉**：同一份帧表在浏览器里 2.7–4.5 帧/秒判成 completed、
 *          1.5–1.6 帧/秒判成 `insufficient score=76`，而离线扫描说 1.5 那一档仍是 completed。
 *          语义：**低帧率只决定「这一轮该不该采信」，不单独当失败理由** ——
 *          帧率 ≥ 2.0 或（≥1.5 且结论与 fixture 一致）⇒ 采信；否则重试一次，
 *          两轮都不采信才报「环境不足」（判据只有一处实现：`trustCameraRound()`）；
 *       ① 姿态读数真的来自注入的帧（头部侧倾出现过 ≥ 5°，即超过静息阈值），
 *          且 `<video>` 的 `currentTime` 在前进（帧真的交给了视频元素）；
 *       ② 喂帧窗口内**浮层真的渲染出来了** —— `liveQuality` 不再恒为 `null`；
 *       ③ 出现过「幅度够了」那一类的提示（不是恒 idle / 恒幅度不够）；
 *       ④ 🔴 **徽章与提示不矛盾**：`hint === idle ⟺ 徽章 = 0`；
 *          否则 `徽章 ≥ 80 ⟺ hint = 「很好，保持住」`。这条盯的是 v1.7.0 修的
 *          「徽章取运动态通道、提示取活动范围 ⇒ 同屏互相打脸」（铁律 #62/#63）——
 *          把 `activityScore` 改回 `score` 会被这条当场抓住（见变异自证）。
 *       ⑤ 收尾屏：**真实帧**下只有第一个动作被判定（「未判定」= 6，明细项 id 也是它），
 *          且落库明细 `v=3` / 只有 1 项 / `avg_score` 与明细**同源** / 判成 `completed`。
 *   - `?platform=` / `?os=` 覆盖是否真的改变界面（平台专属文案的**出现与消失**）
 *   - 客户端路由（点导航后 URL 变化但**不整页刷新**、目标页渲染出来）
 *   - 设置页显示的版本号 = `package.json` 的版本（版本漂移在界面层也能抓到）
 *   - 未捕获异常、非预期的控制台错误、非预期资源加载失败
 *   - 可选：截图留证（`--evidence=<目录>`）—— 每页一张，另加**新手引导的第 1 / 第 4 步**各一张
 *     （引导是视觉产品，"排版塌了/按钮被遮"这类问题断言看不出来）
 * 不覆盖（如实记录，别读成"验过了"）：
 *   - **真实摄像头设备与权限层**：注入的是一条 **`MediaStream`**，不是真设备
 *     （没走 `--use-fake-device-for-media-stream`，也没碰 `getUserMedia` 的权限分支）。
 *     所以「申请授权 / 设备不存在 / 被拒绝 / 切前后台重新取流」这些仍然只能真机验。
 *     这里验的是 **app 侧**：attachVideo → 本地引擎 → 帧 → 判定 → 界面。
 *   - **时间轴的绝对值**：实时引导看的是**最近 5 秒**的滚动窗口，而帧的时间戳是
 *     `Date.now()`。所以"第几秒该出现哪句文案"依赖真实帧率 —— 断言只取不变量与
 *     存在性。「喂帧窗口有多长」是固定的（`ui_smoke.feed_ms`），但**窗口里有多少帧**
 *     取决于机器 —— 只由 `trustCameraRound()` 那套判据兜住（先看帧率够不够，再交叉看
 *     "结论对不对得上"），兜不住的是"哪一帧在什么时候"。
 *     ⚠️ 另有一个**已知现象**（不是缺陷、也未被断死）：起势帧滚出 5 秒窗口后
 *     「活动范围」归零 ⇒ 静止保持会被实时提示成「没检测到动作」。
 *     整段判定不受影响（它看的是整段帧），见 `scripts/fake-camera/README.md`。
 *   - **低帧率下"过了"的那些轮**（`rate_floor` ≤ 帧率 < `rate_floor_browser`）：结论仍被采信
 *     （它确实与 fixture 一致），但**那一段环境本身没达标** —— 实测 1.6 帧/秒就判不出
 *     `completed`。所以这种轮会打一条**显式 ⚠**，并**不会**让 run 变红（v1.7.1 定的策略：
 *     低帧率不单独当失败理由，理由见 `docs/MULTIPLATFORM.md §9.9`）。
 *     读线报时要知道：这一轮的"浮层/徽章"类不变量是在**偏挤的环境**下验的。
 *   - **喂帧窗口末尾之后**：帧不再进来时 `liveQuality` 回落到 `null`、浮层消失是
 *     **正确**行为（滚动窗口会把内容滚空）。所以浮层那条断言只覆盖窗口**内部**的采样点 ——
 *     把它算进来会把"它该做的事"读成失败（v1 就是这么假红的）。
 *   - **桌面端（web / electron）的实时引导**：浮层与 `liveQuality` 是移动端专属，
 *     桌面走 WS 发帧给 Python 后端，无头环境里没有后端 —— 那段仍属真机层。
 *   - **收尾分数的"对错"**：这里只证明"浏览器路径判出来的成绩与 fixture 的期望一致"；
 *     数值口径的逐位正确性由 `verify:exercise-quality` 与 `verify:fake-camera` 负责。
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
 *   node scripts/verify-ui-smoke.mjs --self-test           # 只跑「本轮采信/不采信」判据的自测
 *
 * `--self-test`：`trustCameraRound()` 是纯函数，跑之前**无条件**先自测它（见 `main()`）——
 * 判"环境够不够"的规则本身错了，症状是"该红的没红"或"已经正确的读数被判成环境问题"，
 * 两种都不会让守卫自己叫出来。
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
/** `--self-test`：只跑「本轮该不该采信」判据的自测，不起浏览器。 */
const SELF_TEST_ONLY = !!args['self-test']

/**
 * 帧率/门的显示口径：一律一位小数。
 * `scenarios.json` 里 `rate_floor_browser` 是 `2.0`，但 JSON 解析成 JS `Number` 之后
 * 模板串渲染出来是 `2` —— 紧挨着 `离线模型下界 1.5` 读起来像两个不同量纲的数
 * （实测第一版线报就是 `环境门 2` vs `下界 1.5`）。显示统一，免得读的人再算一遍。
 */
const f1 = (v) => Number(v).toFixed(1)

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

/**
 * 静态服务**兜底根**。
 *
 * 有两类资源**故意不在 dist 里**，但它们又必须能在浏览器里取到：
 *   - `/ng-frames/*`：假摄像头素材（真人照片补齐后的 6 张 640×480 JPEG）。
 *     它们从不进 dist —— 素材只该有一个位置（`scripts/fake-camera/frames/`），
 *     多一份拷贝就多一处会悄悄分叉的东西。
 *   - `/mediapipe/**`：姿态推理的 wasm 与模型。这两样**只有 `cap-build` 才补进
 *     `dist/mediapipe/`**（见 `scripts/cap-build.js`）—— plain `vite build` 的 dist 没有它们，
 *     所以此前无头环境里那两个请求必然 404、被 `BENIGN_URL` 归成"预期内失败"。
 *
 * 🔴 **不改 dist**：`verify:source` 要拿"包内前端 vs 本次 dist"逐文件对 sha256，
 *    冒烟如果往 dist 里塞东西，那条守卫就会对着一个被人动过的目录跑。
 *    所以这里只在**静态服务**这一层按前缀映射到仓库里的真实位置。
 *    顺带的好处：这同时证明了 `localPoseEngine.ts` 里那两条相对路径
 *    （`mediapipe/wasm` / `mediapipe/models/pose_landmarker_full.task`，
 *    相对 `document.baseURI`）**指对了地方** —— 以前 404 被归成"预期内"，指错了也看不出来。
 */
const FRAMES_DIR = path.join(ROOT, 'scripts', 'fake-camera', 'frames')
const MEDIAPIPE_WASM_SRC = path.join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const MEDIAPIPE_MODEL_SRC = path.join(ROOT, 'mediapipe-assets', 'models', 'pose_landmarker_full.task')
const FALLBACK_ROOTS = [
  { prefix: '/ng-frames/', root: FRAMES_DIR },
  { prefix: '/mediapipe/wasm/', root: MEDIAPIPE_WASM_SRC },
  { prefix: '/mediapipe/models/', root: path.dirname(MEDIAPIPE_MODEL_SRC) },
]

/**
 * 假摄像头那一段要用到的资源清单（**跑之前先点名核对**）。
 *
 * 🔴 缺任何一个都**直接 exit 1**，不许"缺了就跳过那一段" —— 跳过会让这个守卫
 * 永远是绿的，而它恰恰是唯一能证明"有帧时实时引导真的出来了"的东西。
 * 两处的来源都可靠：wasm 来自 `npm ci` 装的依赖，模型是**入库**的
 * （`mediapipe-assets/`，就是为了"离线也能构建"）。
 */
const CAMERA_ASSETS = [
  [path.join(MEDIAPIPE_WASM_SRC, 'vision_wasm_internal.js'), 'MediaPipe wasm（SIMD loader）'],
  [path.join(MEDIAPIPE_WASM_SRC, 'vision_wasm_internal.wasm'), 'MediaPipe wasm（SIMD 二进制）'],
  [MEDIAPIPE_MODEL_SRC, '姿态模型 pose_landmarker_full.task'],
  [path.join(ROOT, 'scripts', 'fake-camera', 'scenarios.json'), '假摄像头 fixture'],
]

/** `scenarios.json:ui_smoke` —— 逐帧喂给浏览器的那份帧表（单一真相来源）。 */
function loadUiSmoke() {
  const file = path.join(ROOT, 'scripts', 'fake-camera', 'scenarios.json')
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  const ui = doc.ui_smoke
  const need = ['frames', 'feed_ms', 'frame_count', 'lead_in_frames', 'rate_floor', 'rate_floor_browser', 'rate_sweep', 'action_duration_ms']
  if (!ui) throw new Error('scenarios.json 里没有 ui_smoke 段（跑一次 build-frames.py 重新生成）')
  const missing = need.filter((k) => ui[k] === undefined || ui[k] === null)
  if (missing.length) {
    throw new Error(`ui_smoke 段缺字段 ${missing.join(' / ')} —— 跑一次 ` +
      'scripts/fake-camera/build-frames.py（改了喂帧表就用 --rewrite）')
  }
  if (!Array.isArray(ui.frames) || ui.frames.length === 0) {
    throw new Error('scenarios.json 里没有可用的 ui_smoke.frames（跑一次 build-frames.py 重新生成）')
  }
  if (ui.frames.length !== ui.frame_count) {
    throw new Error(`ui_smoke.frames 有 ${ui.frames.length} 项，但声明 frame_count=${ui.frame_count}`)
  }

  // 🔴 **两个下界各答一问，别把它们合并**（v1.7.1 定的；原来只有一个 `rate_floor`，
  //    结果是"守卫绿着，而浏览器里那个帧率其实已经判不出来了"）：
  //      · `rate_floor`         = **离线重放**里算法还判得出的最低档 —— 模型问题
  //      · `rate_floor_browser` = **浏览器**里读数还可信的门 —— 环境问题
  //    实测分叉：同一份帧表在浏览器里 2.7–4.5 帧/秒判成 completed、
  //    1.5–1.6 帧/秒判成 `insufficient score=76`（CI `36660895335`，rerun 两次都复现），
  //    而离线扫描说 1.5 那一档仍是 completed（它只重打时间戳，建模不出
  //    `static_image_mode=False` 的逐帧跟踪在长间隔下要重新收敛）。
  //    下面两条自检分别盯"fixture 自己内部一致"与"两个门的关系没被改坏"。
  const rates = Object.keys(ui.rate_sweep)
  if (!rates.length) throw new Error('ui_smoke.rate_sweep 是空的 —— 帧率扫描没跑')
  // ⚠️ 键是 Python 写出来的字符串（"1.5" / "2.0" / "5.0"）：**不要**转成数字再拿回来查，
  //    `String(2)` 是 "2"，跟 "2.0" 不是同一个键（这里第一版就踩了这个）。
  const floor = Math.min(...rates.map(Number))
  if (ui.rate_floor !== floor) {
    throw new Error(`ui_smoke.rate_floor=${ui.rate_floor} 与 rate_sweep 的最低档 ${floor} 不一致`)
  }
  const top = Math.max(...rates.map(Number))
  if (!(ui.rate_floor_browser > ui.rate_floor && ui.rate_floor_browser <= top)) {
    throw new Error(
      `ui_smoke.rate_floor_browser=${f1(ui.rate_floor_browser)} 必须落在 (${ui.rate_floor}, ${top}] 之间：` +
        `浏览器只会比离线模型更苛刻（≤ ${ui.rate_floor} 就没有意义），` +
        `而超过扫描最高档 ${top} 则每轮都会判成「环境不足」⇒ 这段守卫被静默关掉`,
    )
  }
  const notOk = rates.filter((r) => ui.rate_sweep[r].grade !== 'completed')
  if (notOk.length) {
    throw new Error(`ui_smoke.rate_sweep 在 ${notOk.join(' / ')} 帧/秒下判不成 completed —— ` +
      'fixture 自己就没过，别指望浏览器里能过')
  }

  // 喂帧窗口必须短于**第一个动作的标称时长**：动作计时器走到那儿会自动切下一个动作，
  // 之后推的帧会被记到新动作上（症状是收尾屏多出一个「判过的动作」）。时长从
  // `exercises.ts` 读出来存进 fixture，不在两边各写一个 12000。
  const budget = ui.feed_ms + ui.click_slack_ms
  if (budget > ui.action_duration_ms - 500) {
    throw new Error(`feed_ms=${ui.feed_ms} + click_slack=${ui.click_slack_ms} = ${budget}ms` +
      ` 太贴近动作时长 ${ui.action_duration_ms}ms —— 帧会溢出到下一个动作`)
  }
  return ui
}

/**
 * document-start 注入的假摄像头。
 *
 * `canvas.captureStream(0)` + `track.requestFrame()`：帧完全由我们按 `setInterval`
 * 推、`<video>` 侧由浏览器自己解码（素材就是普通的 `<img>`）—— 所以**载荷几 KB、
 * 不需要任何额外 Chrome 开关**（尤其不需要 `--use-fake-device-for-media-stream`），
 * 可以和现有冒烟共用同一个 Chrome 实例。
 *
 * 🔴 这段脚本在 **document-start** 跑（`Page.addScriptToEvaluateOnNewDocument`），
 *    那时 `document.documentElement` **还是 `null`** —— 直接 `appendChild` 会抛、
 *    整个注入静默失效（症状是 `window.__ngFakeCam === undefined`，而界面照常渲染，
 *    看着像"注入根本没执行"）。所以整段包 try/catch，并把错误留在
 *    `window.__ngFakeCamErr` 里供断言读取，而不是让它烂在控制台里。
 *
 * 🔴 注入之后**默认不推帧**：`captureStream(0)` 不主动请求就不出新帧 ⇒
 *    `<video>` 只有画布初始的那一帧 ⇒ app 的本地引擎会去 `detect()`，
 *    但 `video.currentTime` 不变（引擎内部按它去重）⇒ 永远不出姿态 ⇒
 *    **一条帧都进不了判定链**。这正是我们要的：整个用例的前半段（路由、新手引导、
 *    零采样收尾屏）必须与"没有摄像头"时**完全一样**，只有
 *    `checkCameraGuidance` 里显式 `start()` 的那一段才有帧。
 *
 * 🔴 `start(ms)` 是**按墙上时间定长**的（不是一个帧数）：到点自己停。
 *    为什么不能用"帧表喂完即止"：无头页里每帧推理同步占主线程 ~0.45 秒，
 *    推帧的 `setInterval` 会被拖到 2.0–5.0 帧/秒（实测）。按帧数定长的话，
 *    「53 帧 × 200ms」在忙的时候会变成 22.5 秒 —— 越过动作计时器的 12 秒边界，
 *    后半段帧被记到下一个动作上。按时间定长之后，帧率**只影响帧数、不影响时长**，
 *    而"保持比例"这个被验的量只依赖时长（`judgeSession` 的 held_ms 是时间差之和）。
 */
function fakeCameraScript(frameFiles) {
  return `
(() => {
  try {
    const FRAMES = ${JSON.stringify(frameFiles)};
    const W = 640, H = 480;
    const imgs = [];
    let loaded = 0;
    for (const f of FRAMES) {
      const im = new Image();
      im.src = '/ng-frames/' + f;
      im.onload = () => { loaded++ };
      imgs.push({ name: f, im });
    }
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    canvas.style.cssText = 'position:fixed;left:-9999px;top:0;width:640px;height:480px';
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    const stream = canvas.captureStream(0);
    const track = stream.getVideoTracks()[0];
    window.__ngFakeCam = {
      frames: FRAMES, queue: FRAMES.slice(), idx: 0, timer: 0, pushed: 0,
      started: false, startedAt: 0, deadline: 0, stoppedAt: 0,
      ready: () => loaded === FRAMES.length,
      setQueue(names) { this.queue = names.slice(); this.idx = 0; return this.queue.length },
      /** 喂帧 \`ms\` 毫秒（0 = 一直喂到显式 stop()）。到点自己停，免得"喂多久"取决于机器多忙。 */
      start(ms) {
        if (this.started) return this.started;
        this.started = true;
        this.startedAt = Date.now();
        this.deadline = ms ? this.startedAt + ms : 0;
        this.timer = setInterval(() => {
          if (this.deadline && Date.now() >= this.deadline) { this.stop(); return; }
          const n = this.queue[this.idx] ?? this.queue[0];
          const e = imgs.find((x) => x.name === n) || imgs[0];
          ctx.drawImage(e.im, 0, 0, W, H);
          track.requestFrame();
          this.pushed++;
          this.idx = (this.idx + 1) % this.queue.length;
        }, ${UI_FEED_INTERVAL_MS});
        return true;
      },
      stop() {
        clearInterval(this.timer); this.timer = 0; this.started = false;
        if (!this.stoppedAt) this.stoppedAt = Date.now();
      },
    };
    try { document.documentElement.appendChild(canvas) } catch (e) {
      document.addEventListener('DOMContentLoaded', () => document.body.appendChild(canvas));
    }
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => (c && c.video) ? stream : orig(c);
  } catch (e) {
    window.__ngFakeCamErr = String(e && (e.stack || e.message || e));
  }
})();
`
}

/** 喂帧间隔。必须等于 fixture 里的 `frame_interval_ms` —— 见下面那条断言。 */
const UI_FEED_INTERVAL_MS = 200

/** 实时引导的 5 条文案（`exerciseQuality.ts` 的 HINT_* 常量；从源码读，不在这里复刻）。 */
function readHintTexts() {
  const src = fs.readFileSync(path.join(ROOT, 'src/platform/exerciseQuality.ts'), 'utf8')
  const found = [...src.matchAll(/export const HINT_[A-Z]+ = '([^']+)'/g)].map((m) => m[1])
  if (found.length !== 5) throw new Error(`从 exerciseQuality.ts 读到 ${found.length} 条 HINT_ 文案，期望 5 条`)
  return found
}
const HINT_TEXTS = readHintTexts()
const HINT_COMPLETED = HINT_TEXTS.find((h) => h.startsWith('很好'))
const HINT_IDLE = HINT_TEXTS.find((h) => h.startsWith('没检测到动作'))
const HINT_HOLD = HINT_TEXTS.find((h) => h.startsWith('保持住'))

function startStaticServer(dir, fallbackRoots = []) {
  /** 按「dist 优先、兜底根其次」列出候选文件（每个都做穿越防护）。 */
  const candidatesFor = (rel) => {
    const out = [path.join(dir, rel)]
    for (const f of fallbackRoots) {
      if (rel.startsWith(f.prefix)) out.push(path.join(f.root, rel.slice(f.prefix.length)))
    }
    return out.filter((p) => {
      const rp = path.resolve(p)
      if (rp.startsWith(path.resolve(dir))) return true
      return fallbackRoots.some((f) => rp.startsWith(path.resolve(f.root)))
    })
  }

  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent((req.url || '/').split('?')[0])
    if (rel.endsWith('/')) rel += 'index.html'
    const file = candidatesFor(rel).find((p) => {
      try {
        return fs.statSync(p).isFile()
      } catch {
        return false
      }
    })
    if (!file) {
      // SPA 回退：非资源请求一律给 index.html（HashRouter 下正常不会走到，
      // 但 `--headless` 偶尔会请求 /favicon.ico 之类，给个 404 更诚实）
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    fs.readFile(file, (err, buf) => {
      if (err) {
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

/**
 * 影子收集器：接口与 `Runner` 一致，但**不打印、不计数**，只把每次断言的参数存下来。
 * 用途见 `checkCameraGuidanceWithRetry()` —— 环境太差时整段重跑，
 * 那一轮的结果必须能整体丢弃（或整体回放），不能直接污染最终线报。
 */
class ShadowRunner {
  constructor() {
    this.checks = []
  }
  ok(label) {
    this.checks.push([true, label, undefined])
  }
  fail(label, detail) {
    this.checks.push([false, label, detail])
  }
  check(cond, label, detail) {
    this.checks.push([!!cond, label, detail])
    return !!cond
  }
}

// ──────────────── 「这一轮该不该采信」的判据（唯一实现 + 自测） ────────────────

/**
 * 一轮假摄像头测量的**可信度判定** —— 纯函数，有自测（`TRUST_CASES` / `selfTest()`）。
 * 返回 `'trust'` / `'trust-low-rate'` / `'distrust'` / `'unusable'`。
 *
 * 🔴 为什么不是"帧率没到门就红" —— 那是把两件事混成一件。
 * 帧率低只说明"**这一次的读数可能不可信**"，不说明"**被判的对象错了**"。
 * 实测代价（CI run `36660895335`）：runner 被挤到 1.5 帧/秒时输出
 * `grade=insufficient score=76`，读线报的人会去判定实现里找一个不存在的问题 ——
 * 那 10 条红全是"帧没进来"的下游症状，方向完全指错。
 * 反过来，把"低帧率"整个忽略掉，一段根本没验成的结果又会被读成"验过了"。
 * ⇒ 判据**两个轴交叉**：环境指标（帧率）× 结论（与 fixture 对不对得上）。
 *
 * | 帧率 | 结论与 fixture 对得上？ | 判定 | 为什么 |
 * |---|---|---|---|
 * | ≥ `rate_floor_browser` | 任意 | `trust` | 环境在**实测证过**的区间 ⇒ 结论（对的/错的）都算数 |
 * | `rate_floor` ~ 门之间 | 对 | `trust-low-rate` | 低帧率下的读数，但**结论正是要验的那个东西** ⇒ 采信 + ⚠ |
 * | `rate_floor` ~ 门之间 | 不对 | `distrust` | 分不清是环境挤的还是判定坏了 ⇒ 重试一次 |
 * | < `rate_floor` | 任意 | `distrust` | 连**离线模型**都没证过这一档 ⇒ 结论对得上也不当证据（防蒙对） |
 * | 这一轮异常 / 提前返回 | — | `unusable` | 异常本身已由 `checkCameraGuidance` 记在那一轮里了 |
 *
 * ⚠️ **判据只允许这一处实现**：段内那条断言与外层重试**都调它**。
 * 抄一份到别处 ⇒ 两份政策必然分叉，而分叉的表现是"守卫绿着但它验的不是你以为的那个东西"。
 */
function trustCameraRound(r, ui) {
  if (!r) return 'unusable'
  if (r.rate >= ui.rate_floor_browser) return 'trust'
  if (r.rate < ui.rate_floor) return 'distrust'
  return r.verdictOk ? 'trust-low-rate' : 'distrust'
}

/**
 * `trustCameraRound()` 的自测表 —— 「输入 → 必须得到的判定」。
 * 表里的值不是描述的复述，而是**政策本身**：改判据就必须同时改这张表；
 * 改不动表，说明这次不是"修 bug"而是"改政策"，那就得先说服人。
 */
const TRUST_CASES = [
  { why: '环境远超门（本机常态）', rate: 4.5, verdictOk: true, want: 'trust' },
  { why: '环境超门但判错了 ⇒ 这是**真失败**，不许被"环境"二字掩盖', rate: 4.5, verdictOk: false, want: 'trust' },
  { why: '恰好等于门（≥ 即采信）', rate: 2.0, verdictOk: false, want: 'trust' },
  { why: '低于门但结论一致 ⇒ 采信 + ⚠（本政策的核心一行）', rate: 1.9, verdictOk: true, want: 'trust-low-rate' },
  { why: '低于门且结论对不上 ⇒ 分不清，要重试', rate: 1.9, verdictOk: false, want: 'distrust' },
  { why: '恰好等于离线最低档 ⇒ 仍属"离线证过"，结论一致就采信', rate: 1.5, verdictOk: true, want: 'trust-low-rate' },
  { why: '低于离线最低档 ⇒ 结论一致也不当证据（防"蒙对"）', rate: 1.2, verdictOk: true, want: 'distrust' },
  { why: 'CI 上真实出现过的被挤环境（0.8 帧/秒）', rate: 0.8, verdictOk: false, want: 'distrust' },
  { why: '这一轮异常 / 提前返回', rate: null, verdictOk: false, want: 'unusable' },
]

/**
 * 跑 `TRUST_CASES`。门值用**合成**的一组（1.5 / 2.0）：这里验的是**判据的形状**
 * （两个轴怎么交叉），而"fixture 里那两个数自己合不合理"由 `loadUiSmoke()` 的
 * 关系自检负责 —— 两件事分开验，改一个不会把另一个带绿。
 */
function selfTest() {
  const ui = { rate_floor: 1.5, rate_floor_browser: 2.0 }
  const bad = []
  for (const c of TRUST_CASES) {
    const r = c.rate === null ? null : { rate: c.rate, verdictOk: c.verdictOk }
    const got = trustCameraRound(r, ui)
    if (got !== c.want) {
      bad.push(
        `帧率 ${c.rate === null ? '异常' : c.rate} / 结论${c.verdictOk ? '一致' : '对不上'} → ` +
          `得到 ${got}，应为 ${c.want}（${c.why}）`,
      )
    }
  }
  return bad
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

// ─────────────────── 假摄像头：实时引导 / 实时徽章 ───────────────────

/**
 * 一次采样的探针。把判定链在界面上留下的痕迹读出来：
 *   · 实时引导**浮层**的文案（= `liveQuality.hint`）
 *   · 实时动作达成度的**徽章**数字（= `liveQuality.score`，见 `NeckActivity.tsx` 的 `liveQuality`）
 *   · 摄像头画面里的**姿态读数**（证明帧真的进了 MediaPipe）
 *   · 视频元素的 `currentTime`（证明**新帧真的到了** `<video>`，不是只有我们自己在 requestFrame）
 *
 * 🔴 浮层必须按**样式**认，不能只按文案：面板里还有一处同文案的 `<span>`，
 *    只按文案会把"浮层没渲染、面板那行在"读成"浮层出现了"。
 *
 * 🔴 徽章按 **`data-ng` 锚点**读，不按布局层级找 —— 这一条是被变异测试逼出来的：
 *    原来靠 `p"实时动作达成度"` → `parentElement` → `span`，可**移动端练习条上的徽章
 *    根本没有那个 `<p>`**，于是 `gauge` 恒为 `null`、一致性循环整段 `continue`，
 *    断言一路"✓"着却一次都没检查过任何东西（变异 M5 漏网才暴露）。
 *    现在锚点挂在 `ScoreGauge` 上（`ngId`），并且"提示在屏上时锚点必须读得到"本身
 *    就是一条断言 —— 锚点再丢，红的是这一条，不会又是静默空转。
 *
 * 🔴 分辨「渲染出来了」与「用户看得见」是两件事，必须分开读：
 *   · `overlayMounted` = 元素在 DOM 里（= `liveQuality` 非 null）。这是"有帧时实时引导
 *     不再恒为 null"要断的东西 —— 它不该被 `opacity` 影响。
 *   · `overlayVisible` = 再排除 `opacity: 0`。浮层挂载时 `initial={{opacity: 0}}`，
 *     退场的那 0.18 秒也停在 0 上、且**上面还挂着上一句文案** —— 那种陈旧读数会
 *     伪造出"徽章与提示矛盾"。所以**文案与徽章的一致性**只认 `overlayVisible`。
 *   （v1 只用了一个 `overlay` 字段，把这两件事混在一起：结果是"浮层缺了一次"既可能是
 *   判定真的为空、也可能只是采样撞在淡入的那一帧上，而报错话术是一样的。）
 */
const GUIDANCE_PROBE = `(() => {
  const hints = ${JSON.stringify(HINT_TEXTS)};
  const isOverlay = (opacityOk) => [...document.querySelectorAll('div')].find((d) => {
    if (!hints.includes((d.textContent || '').trim())) return false;
    const cs = getComputedStyle(d);
    if (cs.pointerEvents !== 'none' || cs.position !== 'absolute') return false;
    return !opacityOk || cs.opacity !== '0';
  });
  const mounted = isOverlay(false);
  const visible = isOverlay(true);
  // [锚点名, 徽章数字或 null]；页面上有几处就几条（移动端练习条 / 桌面 ExercisePanel）
  const gauges = [...document.querySelectorAll('[data-ng$="-score"]')].map((el) => {
    const sp = el.querySelector('span');
    return [el.getAttribute('data-ng'), sp ? sp.textContent.trim() : null];
  });
  const tp = [...document.querySelectorAll('p')].find((p) => p.textContent.trim() === '头部侧倾');
  const v = document.querySelector('video');
  const s = window.__ngFakeCam;
  return JSON.stringify({
    hint: visible ? visible.textContent.trim() : null,
    overlayMounted: !!mounted,
    overlayVisible: !!visible,
    gauges,
    headTilt: tp && tp.nextElementSibling ? tp.nextElementSibling.textContent.trim() : null,
    pushed: s ? s.pushed : -1,
    vt: v ? v.currentTime : null,
    ending: [...document.querySelectorAll('button')]
      .some((x) => x.textContent.replace(/\\s/g, '') === '结束活动'),
  });
})()`

const SAMPLE_STEP_MS = 500

/**
 * 假摄像头那一段的全部断言。
 *
 * ⚠️ 进入本函数前，本用例已经把「三路由 + 新手引导 + 零采样收尾屏」走完了 ——
 * 所以这里先**回到 `#/` 再整页重载**（`mode` 回到 monitor、假摄像头在 document-start
 * 重新注入），然后单独跑一次"有帧的活动"。
 *
 * ## 时间：喂帧是按**墙上时间**定长，采样也是
 *
 * `start(ui.feed_ms)` 到点自己停 ⇒ 那段"有帧的活动"的**长度是固定的 10 秒**，
 * 帧率只决定喂进去多少帧。采样循环同样按墙上时间走（v1 按"循环次数 × 500ms"走，
 * 而单次采样本身要一次 CDP 往返、在忙页上要 0.3–0.6 秒 ⇒ 10 秒的帧表被采成 22 秒，
 * 时间轴整个错位）。
 *
 * ⚠️ 全程**只断言不变量与存在性**，不钉时间轴：实时引导看的是**最近 5 秒**的滚动窗口，
 * 而帧的时间戳是 `Date.now()` —— "第几秒该出现哪句文案"随真实帧率漂，
 * 钉死必然假红。所以：
 *   ⓪ 环境够不够**采信**这一轮（帧率 × 结论两个轴交叉判，`trustCameraRound()`；放在段末，
 *      因为要等结论读出来）—— 🔴 **帧率低不单独判红**，见文件头与 §9.9；
 *   ① 姿态读数出现过 ≥ 5°（超过静息阈值）⇒ 帧真的走完了 MediaPipe；
 *   ② 帧流动起来之后浮层**一直在**（`liveQuality` 不再恒为 null）；
 *   ③ 出现过「幅度够了」那一类的提示（不是恒 idle / 恒幅度不足）；
 *   ④ 🔴 徽章与提示**不矛盾**（idle ⟺ 0 分；否则 ≥80 ⟺ completed）；
 *   ⑤ 收尾屏与落库：只有那个动作被判、明细 v3 只 1 项、`avg_score` 同源、判成 completed。
 */
async function checkCameraGuidance(cdp, sessionId, run, c, ui) {
  const where = `${c.name} 假摄像头实时引导`
  try {
    // ⚠️ 先回到 `#/`：上一段（活动收尾屏 / 历史行）结束时页面停在 `#/dashboard`，
    // 在那里重载**没有 `<video>`** —— 症状是"app 没取到流"超时，看着像注入坏了。
    await evaluate(
      cdp,
      sessionId,
      `(() => { const a = document.querySelector('a[href="#/"]'); if (a) a.click(); return true })()`,
    )
    await waitFor(cdp, sessionId, `location.hash === '#/' || location.hash === ''`, {
      timeout: 6000,
      label: `${where} 回到肩颈活动页`,
    })
    await evaluate(
      cdp,
      sessionId,
      `(() => { try { sessionStorage.removeItem('neckguardian:start-exercise') } catch (e) {} return true })()`,
    )
    await cdp.send('Page.reload', {}, sessionId)
    await waitFor(cdp, sessionId, `document.readyState === 'complete'`, {
      label: `${where} 重新加载`,
    })

    // ── ① 注入真的生效了（document-start 那个时机最容易静默失败）──────────────
    const inj = await evaluate(
      cdp,
      sessionId,
      `(() => ({ has: typeof window.__ngFakeCam, err: window.__ngFakeCamErr || null }))()`,
    )
    const injOk = !!(inj.ok && inj.value && inj.value.has === 'object' && !inj.value.err)
    run.check(
      injOk,
      `${where} 假摄像头在 document-start 注入成功`,
      inj.value ? `window.__ngFakeCam=${inj.value.has}，err=${inj.value.err}` : inj.error,
    )
    if (!injOk) return null

    await waitFor(cdp, sessionId, `window.__ngFakeCam.ready()`, {
      timeout: 8000,
      label: `${where} 素材加载完`,
    })

    // 🔴 没 `start()` 时必须**一条帧都推不出去**。这条不是形式主义：整个用例前半段
    //    （路由渲染 / 新手引导 / 零采样收尾屏）之所以还能验那几条**边界**，
    //    靠的就是"有摄像头但没帧"。哪天有人把注入改成自动推帧，这里立刻红。
    const idle = await evaluate(
      cdp,
      sessionId,
      `(() => ({ pushed: window.__ngFakeCam.pushed, started: window.__ngFakeCam.started }))()`,
    )
    run.check(
      idle.ok && idle.value && idle.value.pushed === 0 && idle.value.started === false,
      `${where} 未 start() 时一条帧都不推（前半段仍是"零采样"边界）`,
      `pushed=${idle.value?.pushed} started=${idle.value?.started}`,
    )

    // ── ② app 真的把这条流接上了 ─────────────────────────────────────────────
    await waitFor(
      cdp,
      sessionId,
      `(() => { const v = document.querySelector('video'); return !!v && v.videoWidth > 0 })()`,
      { timeout: 15000, label: `${where} app 取到流` },
    )
    const vw = await evaluate(
      cdp,
      sessionId,
      `(() => { const v = document.querySelector('video'); return v ? v.videoWidth + 'x' + v.videoHeight : null })()`,
    )
    run.check(
      vw.ok && vw.value === '640x480',
      `${where} 注入的流被 app 接受（640×480）`,
      `实际 ${vw.value}`,
    )

    // 帧表必须与 fixture 一致：少喂几帧 / 喂错素材都会让下面几条验的东西悄悄变样。
    const setq = await evaluate(
      cdp,
      sessionId,
      `(() => window.__ngFakeCam.setQueue(${JSON.stringify(ui.frames)}))()`,
    )
    run.check(
      setq.ok && setq.value === ui.frames.length,
      `${where} 帧表长度与 fixture 一致（${ui.frames.length} 帧 / 喂 ${ui.feed_ms} ms）`,
      `setQueue 返回 ${setq.value}（fixture 里是 ${ui.frames.length}）`,
    )
    run.check(
      ui.frame_interval_ms === UI_FEED_INTERVAL_MS,
      `${where} 喂帧间隔与 fixture 声明一致（${UI_FEED_INTERVAL_MS} ms）`,
      `fixture 说 ${ui.frame_interval_ms} ms，注入脚本推 ${UI_FEED_INTERVAL_MS} ms —— 两处必须一起改`,
    )

    // ── ③ 开始活动，**确认进了活动态再喂帧** ────────────────────────────────
    const clicked = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const b = [...document.querySelectorAll('button')]
           .find((x) => x.textContent.replace(/\\s/g, '').includes('开始活动'));
         if (!b) return false;
         b.click();
         return true;
       })()`,
    )
    run.check(clicked.ok && clicked.value === true, `${where} 点得到「开始活动」`, '按钮不存在')
    await waitFor(
      cdp,
      sessionId,
      `(() => [...document.querySelectorAll('button')]
           .some((x) => x.textContent.replace(/\\s/g, '') === '结束活动'))()`,
      { timeout: 8000, label: `${where} 进入活动态` },
    )

    // 🔴 计时从**点下开始活动之后**起算：动作计时器的 12 秒边界也从这个时刻起算，
    //    所以"喂帧窗口 + 点结束活动的往返"必须整体落在那 12 秒之内（fixture 里
    //    有 `feed_ms + click_slack_ms ≤ 动作时长 − 500ms` 这条自检钉着）。
    const t0 = Date.now()
    const began = await evaluate(cdp, sessionId, `window.__ngFakeCam.start(${ui.feed_ms})`)
    run.check(began.ok && began.value === true, `${where} 开始逐帧推送`, 'start() 没返回 true')

    // 采样循环按**墙上时间**走（不是按次数）：单次采样要一次 CDP 往返，
    // 忙页上要 0.3–0.6 秒 —— 按次数走会把 10 秒的帧表采成 20 秒以上，时间轴整个错位。
    //
    // 🔴 退出要**提前**（`feed_ms − 一个步长 − 一个 click_slack`），不能等 `at >= feed_ms` 才停。
    //    原因：`at` 是在**采样之前**测的，而每轮还要花掉 500ms 睡眠 + 一次 CDP 往返
    //    ⇒ "采完再看 at" 会让路径变成 `clickAt = feed_ms + 步长 + 往返`。
    //    实测在 CI runner 上顶破了 `click_slack`（`t+10745ms > 10600ms`，android / ios 各红一条，
    //    2 项失败）—— **本机往返 8–408ms、CI runner 120–150ms 起步**，本地全绿推不出 CI 全绿。
    //    提前停之后 `clickAt ≈ feed_ms − 步长 − slack + 往返`，往返要超过 1.5 秒才会红。
    const samples = []
    const sampleStopAt = ui.feed_ms - SAMPLE_STEP_MS - ui.click_slack_ms
    for (;;) {
      if (samples.length) await sleep(SAMPLE_STEP_MS)
      const at = Date.now() - t0
      if (at >= sampleStopAt) break
      const r = await evaluate(cdp, sessionId, GUIDANCE_PROBE)
      if (r.ok && r.value) {
        try {
          samples.push({ at: Date.now() - t0, ...JSON.parse(r.value) })
        } catch {
          /* 单次采样解析失败不算失败，下面的计数断言会兜住 */
        }
      }
    }

    // 帧计数在**点「结束活动」之前**补读一次：上面为了给这一下留出往返余量提前停了采样，
    // 若直接用最后一条采样里的计数，`rate`（分母是完整的 `feed_ms`）会低估约一个步长的量。
    // ⚠️ 必须在 click **之前**读 —— 点下「结束活动」会立刻停止记录帧。
    const tail = await evaluate(cdp, sessionId, `window.__ngFakeCam.pushed`)

    // 喂帧窗口一到就点「结束活动」。这一下会**立刻停止记录帧** ⇒ 记录窗口
    // 不会漫过动作计时器的 12 秒边界（漫过去的话后半段帧会被记到下一个动作上，
    // 症状是"收尾屏多出一个判过的动作"，很难归因）。
    const clickT0 = Date.now()
    const clickedEnd = await evaluate(
      cdp,
      sessionId,
      `(() => {
         const b = [...document.querySelectorAll('button')]
           .find((x) => x.textContent.replace(/\\s/g, '') === '结束活动');
         if (!b) return false;
         b.click();
         return true;
       })()`,
    )
    const clickAt = Date.now() - t0
    await evaluate(cdp, sessionId, `window.__ngFakeCam.stop()`)
    const stopAt = Date.now() - t0

    const last = samples[samples.length - 1] || {}
    const pushed = tail.ok && Number.isFinite(tail.value) && tail.value > 0 ? tail.value : last.pushed > 0 ? last.pushed : 0
    // 帧率 = 喂帧窗口内推出去的帧数 ÷ 喂帧窗口长度（窗口是定长的，见 `start(ms)`）。
    const rate = (pushed * 1000) / ui.feed_ms
    console.log(
      `    · 采样 ${samples.length} 次 / 喂帧 ${ui.feed_ms} ms，推送 ${pushed} 帧（${rate.toFixed(1)}/s）；` +
        `点结束活动 t+${clickAt}ms（窗口结束前 ${ui.feed_ms - clickAt}ms 点的，stop t+${stopAt}ms）`,
    )
    console.log(
      `    · 时间轴 ${samples.map((s) => `${(s.at / 1000).toFixed(1)}s:${s.hint ? s.hint.slice(0, 2) : '--'}`).join(' ')}`,
    )

    // 🔴 前置断言：记录窗口没漫出喂帧窗口。它红了就说"别往下看"，因为下面的
    //    "只有 1 个动作被判"必然跟着红 —— 但根因是这一条（机器太慢 / CDP 往返太慢）。
    run.check(
      clickAt <= ui.feed_ms + ui.click_slack_ms,
      `${where} 点「结束活动」落在喂帧窗口内（≤ ${ui.feed_ms + ui.click_slack_ms}ms）`,
      `实测 t+${clickAt}ms —— 记录窗口比 fixture 建模的长 ${clickAt - ui.feed_ms - ui.click_slack_ms}ms。` +
        `动作计时器的边界在 ${ui.action_duration_ms}ms，漫过去之后帧会被记到下一个动作上`,
    )

    // 🔴 **帧率不单独判红**（v1.7.1 起的政策，见文件头 ⓪ 与 `trustCameraRound()`）：
    //    判据要交叉看"结论对不对得上"，所以那条断言在**段末**（那时结论才读出来）。
    //    这里只把两个数打出来 —— 它是读线报时唯一的原始环境证据。
    console.log(
      `    · 帧率 ${rate.toFixed(1)} 帧/秒（离线模型下界 ${ui.rate_floor} / 浏览器环境门 ${f1(ui.rate_floor_browser)}）`,
    )

    const withOverlay = samples.filter((s) => s.overlayMounted)
    const hintsSeen = [...new Set(samples.map((s) => s.hint).filter(Boolean))]
    const tilts = samples.map((s) => parseFloat(s.headTilt)).filter((v) => Number.isFinite(v))
    const maxTilt = tilts.length ? Math.max(...tilts) : 0
    const vts = samples.map((s) => s.vt).filter((v) => Number.isFinite(v))

    // ① 帧真的走完了「流 → MediaPipe → 姿态读数」
    run.check(
      maxTilt >= 5,
      `${where} 姿态读数来自注入的帧（头部侧倾出现过 ≥ 5°）`,
      `本次最大读数 ${maxTilt}° —— 帧没进推理，或引擎没加载起来`,
    )
    // ①' 视频元素的时间戳也要前进：只证明"我们 requestFrame 了"不够，
    //     得证明浏览器把帧真的交给了 `<video>`（引擎按它去重，不动就等于没帧）
    run.check(
      vts.length >= 2 && vts[vts.length - 1] > vts[0],
      `${where} 注入的帧真的到了 <video>（currentTime 在前进）`,
      `采样到的 currentTime：${vts.length} 个（首 ${vts[0]} / 末 ${vts[vts.length - 1]}）`,
    )
    // ② 帧流动起来之后，实时引导浮层**一直在**（这条就是本次接线要堵的洞：
    //    以前无头环境没有帧 ⇒ `liveQuality` 恒为 null ⇒ 只验过回落分支）
    //
    //    ⚠️ 只统计**喂帧窗口内部**的采样：窗口末尾之后 `liveQuality` 回落到 null 是
    //    **正确**行为（帧不再进来，滚动窗口会把内容滚空）。v1 把"采样一直采到窗口
    //    结束之后"的读数也算进来，于是"停帧后浮层消失"被当成失败 —— 而那恰恰是它该做的。
    const late = samples.filter((s) => s.at >= 3000 && s.at <= ui.feed_ms - 500)
    const lateMiss = late.filter((s) => !s.overlayMounted)
    const liveOk = withOverlay.length > 0 && late.length >= 3 && lateMiss.length === 0
    run.check(
      liveOk,
      `${where} 有帧时实时引导浮层真的渲染出来了（liveQuality 不再恒为 null）`,
      withOverlay.length === 0
        ? '一次都没出现 —— 帧没进判定链，或浮层的显示条件没满足'
        : late.length < 3
          ? `窗口内只采到 ${late.length} 次（机器太慢，采样被推理挤掉了）`
          : `3 秒后有 ${lateMiss.length}/${late.length} 次采样没看到浮层（${lateMiss.map((s) => (s.at / 1000).toFixed(1) + 's').join(',')}）`,
    )
    // ③ 不是恒 idle / 恒"幅度不够"：拉伸位那一段必须被认成"幅度够了"
    const ampOk = hintsSeen.includes(HINT_HOLD) || hintsSeen.includes(HINT_COMPLETED)
    run.check(
      ampOk,
      `${where} 实时引导认出「幅度够了」那一类提示（不是恒 idle）`,
      `只见到 ${JSON.stringify(hintsSeen)} —— 判定结果与实际动作不符，或帧的相位不对`,
    )
    // ④ 🔴 徽章与提示不矛盾（v1.7.0 修的「同屏两套口径」，铁律 #62/#63）
    //
    //    规则来自 `scoreExercise` 那条**由构造保证**的不变量：`score >= 80 ⟺ completed`；
    //    再加 idle 的显式定义（`IDLE_SCORE = 0`）。把 `activityScore` 改回运动态通道
    //    `score` 会让 idle 时刻的徽章变成一个非 0 的数字 —— 这条当场抓住。
    //    ⚠️ 只认 `overlayVisible` 里的文案（见 `GUIDANCE_PROBE` 的说明）。
    //
    //    🔴 第二轮（变异 M5 漏网后）补的两件事 —— 别再把它们删回去：
    //    ① **锚点必须读得到**：提示在屏上时，同屏徽章必须有读数。以前锚点选错
    //       （移动端练习条没有 `p"实时动作达成度"`）⇒ `gauge` 恒 null ⇒ 整个循环
    //       `continue`，断言恒绿却什么都没查。所以"锚点丢了"本身要红，且报错话术
    //       必须区别于"真矛盾"。
    //    ② 页面上**每一处** `data-ng="*-score"` 都要查（移动端练习条 + 桌面面板），
    //       不是只查第一个 —— 否则又会出现"某条路径没被覆盖"。
    const bad = []
    let anchorSeen = 0
    let anchorMissing = 0
    for (const s of samples) {
      if (s.hint === null) continue
      const pairs = (s.gauges || []).filter(([, v]) => v !== null && v !== '')
      if (!pairs.length) {
        anchorMissing++
        continue
      }
      for (const [ng, v] of pairs) {
        const g = Number(v)
        if (!Number.isFinite(g)) {
          bad.push(`${(s.at / 1000).toFixed(1)}s ${ng} 徽章读数「${v}」不是数字`)
          continue
        }
        anchorSeen++
        const okIdle = s.hint === HINT_IDLE ? g === 0 : null
        const okPair = g >= 80 === (s.hint === HINT_COMPLETED)
        if (okIdle === false || !okPair) {
          bad.push(`${(s.at / 1000).toFixed(1)}s ${ng} 徽章${g}分/提示「${s.hint}」`)
        }
      }
    }
    run.check(
      bad.length === 0 && anchorMissing === 0 && anchorSeen >= 5,
      `${where} 实时徽章与实时提示不矛盾（idle⟺0 分，否则 ≥80⟺completed）`,
      anchorMissing > 0
        ? `${anchorMissing} 次采样「提示在屏上、徽章却读不到」 —— 徽章上的 ` +
          'data-ng="*-score" 锚点没了（这正是这条断言以前静默空转的原因）'
        : anchorSeen < 5
          ? `只读到 ${anchorSeen} 次徽章读数（要 ≥5）—— 徽章没渲染，或锚点又选错了`
          : `${bad.length} 处矛盾：${bad.slice(0, 3).join('；')}`,
    )
    console.log(`    · 徽章锚点：读到 ${anchorSeen} 次读数${anchorMissing ? `，另有 ${anchorMissing} 次读不到` : ''}`)

    // ── ⑥ 收尾：**真实帧**下的收尾屏与落库 ────────────────────────────────────
    run.check(clickedEnd.ok && clickedEnd.value === true, `${where} 点得到「结束活动」`, '按钮不存在')

    const done = await waitFor(
      cdp,
      sessionId,
      `(() => {
         const ps = [...document.querySelectorAll('p')];
         const lbl = ps.find((p) => p.textContent.trim() === '本次动作成绩');
         if (!lbl) return null;
         return {
           score: lbl.previousElementSibling ? lbl.previousElementSibling.textContent.trim() : '',
           undecided: (document.body.innerText.match(/未判定/g) || []).length,
         };
       })()`,
      { timeout: 6000, label: `${where} 渲染出收尾屏` },
    )
    run.check(
      done.score !== '--' && Number.isFinite(Number(done.score)),
      `${where} 有真实帧时成绩不再是 --`,
      `实际「${done.score}」 —— 帧没被判进去`,
    )
    run.check(
      done.undecided === 6,
      `${where} 只有 1 个动作被判、其余 6 个如实标「未判定」`,
      `实际 ${done.undecided} 次 —— 帧被算到了别的动作上。先看上面那条"点结束活动落在喂帧窗口内"` +
        `有没有红：记录窗口漫过动作时长 ${ui.action_duration_ms}ms 之后，后半段帧会被记到下一个动作上`,
    )
    console.log(`    · 收尾：本次动作成绩 ${done.score}、未判定 ${done.undecided} 次`)

    // 落库那条记录：取**时间戳最新**的一条（不是"最后一条"—— 上一轮还插了 3 条老记录）
    const rec = await evaluate(
      cdp,
      sessionId,
      `(async () => {
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
               if (!rows.length) { resolve(null); return; }
               const newest = rows.reduce((a, b) => (String(b.timestamp) > String(a.timestamp) ? b : a));
               resolve(JSON.stringify(newest));
             };
           };
         });
         for (let i = 0; i < 30; i++) {
           const r = await readLatest();
           if (r) return r;
           await new Promise((s) => setTimeout(s, 100));
         }
         return null;
       })()`,
    )
    const got = rec.ok && rec.value
    run.check(!!got, `${where} 真实帧的成绩真的落库`, `没读到记录：${rec.error || '无'}`)
    // 本轮的**结论**（给 `trustCameraRound()` 交叉判定用）。
    // 🔴 它**不替代任何断言** —— 下面那几条照旧逐条跑、逐条计数，一行都不少；
    //    这里的值只回答"这一轮的环境够不够采信这一份结论"。
    let verdict = '没读到落库记录'
    let verdictOk = false
    if (got) {
      const row = JSON.parse(rec.value)
      let parsed = null
      try {
        parsed = JSON.parse(row.action_scores)
      } catch {
        /* 下面那条断言会报出来 */
      }
      const items = parsed && Array.isArray(parsed.items) ? parsed.items : null
      // 结论摘要（只用于报错话术与采信判定；断言在下面，不看这个变量）
      verdict = !parsed
        ? '明细不是 JSON'
        : !items || items.length !== 1
          ? `明细 ${items ? items.length : '非数组'} 项（期望 1 项）`
          : `grade=${items[0].grade} score=${items[0].score} avg=${row.avg_score}`
      // "结论与 fixture 对得上" = 这段要验的东西**全中**（任一不中 ⇒ 这一轮的结论不可采信）
      verdictOk =
        !!parsed &&
        parsed.v === 3 &&
        !!items &&
        items.length === 1 &&
        items[0].id === 'neck-flex-left' &&
        items[0].grade === 'completed' &&
        row.avg_score === items[0].score &&
        row.avg_score >= 80
      run.check(
        !!parsed && parsed.v === 3 && !!items && items.length === 1,
        `${where} 落库明细是 v3 且只含 1 个判过的动作`,
        `实际：${JSON.stringify(row.action_scores)}`,
      )
      if (items && items.length === 1) {
        // 明细项的 `id` 也钉住：光看"1 项 / completed / ≥80"的话，
        // 万一时序反了（判的是第二个动作），分数照样可能合理 —— 而那就不是这段要验的东西了。
        run.check(
          items[0].id === 'neck-flex-left',
          `${where} 判过的那一项是第一个动作（neck-flex-left）`,
          `实际 id=${items[0].id} —— 计时/时序偏了？`,
        )
        run.check(
          row.avg_score === items[0].score,
          `${where} avg_score 与明细同源`,
          `avg_score=${row.avg_score} vs 明细 ${items[0].score}`,
        )
        run.check(
          items[0].grade === 'completed' && row.avg_score >= 80,
          `${where} 浏览器路径判成 completed（与 fixture 的 UI 冒烟帧表同源）`,
          `实际 grade=${items[0].grade} score=${items[0].score} —— 两条测量路径分叉了？` +
            `见 fake-camera/README 的余量表与 scenarios.json:ui_smoke.rate_sweep（扫描说这一档是 completed）`,
        )
      }
    }

    // ── ⓪ 环境够不够采信（**判据只有一处实现**：`trustCameraRound()`）────────────
    // 为什么放在**段末**：它要交叉看"结论对不对得上"，而结论到上面才读出来。
    // 读线报时**先看外层那条「环境不足」** —— 它在回放任何断言之前就打出来了，
    // 所以"先看哪一条"这件事没有变。
    const trust = trustCameraRound({ rate, verdictOk }, ui)
    run.check(
      trust !== 'distrust',
      `${where} 这一轮的环境够采信（帧率 ≥ ${f1(ui.rate_floor_browser)} 帧/秒，或低帧率下结论仍与 fixture 一致）`,
      `实测 ${rate.toFixed(1)} 帧/秒（离线模型下界 ${ui.rate_floor} / 浏览器环境门 ${f1(ui.rate_floor_browser)}）、` +
        `结论 ${verdict} —— ` +
        (rate < ui.rate_floor
          ? `连离线模型都没证过这一档，结论对得上也不当证据（防"蒙对"）`
          : `分不清是环境挤的还是判定坏了，外层会重试一次，两轮都这样才报「环境不足」`),
    )
    // 把本轮的**关键量**交出去（供 `checkCameraGuidanceWithRetry` 判"环境够不够"）。
    // 交数值 + 结论摘要：**不交判定**（判定只有 `trustCameraRound()` 一处实现）。
    return { rate, clickAt, pushed, samples, verdict, verdictOk }
  } catch (e) {
    run.fail(where, e.message)
    return null
  }
}

/**
 * 跑假摄像头那一段，**环境不够采信时整段重来一次**。
 *
 * 🔴 为什么需要它：这一段要求无头页里的 MediaPipe 真的在出帧，而 **CI runner 的负载波动极大** ——
 * 实测同一台 runner 上帧率在 **0.3 – 4.8 帧/秒** 之间跳（差 16 倍），最差那次 10 秒只推到 **5 帧**，
 * 连带 **10 项断言红**，而且**全是"帧没进来"的下游症状**（姿态读数 1.4°、浮层没出现、
 * 徽章读不到、判成 insufficient），没有一条在说判定实现错了 —— 方向完全指错。
 *
 * 那种红**不是代码缺陷**，但也不能靠"放宽帧率下界"消掉
 * （那正是"为了让测试变绿而削弱断言"，铁律不允许；而且 1.5 这个下界是**离线扫描过**的数）。
 *
 * 🔴 **什么时候才算"环境不够采信"**：判据**只有一处实现** —— `trustCameraRound()`
 * （帧率 × 结论两个轴交叉）。要点是**帧率低本身不算**：
 *   · 帧率 ≥ `rate_floor_browser`（2.0）⇒ 环境在实测证过的区间，结论对错都算数；
 *   · 帧率低但**结论与 fixture 一致** ⇒ 采信（那正是要验的东西），只打一条 ⚠；
 *   · 帧率低**且**判不出 expected ⇒ 分不清是谁的问题 ⇒ 重试；
 *   · 帧率 < `rate_floor`（1.5）⇒ 连离线模型都没证过这一档，结论对得上也不当证据。
 *
 * 做法：第一轮跑进**影子收集器**（不打印、不计数）。可采信就把那一轮的断言**原样回放**
 * （所以正常路径的断言条数、顺序、文案一字不变）；不可采信就整段重来一次
 * （`checkCameraGuidance` 开头本来就会回到 `#/` 再 reload，天然可以重跑）。
 * 两轮都不可采信 ⇒ 如实红，但**报错形状指向环境**：
 * 先给一条明确的"环境不足"，再回放第二轮的原始结果 —— 不掩盖任何东西，
 * 但读线报的人不会去判定实现里找不存在的问题。
 */
async function checkCameraGuidanceWithRetry(cdp, sessionId, run, c, ui) {
  const replay = (shadow, into) => {
    for (const [cond, label, detail] of shadow.checks) into.check(cond, label, detail)
  }
  const fmt = (r) => (r ? `${r.rate.toFixed(1)} 帧/秒` : '异常/提前返回')
  const what = (r) => (r ? String(r.verdict) : '这一轮没跑到落库那一步')
  const lowNote = (r) =>
    `    ⚠ ${c.name} 假摄像头实时引导：本轮 ${fmt(r)} < 环境门 ${f1(ui.rate_floor_browser)} 帧/秒，` +
    `但结论与 fixture 一致（${what(r)}）⇒ 照常采信。` +
    `**这一段是在偏挤的环境下验的** —— 那一档的结论不可信（实测两个平台**都**跑 1.5 帧/秒时，` +
    `一个判 completed 84、另一个判 insufficient 76 ⇒ 跨在 80 分达标线上摇摆），记进线报，别当常态`

  const first = new ShadowRunner()
  const r1 = await checkCameraGuidance(cdp, sessionId, first, c, ui)
  const d1 = trustCameraRound(r1, ui)
  if (d1 === 'trust') {
    replay(first, run)
    return
  }
  if (d1 === 'trust-low-rate') {
    console.log(lowNote(r1))
    replay(first, run)
    return
  }

  console.log(
    `    ⚠ ${c.name} 假摄像头实时引导：本轮 ${fmt(r1)}、结论 ${what(r1)} —— ` +
      (r1 && r1.rate < ui.rate_floor
        ? `低于离线模型下界 ${ui.rate_floor}，这一轮不作为证据`
        : `低于环境门 ${f1(ui.rate_floor_browser)} 且判不出期望结论，分不清是环境挤的还是判定坏了`) +
      `，整段重试一次`,
  )

  const second = new ShadowRunner()
  const r2 = await checkCameraGuidance(cdp, sessionId, second, c, ui)
  const d2 = trustCameraRound(r2, ui)
  if (d2 === 'trust' || d2 === 'trust-low-rate') {
    if (d2 === 'trust-low-rate') console.log(lowNote(r2))
    if (r1 && !r1.verdictOk) {
      console.log(
        `    ⚠ ${c.name} 第一轮在 ${fmt(r1)} 下判错了（${what(r1)}）、第二轮恢复正常 ` +
          `⇒ 以第二轮为准（这一条本身就是"帧率越低越容易判不出来"的实证）`,
      )
    }
    replay(second, run)
    return
  }

  if (d2 === 'distrust') {
    run.fail(
      `${c.name} 假摄像头实时引导 环境不足：两轮都没到可采信的环境`,
      `第一轮 ${fmt(r1)}（${what(r1)}）、第二轮 ${fmt(r2)}（${what(r2)}）—— ` +
        `浏览器实测的可信下界是 ${f1(ui.rate_floor_browser)} 帧/秒（离线模型下界 ${ui.rate_floor}），` +
        `**这一段本次没能验证**：不能据此说判定实现坏了。下面的失败多数是它的下游症状，先看这一条。` +
        `若两轮都在 1 帧/秒上下，多半是 runner 太忙 —— 重跑一次（rerun）比查代码更快`,
    )
  } else {
    console.log(
      `    ⚠ ${c.name} 第二轮没能跑完（异常/提前返回）；第一轮 ${fmt(r1)}（${what(r1)}）` +
        ` —— 下面回放的是第二轮的原始结果（异常本身会在里面报出来）`,
    )
  }
  replay(second, run)
}

// ─────────────────────────── 主流程 ───────────────────────────

async function main() {
  // ── 先自测"采信判据"本身（纯函数，不需要浏览器/产物）────────────────────────
  //
  // 🔴 为什么放在最前面、而且**无条件**跑：`trustCameraRound()` 判错的两种表现是
  //    「该红的没红」（低帧率把真失败洗成环境问题）与「已经正确的读数被判成环境问题」
  //    —— 两种**都不会让守卫自己叫出来**。它是这段唯一一处政策实现，必须自己先有牙。
  const selfBad = selfTest()
  if (SELF_TEST_ONLY || selfBad.length) {
    console.log(`采信判据自测（${TRUST_CASES.length} 例：帧率 × 结论两个轴交叉）`)
    for (const c of TRUST_CASES) {
      const got = trustCameraRound(
        c.rate === null ? null : { rate: c.rate, verdictOk: c.verdictOk },
        { rate_floor: 1.5, rate_floor_browser: 2.0 },
      )
      console.log(
        `  ${got === c.want ? '✓' : '✗'} 帧率 ${String(c.rate === null ? '异常' : c.rate).padStart(5)}` +
          ` / 结论${c.verdictOk ? '一致  ' : '对不上'} → ${got.padEnd(15)}（期望 ${c.want}；${c.why}）`,
      )
    }
  }
  if (selfBad.length) {
    console.error(`::error::采信判据自测失败 ${selfBad.length}/${TRUST_CASES.length}：`)
    for (const b of selfBad) console.error(`  ✗ ${b}`)
    process.exit(1)
  }
  if (SELF_TEST_ONLY) {
    console.log(`✅ 采信判据自测通过 ${TRUST_CASES.length}/${TRUST_CASES.length}`)
    process.exit(0)
  }
  console.log(`✓ 采信判据自测 ${TRUST_CASES.length}/${TRUST_CASES.length}\n`)

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

  // 假摄像头那一段的前提资源：跑之前点名核对，缺任何一个就**直接失败**。
  // 🔴 不许"缺了就跳过那一段" —— 跳过会让这个守卫永远是绿的，而它恰恰是唯一能
  //    证明"有帧时实时引导真的出来了"的东西。两处来源都可靠（见 CAMERA_ASSETS）。
  const mobileCases = cases.filter((c) => c.form === '移动端')
  let UI_SMOKE = null
  if (mobileCases.length) {
    const missing = CAMERA_ASSETS.filter(([p]) => !fs.existsSync(p))
    if (missing.length) {
      console.error('::error::UI 冒烟无法进行：假摄像头那一段的前提资源缺失')
      for (const [p, what] of missing) console.error(`  ✗ ${what} —— ${path.relative(ROOT, p)}`)
      console.error('  wasm 来自 npm ci 装的 @mediapipe/tasks-vision；模型是入库的 mediapipe-assets/。')
      process.exit(1)
    }
    UI_SMOKE = loadUiSmoke()
  }

  const { server, port } = await startStaticServer(DIST, FALLBACK_ROOTS)
  const origin = `http://127.0.0.1:${port}`
  console.log(`UI 冒烟 · 无头 Chrome`)
  console.log(`  静态目录  ${path.relative(ROOT, DIST) || '.'} → ${origin}`)
  if (UI_SMOKE) {
    console.log(
      `  兜底资源  /ng-frames/ → scripts/fake-camera/frames   /mediapipe/** → ${path.relative(ROOT, MEDIAPIPE_WASM_SRC)}+models`,
    )
  }
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

      // 🔴 假摄像头必须**在导航之前**注册：`Page.addScriptToEvaluateOnNewDocument`
      //    只对**后续**文档生效，晚一步就等于这一页没有它 —— 而页面照常渲染，
      //    从日志上看不出任何差异（症状只是"帧没来"）。
      //    只给**移动端**用例注入：桌面走 WS 把帧发给 Python 后端，注入会把它的取流
      //    路径换掉、把"桌面无后端"那几条断言验的东西悄悄改成别的东西。
      if (c.form === '移动端' && UI_SMOKE) {
        await cdp.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: fakeCameraScript(UI_SMOKE.frames) },
          sessionId,
        )
      }

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
            // 零明细的规范文本恰好是 `{"v":3,"items":[]}`：
            // **不是** `{"v":3,"items":[]}` 之外的任何形态（多一个空格就红）。
            // 🔴 版本号必须在**两处**同时改（这里 + `exerciseQuality.ACTION_SCORES_VERSION`）：
            // 它是"落库字节"与"源码常量"之间唯一的交叉校验点，漏改一处这里就红。
            //   口径每改一次就升一次（v1 → v2 → v3），别嫌烦 —— 这个号是显示端
            //   区分"两把尺子量出来的分数"的唯一依据。
            run.check(
              row.action_scores === '{"v":3,"items":[]}',
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

            // 再插一条 **v1 明细**记录（v1.7.0 新增的「第四态」）：形态与当前完全相同、
            // 能正常解析，只是分数按**旧口径**算的。它和上面那条 NULL 记录**不是同一条
            // 代码路径**（一个进 `parsed === null`、一个进 `parsed.legacy`），所以必须各插一条。
            // 少了它，"v1 明细不会被误当成坏值丢掉、也没有被当成新口径"这两件事就没人验。
            await evaluate(cdp, sessionId, `(async () => {
                 const db = await new Promise((res, rej) => {
                   const r = indexedDB.open('neckguardian');
                   r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
                 });
                 await new Promise((res, rej) => {
                   const tx = db.transaction('activity_log', 'readwrite');
                   tx.objectStore('activity_log').put({
                     timestamp: new Date(Date.now() - 7200e3).toISOString(),
                     activity_type: 'exercise', exercise_count: 7, duration_sec: 82, avg_score: 88,
                     action_scores: '{"v":1,"items":[{"id":"neck-left-flex","score":88,"grade":"completed"}]}',
                   });
                   tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
                 });
                 db.close();
                 return true;
               })()`)

            // 再插一条 **v2 明细**记录：v1.7.1 起 v2 也进了历史版本（口径从"活动范围"
            // 改成"活动范围 **+ 时间支撑**"）。它和 v1 走的是**同一个 `parsed.legacy` 分支**，
            // 但显示端的说明文案**按版本分开说** —— 所以这条要验的不是"有没有标旧口径"
            // （v1 那条已经验了），而是**标出来的理由对不对**。
            // 少了它，"按版本分文案"就是一句没人守的承诺（而错理由比没理由更误导）。
            await evaluate(cdp, sessionId, `(async () => {
                 const db = await new Promise((res, rej) => {
                   const r = indexedDB.open('neckguardian');
                   r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
                 });
                 await new Promise((res, rej) => {
                   const tx = db.transaction('activity_log', 'readwrite');
                   tx.objectStore('activity_log').put({
                     timestamp: new Date(Date.now() - 10800e3).toISOString(),
                     activity_type: 'exercise', exercise_count: 7, duration_sec: 82, avg_score: 76,
                     action_scores: '{"v":2,"items":[{"id":"neck-flex-left","score":76,"grade":"insufficient"}]}',
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
            // 滤出**分数徽章那个 `div`**（四种 explain 各一种前缀）。注意旧口径徽章是个
            // `<span title>`，不在 `div[title]` 里，所以这里每个历史行只会命中**一个**元素
            // （就是分数那个），`texts` 的长度 = 可见历史行数。
            const hist = await evaluate(cdp, sessionId, `(() => {
                 const badges = [...document.querySelectorAll('div[title]')]
                   .filter(d => /本次动作成绩|旧记录|旧口径|没有可判定的动作/.test(d.getAttribute('title') || ''));
                 return {
                   n: badges.length,
                   texts: badges.map(d => d.textContent.trim()),
                   // 旧口径的**理由**文案（按版本不同）：v1 = "偏离有多大 + 三项取最大"、
                   // v2 = "活动范围 + 无时间支撑"。取出来是为了验"理由对不对"，
                   // 而不只是"有没有标一个'旧口径'的章"。
                   titles: badges.map(d => d.getAttribute('title') || ''),
                   legacyTagged: document.body.innerText.includes('旧口径'),
                 };
               })()`)
            const texts = (hist.ok && hist.value && hist.value.texts) || []
            run.check(
              texts.length > 0,
              `${where} 历史行带上了可解释的 title（新记录/旧记录/旧口径明细/无判定 四态之一）`,
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
            // 🔴 第四态（v1.7.0 新增）：明细**形态**合法、分数是**旧口径** ——
            // 必须照常显示分数并标「旧口径」。它和上面的 NULL 记录走的是**不同分支**
            // （`parsed.legacy` vs `parsed === null`），所以必须单插一条来证：
            // 少了它，"v1 明细没被当坏值丢掉、也没被当成新口径"这件事就没人验。
            run.check(
              texts.includes('88分'),
              `${where} v1 明细（旧口径）照常显示分数`,
              `实际：${JSON.stringify(texts)}`,
            )
            run.check(
              texts.includes('76分'),
              `${where} v2 明细（旧口径）照常显示分数`,
              `实际：${JSON.stringify(texts)}`,
            )
            // 🔴 旧口径的**理由**必须按版本分开说：两版口径互不相同，
            // 用一句话糊过去 = 用一个错的理由去解释一个不可比的数字（比不解释更误导）。
            // 用户 hover 到分数上看到的就是这句。
            const titles = (hist.ok && hist.value && hist.value.titles) || []
            run.check(
              titles.some((t) => t.includes('（v1）')) && titles.some((t) => t.includes('（v2）')),
              `${where} 旧口径说明按版本分开（v1 / v2 各一句）`,
              `实际 titles：${JSON.stringify(titles)}`,
            )
          }
        }
      } catch (e) {
        run.fail(`${c.name} 活动收尾屏`, e.message)
      }

      // ── 假摄像头 · 实时引导 ────────────────────────────────────────────────
      //
      // 🔴 必须排在「活动收尾屏」**之后**：那一段验的是**零采样**那条边界
      //    （无帧 ⇒ 成绩 `--`、7 个动作全「未判定」、落库 `{"v":3,"items":[]}`），
      //    而这一段会真的喂帧。反过来排，那段边界断言就成了"有帧时的值"，
      //    整个断言组都失效。这里重载一次页面把 `mode` 归零、再单独跑一次"有帧的活动"。
      if (c.form === '移动端' && UI_SMOKE) {
        await checkCameraGuidanceWithRetry(cdp, sessionId, run, c, UI_SMOKE)
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

      // ── 收尾：把本用例写进 IndexedDB 的东西清干净 ──────────────────────────
      //
      // 🔴 同一个浏览器 profile 下，`indexedDB` 与 `localStorage` 都是**跨用例共享**的
      //    （5 个平台组合共用同一个 origin）。以前不清也没红，只是因为那几条历史断言的
      //    目标行恰好还没被多出来的行挤出可见窗口 —— 那是**运气，不是隔离**。
      //    本用例新增的「假摄像头」段每次会多写一条活动记录，正好把 ios 用例里
      //    那条 v2 明细行挤出去（实测：`v2 明细（旧口径）照常显示分数` 当场红）。
      //    ⇒ 显式复原"全新 profile"的语义，用例之间不再互相影响。
      //    （`localStorage` 的引导标志在**每个用例开头**已经被清过一次，这里不重复。）
      const wiped = await evaluate(
        cdp,
        sessionId,
        `(async () => {
           const db = await new Promise((res) => {
             let req;
             try { req = indexedDB.open('neckguardian'); } catch (e) { res(null); return }
             req.onsuccess = () => res(req.result)
             req.onerror = () => res(null)
           })
           if (!db) return '(打不开库)'
           const names = [...db.objectStoreNames]
           for (const n of names) {
             await new Promise((res) => {
               const tx = db.transaction(n, 'readwrite')
               tx.objectStore(n).clear()
               tx.oncomplete = res; tx.onerror = res; tx.onabort = res
             })
           }
           db.close()
           return names.join(',')
         })()`,
      )
      console.log(`    · 收尾清空 IndexedDB：${wiped.value ?? wiped.error}`)

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
      ` + 新手引导 ${cases.length} 次 + 活动收尾屏/历史行 ${cases.length} 次` +
      ` + 假摄像头实时引导 ${mobileCases.length} 次，${run.passed} 项断言`,
  )
  if (EVIDENCE_DIR) console.log(`   截图已存：${path.relative(ROOT, EVIDENCE_DIR)}`)
}

main()
