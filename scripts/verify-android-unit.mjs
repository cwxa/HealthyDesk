#!/usr/bin/env node
/**
 * Android 原生层单元测试入口（纯 JVM：不需要设备、不需要模拟器、更不需要真机）。
 *
 * ── 为什么有这个脚本 ────────────────────────────────────────────────────────
 *
 * 项目原先的政策是「原生层只能靠真机验证」。但其中**有一条其实不需要真机**：
 * 安卓权限桥在「拒绝 → 关掉应用 → 重新打开 → 允许」路径下，「并发权限请求会不会
 * 互相覆盖、导致先到的那个既没 grant 也没 deny、前端 getUserMedia 永久挂起」
 * （v1.3.2「允许了权限却打不开」的机制）。
 *
 * 把这段收纳逻辑抽成**不依赖 Android 框架**的纯类（`CameraPermissionQueue`）之后，
 * 它可以用 JUnit 直接覆盖 —— 本脚本就是那个入口，替代掉原先「必须真机走」的那条。
 *
 * ── 为什么要在脚本里解析测试报告，而不是只看 gradle 退出码 ────────────────────
 *
 * 本项目吃过这个亏：**「命令退出 0」与「断言真的查过东西」是两件事**。
 * 一次配置漂移就能让测试任务「成功」地跑完 0 个用例（筛选写错、源码目录挪了、
 * `test` 任务被跳过……），退出码照样是 0。所以这里**强制读 JUnit XML 报告**，
 * 报出实际执行的用例数；一个都没跑 ⇒ 判定为失败。
 *
 * ── 「环境不足」与「被测对象错了」必须能分辨 ─────────────────────────────────
 *
 * 找不到 JDK / gradle 起不来 ⇒ 报 `环境不足`；用例真的失败 ⇒ 报 `测试失败` 并列出
 * 用例名。两者都退出非 0（**不静默跳过**），但原因一眼可辨 —— 否则一次 runner 环境
 * 抖动会被读成「代码坏了」，或反过来被读成「通过」。
 *
 * 用法：
 *   node scripts/verify-android-unit.mjs              # 正常跑
 *   node scripts/verify-android-unit.mjs --offline    # 不联网（依赖已在 gradle 缓存里）
 *   node scripts/verify-android-unit.mjs --self-test  # 只跑本脚本的报告解析自测
 *   node scripts/verify-android-unit.mjs --parse-only # 只解析「上一次跑出来的」报告，不执行测试
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ANDROID_DIR = join(ROOT, 'android')
const RESULTS_DIR = join(
  ANDROID_DIR,
  'app',
  'build',
  'test-results',
  'testDebugUnitTest',
)

const argv = process.argv.slice(2)
const SELF_TEST = argv.includes('--self-test')
const OFFLINE = argv.includes('--offline')
const PARSE_ONLY = argv.includes('--parse-only')

const EXE = process.platform === 'win32' ? '.exe' : ''

// ─────────────────────────────────────────────────────────────────────────────
// JUnit XML 报告解析（自写解析器 ⇒ 必须配自测，见 --self-test）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 解析一份 JUnit XML 报告。
 *
 * 只抓四件事：用例总数 / 失败数 / 错误数 / 失败的用例名。
 * 用正则而非 XML 库是刻意的 —— 本项目不引运行时依赖，而这几个字段的位置固定。
 *
 * @param {string} xml JUnit XML 文本
 * @returns {{tests:number, failures:number, errors:number, failedCases:string[]}}
 */
export function parseJUnitXml(xml) {
  const suite = /<testsuite\b[^>]*>/.exec(xml)
  const num = (name) => {
    if (!suite) return 0
    const m = new RegExp(`${name}="(\\d+)"`).exec(suite[0])
    return m ? Number(m[1]) : 0
  }

  const failedCases = []
  // 逐个 <testcase>，看它内部有没有 <failure> / <error>
  const caseRe = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g
  let m
  while ((m = caseRe.exec(xml)) !== null) {
    const attrs = m[1] || ''
    const body = m[3] || ''
    if (/<(failure|error)\b/.test(body)) {
      const name = /name="([^"]*)"/.exec(attrs)
      failedCases.push(name ? name[1] : '(未命名用例)')
    }
  }

  return {
    tests: num('tests'),
    failures: num('failures'),
    errors: num('errors'),
    failedCases,
  }
}

