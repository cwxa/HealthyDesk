#!/usr/bin/env node
/**
 * 原生配置守卫（静态检查，不需要真机、不需要设备、不需要模拟器）
 *
 * ## 这条守卫在替代什么
 *
 * 项目原先把这些判为「只能真机验证」：iOS 少了 `NSCameraUsageDescription` 会**被系统
 * 直接终止进程**（不是弹权限框，是闪退）；Android 少了 `CAMERA` 声明则 WebView 的权限
 * 请求必然被拒；`iosScheme` / `hostname` 设错会让页面加载不出来或 `getUserMedia` 报
 * AbortError。这些「错了就崩」的事，**判据全是静态的配置文本** —— 不需要设备就能查。
 *
 * 于是政策改为「代码审查 + 单元测试」之后，这一类风险由本守卫接管：
 * 改错配置在 CI 里就红，不用等装到机器上。
 *
 * （真正需要设备的那些 —— 系统权限对话框本身、切后台冻结、真人动作幅度校准 ——
 * 仍在 `docs/device-matrix.md` 里逐项记为**已接受的残余风险**，不在这里假装覆盖。）
 *
 * ## 🔴 为什么必须先剥注释
 *
 * `Info.plist` 与 `capacitor.config.ts` 的注释里**都提到了**要禁用的键，而且写法与真声明
 * 一模一样：
 *
 *     <!-- 故意**不声明** NSMicrophoneUsageDescription： … -->      ← Info.plist
 *      * ⚠️ 这里**故意不设** `iosScheme: 'https'`。                  ← capacitor.config.ts
 *
 * 直接 `text.includes('NSMicrophoneUsageDescription')` 会把这**两处注释**判成「声明了」，
 * 于是守卫对着正确的配置报红。所以先剥注释，再判断；剥离器本身配了 7 例自测
 * （`--self-test`），其中就包含上面这两种真实形态。
 *
 * ## 检查项（每条都对应一个真会出问题的改法）
 *
 * | # | 检查 | 改错的后果 |
 * |---|---|---|
 * | 1 | iOS `Info.plist` 有 `NSCameraUsageDescription` | 一开摄像头**进程被系统终止**（像闪退） |
 * | 2 | iOS `Info.plist` **没有** `NSMicrophoneUsageDescription` | 本项目不采音频；多一道弹窗 + 审核追问 |
 * | 3 | `capacitor.config.ts` 的 `androidScheme: 'https'` | 非安全上下文，`getUserMedia` 不可用 |
 * | 4 | `capacitor.config.ts` **没有** `iosScheme` | 本地资源加载不出来（WKWebView 保留 https） |
 * | 5 | `capacitor.config.ts` **没有** `hostname` | iOS 15.5–16 带端口 scheme ⇒ AbortError |
 * | 6 | `appId` 是 `com.neckguardian.app` | 与 Android 包名 / BundleID 脱钩 |
 * | 7 | `AndroidManifest.xml` 声明 `CAMERA` 权限 | WebView 权限请求必然被拒 |
 * | 8 | `AndroidManifest.xml` 声明 `INTERNET` 权限 | 外部请求全部失败 |
 * | 9 | `electron-builder.yml` 有 mac `NSCameraUsageDescription` | 桌面端同上（进程被终止） |
 * | 10 | `electron-builder.yml` 有 mac `NSMicrophoneUsageDescription` | 桌面语音提示需要它（**与 iOS 相反**） |
 *
 * ⚠️ 第 2 条与第 10 条方向**相反**：iOS 不能声明麦克风，桌面 mac 必须声明。这是最容易
 * 抄错的一处，正好由守卫固化下来。
 *
 * 零依赖。
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ARGS = process.argv.slice(2)
const SELF_TEST = ARGS.includes('--self-test')
/**
 * `--root=<dir>`：把检查对象指向另一棵文件树。
 * 变异测试复制一份临时副本、对着副本改，**不去动真实的原生配置**。
 */
const rootArg = (ARGS.find((a) => a.startsWith('--root=')) || '').replace('--root=', '')
const ROOT = rootArg ? resolve(rootArg) : join(dirname(fileURLToPath(import.meta.url)), '..')

// ─────────────────────────────────────────────────────────────────────────────
// 注释剥离（自写解析器 ⇒ 必须配自测，见文件末尾 STRIP_CASES）
// ─────────────────────────────────────────────────────────────────────────────

/** 剥掉 XML 注释。Info.plist 用。 */
export function stripXmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * 剥掉 JS/TS 的 `//` 与 `/* *\/` 注释。
 *
 * 写成状态机而不是正则，是因为**字符串字面量里的 `//` 不是注释** ——
 * 例如 `'https://…'`。用正则剥会把 URL 拦腰截断，把后面的正文一起吃掉。
 * 单/双引号与模板字符串都做了跳过。
 */
export function stripTsComments(src) {
  let out = ''
  let quote = null
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (quote) {
      if (c === '\\') {
        out += c + (src[i + 1] ?? '')
        i += 2
        continue
      }
      if (c === quote) quote = null
      out += c
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// 自测：注释剥离器
// ─────────────────────────────────────────────────────────────────────────────

const STRIP_CASES = [
  {
    // ⚠️ 样本必须让剥离器排除掉「注释里出现了**完整 key 形态**」这种情况。
    //    只写裸 key 名是不够的 —— 真实断言用的是 `<key>…</key>` 形态，裸文本本来就不会
    //    误伤它，于是那种样本证明不了剥注释的价值（第一版就栽在这里）。
    why: 'XML：注释里出现**完整的 key 形态** ⇒ 必须剥掉（否则第 2 条会假红）',
    fn: stripXmlComments,
    src:
      '<!-- 不要加 <key>NSMicrophoneUsageDescription</key> -->' +
      '<key>NSCameraUsageDescription</key>',
    has: ['NSCameraUsageDescription'],
    hasNot: ['NSMicrophoneUsageDescription'],
  },
  {
    why: 'XML：真的声明了该键 ⇒ 必须保留（否则第 2 条会漏报）',
    fn: stripXmlComments,
    src: '<key>NSMicrophoneUsageDescription</key><string>x</string>',
    has: ['NSMicrophoneUsageDescription'],
    hasNot: [],
  },
  {
    why: 'TS：行注释里的 iosScheme ⇒ 必须剥掉',
    fn: stripTsComments,
    src: "  ios: {\n    // iosScheme: 'https',\n    contentInset: 'never',\n  },",
    has: ['contentInset'],
    hasNot: ['iosScheme'],
  },
  {
    why: 'TS：块注释里的 iosScheme ⇒ 必须剥掉',
    fn: stripTsComments,
    src: "  ios: {\n    /* 这里故意不设 iosScheme: 'https' */\n    scrollEnabled: true,\n  },",
    has: ['scrollEnabled'],
    hasNot: ['iosScheme'],
  },
  {
    // ⚠️ 样本必须是**真实形态**：那段文字在真文件里位于 `/** … */` 块注释内部。
    //    第一版样本写成了一段孤立的 `* …` 裸文本（没有 `/*` 开头），于是它压根不是注释
    //    —— 失败的是**样本**而不是实现。合成样本与真实形态不符，自测本身就成了摆设。
    why: "🔴 TS：真实形态 —— 多行块注释里，反引号包着 `iosScheme: 'https'`",
    fn: stripTsComments,
    src:
      '  ios: {\n' +
      '    /**\n' +
      "     * ⚠️ 这里**故意不设** `iosScheme: 'https'`。\n" +
      '     * 默认的 capacitor://localhost 已属安全上下文。\n' +
      '     */\n' +
      "    contentInset: 'never',\n" +
      '  },',
    has: ['contentInset'],
    hasNot: ['iosScheme'],
  },
  {
    why: 'TS：正文里的设置 ⇒ 必须保留（否则第 4 条会漏报）',
    fn: stripTsComments,
    src: "  ios: {\n    iosScheme: 'https',\n  },",
    has: ['iosScheme'],
    hasNot: [],
  },
  {
    why: '🔴 TS：字符串里的 `//` 不是注释（URL 会被正则拦腰截断）',
    fn: stripTsComments,
    src: "const u = 'https://example.com/a';\nconst k = 'androidScheme';\n",
    has: ["'https://example.com/a'", 'androidScheme'],
    hasNot: [],
  },
]

function selfTest() {
  const bad = []
  for (const c of STRIP_CASES) {
    const got = c.fn(c.src)
    for (const s of c.has ?? []) {
      if (!got.includes(s)) bad.push(`${c.why}\n      剥后应仍包含 ${JSON.stringify(s)}，实得：${JSON.stringify(got)}`)
    }
    for (const s of c.hasNot ?? []) {
      if (got.includes(s)) bad.push(`${c.why}\n      剥后不应包含 ${JSON.stringify(s)}，实得：${JSON.stringify(got)}`)
    }
  }
  return bad
}

// ─────────────────────────────────────────────────────────────────────────────
// 断言
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

/** 所有断言都走这里 —— 失败行以 `✗` 开头。 */
function check(ok, label, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail ? `　→ ${detail}` : ''}`)
  }
}

/** 读文件；缺失时返回 null 并让调用方报红（不抛栈，便于在 CI 日志里一眼看出）。 */
function read(rel) {
  try {
    return readFileSync(join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const selfBad = selfTest()
  if (selfBad.length) {
    console.error('✗ 注释剥离自测未通过：')
    for (const b of selfBad) console.error(`  - ${b}`)
    return 1
  }
  console.log(`✅ 注释剥离自测通过 ${STRIP_CASES.length}/${STRIP_CASES.length}`)
  if (SELF_TEST) return 0

  const FILES = {
    plist: 'ios/App/App/Info.plist',
    cap: 'capacitor.config.ts',
    manifest: 'android/app/src/main/AndroidManifest.xml',
    eb: 'electron-builder.yml',
  }
  const raw = {}
  for (const [k, rel] of Object.entries(FILES)) raw[k] = read(rel)

  for (const [k, rel] of Object.entries(FILES)) {
    if (raw[k] === null) {
      check(false, `能找到 ${rel}`, '文件缺失 —— 后面针对它的检查无法进行')
    }
  }
  if (Object.values(raw).some((v) => v === null)) {
    console.log(`\n${failed} 项失败 / ${passed} 项通过`)
    return 1
  }

  const plist = stripXmlComments(raw.plist)
  const cap = stripTsComments(raw.cap)
  const manifest = stripXmlComments(raw.manifest)
  const eb = stripTsComments(raw.eb)

  // ── iOS Info.plist ──────────────────────────────────────────────────────
  check(
    /<key>\s*NSCameraUsageDescription\s*<\/key>/.test(plist),
    'iOS Info.plist 声明了 NSCameraUsageDescription',
    '缺了它：一开摄像头 iOS 会**直接终止进程**（不是权限被拒）',
  )
  check(
    !/<key>\s*NSMicrophoneUsageDescription\s*<\/key>/.test(plist),
    'iOS Info.plist **没有** NSMicrophoneUsageDescription（本项目不采音频）',
    '声明用不到的权限会平白多一道系统弹窗，App Store 审核也会追问',
  )

  // ── capacitor.config.ts ─────────────────────────────────────────────────
  check(
    /androidScheme\s*:\s*'https'/.test(cap),
    "capacitor.config.ts 的 androidScheme 是 'https'",
    "非 https 在 Android WebView 里不是安全上下文 ⇒ getUserMedia 不可用",
  )
  check(
    !/\biosScheme\b/.test(cap),
    'capacitor.config.ts **没有**设置 iosScheme',
    'iOS 上 https 被 WKWebView 保留给外部资源 ⇒ 本地页面根本加载不出来',
  )
  check(
    !/\bhostname\b/.test(cap),
    'capacitor.config.ts **没有**设置 hostname',
    'iOS 15.5–16 上带端口的自定义 scheme 会让 getUserMedia 报 AbortError',
  )
  check(
    /appId\s*:\s*'com\.neckguardian\.app'/.test(cap),
    "capacitor.config.ts 的 appId 是 'com.neckguardian.app'",
    '它同时是 Android 包名与 iOS BundleID，脱钩会让升级装不上',
  )

  // ── AndroidManifest.xml ─────────────────────────────────────────────────
  check(
    /android:name="android\.permission\.CAMERA"/.test(manifest),
    'AndroidManifest.xml 声明了 CAMERA 权限',
    '缺了它：WebView 的摄像头权限请求必然被拒',
  )
  check(
    /android:name="android\.permission\.INTERNET"/.test(manifest),
    'AndroidManifest.xml 声明了 INTERNET 权限',
    '缺了它：任何外部请求都会失败',
  )

  // ── electron-builder.yml（桌面 mac 的 Info.plist 由它生成） ──────────────
  check(
    /^[ \t]*NSCameraUsageDescription[ \t]*:/m.test(eb),
    'electron-builder.yml 为 macOS 声明了 NSCameraUsageDescription',
    '桌面端同样：缺了它一开摄像头进程就被终止',
  )
  check(
    /^[ \t]*NSMicrophoneUsageDescription[ \t]*:/m.test(eb),
    'electron-builder.yml 为 macOS 声明了 NSMicrophoneUsageDescription',
    '⚠️ 与 iOS **相反**：桌面语音提示需要它，删掉会静默失声',
  )

  console.log(`\n${passed} 项通过 / ${failed} 项失败`)
  return failed === 0 ? 0 : 1
}

process.exit(main())