/** 汇总一个目录下的所有 TEST-*.xml。 */
function collectResults(dir) {
  let files
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('TEST-') && f.endsWith('.xml'))
  } catch {
    return null // 目录不存在 ⇒ 测试任务根本没产出报告
  }
  const total = { tests: 0, failures: 0, errors: 0, failedCases: [], files: files.length }
  for (const f of files) {
    const r = parseJUnitXml(readFileSync(join(dir, f), 'utf8'))
    total.tests += r.tests
    total.failures += r.failures
    total.errors += r.errors
    total.failedCases.push(...r.failedCases)
  }
  return total
}

// ─────────────────────────────────────────────────────────────────────────────
// 环境探测
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 找 JDK。
 *
 * 顺序：JAVA_HOME → 常见安装位置（含本项目开发机把 Android 工具链装在 E 盘的惯例）
 * → 放弃（由调用方报「环境不足」，不静默跳过）。
 */
function findJavaHome() {
  const ok = (home) => !!home && existsSync(join(home, 'bin', `javac${EXE}`))

  if (ok(process.env.JAVA_HOME)) return process.env.JAVA_HOME

  const bases = [
    // Windows
    'C:/Program Files/Eclipse Adoptium',
    'C:/Program Files/Java',
    'C:/Program Files/Microsoft',
    'E:/AndroidDev/jdk', // 本机开发环境（Android 工具链装在 E 盘以省 C 盘空间）
    // Linux / macOS
    '/usr/lib/jvm',
    '/Library/Java/JavaVirtualMachines',
  ]
  for (const base of bases) {
    if (!existsSync(base)) continue
    if (ok(base)) return base
    let subs = []
    try {
      subs = readdirSync(base)
        .map((d) => join(base, d))
        .filter(ok)
    } catch {
      continue // 目录不可读就换下一个
    }
    // 同族多个版本时取版本号最大者（目录名排序对 jdk-17.0.20.1 这类够用）
    if (subs.length) return subs.sort().reverse()[0]
  }
  return null
}

/**
 * 找 GRADLE_USER_HOME。
 *
 * 不设也能跑（gradle 会用 `~/.gradle` 并自行下载依赖），所以这里只在**已有缓存**时
 * 才显式指定 —— 目的是让「缓存装在别处」的机器（本机就是）不用每次重下依赖。
 */
function findGradleUserHome() {
  if (process.env.GRADLE_USER_HOME) return process.env.GRADLE_USER_HOME
  const dflt = join(homedir(), '.gradle')
  if (existsSync(dflt)) return dflt
  const alt = 'E:/AndroidDev/gradle-home' // 本机开发环境
  if (existsSync(alt)) return alt
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 自测：报告解析器（自写解析器必须配自测）
// ─────────────────────────────────────────────────────────────────────────────

const XML_CASES = [
  {
    why: '全绿：2 个用例，0 失败',
    xml: `<testsuite name="A" tests="2" skipped="0" failures="0" errors="0">
      <testcase name="ok1" classname="A"/>
      <testcase name="ok2" classname="A"/>
    </testsuite>`,
    want: { tests: 2, failures: 0, errors: 0, failedCases: [] },
  },
  {
    why: '一条 failure：必须点名到具体用例',
    xml: `<testsuite name="A" tests="2" skipped="0" failures="1" errors="0">
      <testcase name="good" classname="A"/>
      <testcase name="bad" classname="A"><failure>boom</failure></testcase>
    </testsuite>`,
    want: { tests: 2, failures: 1, errors: 0, failedCases: ['bad'] },
  },
  {
    why: '一条 error（异常）与 failure 同等对待',
    xml: `<testsuite name="A" tests="1" skipped="0" failures="0" errors="1">
      <testcase name="threw" classname="A"><error>NPE</error></testcase>
    </testsuite>`,
    want: { tests: 1, failures: 0, errors: 1, failedCases: ['threw'] },
  },
  {
    why: '自闭合的 testcase 不应被误判为失败',
    xml: `<testsuite name="A" tests="1" skipped="0" failures="0" errors="0">
      <testcase name="selfclosed" classname="A" time="0.01"/>
    </testsuite>`,
    want: { tests: 1, failures: 0, errors: 0, failedCases: [] },
  },
  {
    why: '🔴 空报告（跑了 0 个用例）：tests=0，调用方据此判失败',
    xml: `<testsuite name="A" tests="0" skipped="0" failures="0" errors="0"/>`,
    want: { tests: 0, failures: 0, errors: 0, failedCases: [] },
  },
  {
    why: '失败用例名里带尖括号内容时仍能取到 name',
    xml: `<testsuite name="A" tests="1" skipped="0" failures="1" errors="0">
      <testcase name="concurrentRequestsAllGetAnswered" classname="A">
        <failure message="expected 5 but was 1">at A.test</failure>
      </testcase>
    </testsuite>`,
    want: {
      tests: 1,
      failures: 1,
      errors: 0,
      failedCases: ['concurrentRequestsAllGetAnswered'],
    },
  },
]

function selfTest() {
  const bad = []
  for (const c of XML_CASES) {
    const got = parseJUnitXml(c.xml)
    const same =
      got.tests === c.want.tests &&
      got.failures === c.want.failures &&
      got.errors === c.want.errors &&
      JSON.stringify(got.failedCases) === JSON.stringify(c.want.failedCases)
    if (!same) {
      bad.push(
        `${c.why}\n      期望 ${JSON.stringify(c.want)}\n      实得 ${JSON.stringify({
          tests: got.tests,
          failures: got.failures,
          errors: got.errors,
          failedCases: got.failedCases,
        })}`,
      )
    }
  }
  return bad
}

// ─────────────────────────────────────────────────────────────────────────────
// 结果汇报
// ─────────────────────────────────────────────────────────────────────────────

/** gradle 输出只保留尾部若干行 —— 排查够用，又不至于把 CI 日志刷满。 */
function tailLines(text, n = 25) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .slice(-n)
    .map((l) => `    ${l}`)
    .join('\n')
}

/**
 * 汇总结果并输出，返回退出码。
 *
 * @param {object|null} results collectResults 的返回值
 * @param {boolean} executed 本次是否真的执行了测试（false ⇒ 输出必须标明）
 */
function reportResults(results, executed) {
  if (!results || results.files === 0) {
    console.error('✗ 没有找到 JUnit 报告 —— 测试没有跑起来，或报告路径变了。')
    return 1
  }

  // 🔴 关键：报告在、但一个用例都没跑 ⇒ 判定失败（不能只看 gradle 退出码）
  if (results.tests === 0) {
    console.error(`✗ 失败：产出了 ${results.files} 份报告，但**一个用例都没执行**。`)
    console.error('  这通常意味着源码目录或筛选配置漂了，而不是「通过」。')
    return 1
  }

  const failed = results.failures + results.errors
  if (failed > 0) {
    console.error(
      `✗ Android 单元测试失败：${results.tests} 个用例，${failed} 个未通过`,
    )
    for (const c of results.failedCases) console.error(`   - ${c}`)
    return 1
  }

  console.log(
    `${executed ? '✅' : '⚠️ [--parse-only]'} Android 单元测试通过：` +
      `${results.tests} 个用例 / ${results.files} 个测试类 / 0 失败`,
  )
  if (!executed) {
    console.log('   ⚠️ 本次**没有执行任何测试**，只是解析了上一次留下的报告 —— 别读成「跑过了」。')
  }
  return 0
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const selfBad = selfTest()
  if (selfBad.length) {
    console.error('✗ 报告解析自测未通过：')
    for (const b of selfBad) console.error(`  - ${b}`)
    return 1
  }
  console.log(`✅ 报告解析自测通过 ${XML_CASES.length}/${XML_CASES.length}`)
  if (SELF_TEST) return 0

  // 只复核既有报告。本机（Windows + 当前沙箱）没有 spawn 子进程的能力时的出口；
  // CI 不走这条 —— 那里必须真的执行测试。
  if (PARSE_ONLY) {
    return reportResults(collectResults(RESULTS_DIR), false)
  }

  const javaHome = findJavaHome()
  if (!javaHome) {
    console.error('✗ 环境不足：找不到 JDK（javac）。')
    console.error('  请设 JAVA_HOME 指向 JDK 17+ 后重试，例如：')
    console.error('    export JAVA_HOME=/e/AndroidDev/jdk/jdk-17.0.20.1+1   # Git Bash')
    return 1
  }

  const env = { ...process.env, JAVA_HOME: javaHome }
  const gradleHome = findGradleUserHome()
  if (gradleHome) env.GRADLE_USER_HOME = gradleHome

  // --console=plain：去掉进度条与颜色控制符，输出更适合在 CI 日志里读
  const args = [':app:testDebugUnitTest', '--console=plain']
  if (OFFLINE) args.push('--offline')

  console.log(`🔎 JDK             = ${javaHome}`)
  console.log(`🔎 GRADLE_USER_HOME = ${gradleHome ?? '(未设，用 gradle 默认位置)'}`)
  console.log(`▶ gradlew ${args.join(' ')}`)

  // 🔴 直接调 wrapper 的 Java 入口，**不走 `gradlew.bat` / `gradlew`**：
  //    ① Windows 上 Node 20+ 拒绝直接 spawn `.bat`（EINVAL，一处安全修复）；
  //    ② 退一步改走 shell 又会被本机安全策略拦（实测 EBUSY）。
  //    而 `gradlew` 脚本本身只是 `java -classpath gradle-wrapper.jar …GradleWrapperMain`
  //    的薄封装 —— 直接调它反而少一层平台差异：Linux 上走的是同一行。
  const wrapperJar = join(ANDROID_DIR, 'gradle', 'wrapper', 'gradle-wrapper.jar')
  if (!existsSync(wrapperJar)) {
    console.error(`✗ 环境不足：找不到 gradle wrapper jar（${wrapperJar}）。`)
    return 1
  }
  const run = spawnSync(
    join(javaHome, 'bin', `java${EXE}`),
    [
      '-Dorg.gradle.appname=gradlew',
      '-classpath',
      wrapperJar,
      'org.gradle.wrapper.GradleWrapperMain',
      ...args,
    ],
    { cwd: ANDROID_DIR, env, encoding: 'utf8' },
  )
  if (run.error) {
    console.error(`✗ 环境不足：无法启动 gradle wrapper —— ${run.error.message}`)
    return 1
  }

  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const results = collectResults(RESULTS_DIR)

  // 报告不存在 ⇒ 测试根本没跑起来（编译失败 / 任务被跳过 / 配置漂移）
  if (!results || results.files === 0) {
    console.error('✗ 环境不足或构建失败：没有产出 JUnit 报告。')
    console.error('  gradle 输出尾部：')
    console.error(tailLines(out))
    return 1
  }

  const code = reportResults(results, true)
  // gradle 非 0 但用例全绿 ⇒ 炸的是别的 task，把输出挂出来便于排查
  if (code !== 0 && results.failures + results.errors === 0) {
    console.error(`  （gradle 退出码 ${run.status}）输出尾部：`)
    console.error(tailLines(out))
  }
  return code
}

process.exit(main())
