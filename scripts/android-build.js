#!/usr/bin/env node
/**
 * 安卓命令行一键出包：前端构建 → cap sync → gradle assembleDebug。
 *
 * 工具链来源优先级（环境变量 > 默认位置 E:\AndroidDev）：
 *   JAVA_HOME            JDK 17
 *   ANDROID_HOME          Android SDK（含 platforms;android-34 / build-tools;34.0.0）
 *   GRADLE_USER_HOME      Gradle 缓存目录
 *   NECKGUARDIAN_DEV_ROOT 工具链根目录，默认 E:/AndroidDev
 *
 * 没装工具链也能用：只要有 Android Studio，把 ANDROID_HOME / JAVA_HOME 指过去，
 * 本脚本会自动改用工程自带的 gradlew。
 *
 * 用法：
 *   node scripts/android-build.js              # debug 包
 *   node scripts/android-build.js --release    # release 包（需自备签名配置）
 *   node scripts/android-build.js --skip-web   # 跳过前端构建，只跑 gradle
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const androidDir = path.join(root, 'android')
const isWin = process.platform === 'win32'
const args = process.argv.slice(2)
const wantRelease = args.includes('--release')
const skipWeb = args.includes('--skip-web')

const DEV_ROOT = process.env.NECKGUARDIAN_DEV_ROOT || 'E:/AndroidDev'

function exists(p) {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/** 在 dir 下找到唯一子目录（用于定位 jdk-17.x.x+x 这类带版本号的目录）。 */
function findSingleSubdir(dir) {
  if (!exists(dir)) return null
  const subs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(dir, d.name))
  return subs.length ? subs[0] : null
}

function resolveToolchain() {
  // JAVA_HOME：优先环境变量，其次 <DEV_ROOT>/jdk/<version>
  let javaHome = process.env.JAVA_HOME
  if (!javaHome || !exists(path.join(javaHome, 'bin', 'java.exe'))) {
    const candidate = findSingleSubdir(path.join(DEV_ROOT, 'jdk'))
    if (candidate && exists(path.join(candidate, 'bin', 'java.exe'))) javaHome = candidate
  }

  // ANDROID_HOME：优先环境变量，其次 <DEV_ROOT>/sdk
  let androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  if (!androidHome || !exists(path.join(androidHome, 'platforms'))) {
    const candidate = path.join(DEV_ROOT, 'sdk')
    if (exists(path.join(candidate, 'platforms'))) androidHome = candidate
  }

  const gradleUserHome =
    process.env.GRADLE_USER_HOME && exists(process.env.GRADLE_USER_HOME)
      ? process.env.GRADLE_USER_HOME
      : path.join(DEV_ROOT, 'gradle-home')

  // Gradle 可执行文件：本地发行版 > 工程自带 wrapper
  let gradleExe = null
  if (exists(DEV_ROOT)) {
    const dist = fs
      .readdirSync(DEV_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('gradle-'))
      .map((d) => path.join(DEV_ROOT, d.name))
      .sort()
      .pop()
    if (dist) {
      const candidate = path.join(dist, 'bin', isWin ? 'gradle.bat' : 'gradle')
      if (exists(candidate)) gradleExe = candidate
    }
  }
  if (!gradleExe) {
    const wrapper = path.join(androidDir, isWin ? 'gradlew.bat' : 'gradlew')
    if (exists(wrapper)) gradleExe = wrapper
  }

  return { javaHome, androidHome, gradleUserHome, gradleExe }
}

function fail(msg) {
  console.error(`\n[android-build] ${msg}\n`)
  process.exit(1)
}

const tc = resolveToolchain()

if (!tc.javaHome) {
  fail(
    '找不到 JDK。请设置 JAVA_HOME，或把 JDK 17 放到 ' +
      `${DEV_ROOT}/jdk/<版本目录>/ 下（见 docs/ANDROID_BUILD.md §2.2）。`
  )
}
if (!tc.androidHome) {
  fail(
    '找不到 Android SDK。请设置 ANDROID_HOME，或把 SDK 放到 ' +
      `${DEV_ROOT}/sdk/ 下（见 docs/ANDROID_BUILD.md §2.3）。`
  )
}
if (!tc.gradleExe) {
  fail(
    '找不到 Gradle。请在 android/ 下保留 gradlew，或把 Gradle 发行版解压到 ' +
      `${DEV_ROOT}/gradle-<版本>/ 下。`
  )
}

const env = {
  ...process.env,
  JAVA_HOME: tc.javaHome,
  ANDROID_HOME: tc.androidHome,
  ANDROID_SDK_ROOT: tc.androidHome,
  GRADLE_USER_HOME: tc.gradleUserHome,
  PATH: `${path.join(tc.javaHome, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
}

console.log('[android-build] 工具链')
console.log(`  JAVA_HOME        = ${tc.javaHome}`)
console.log(`  ANDROID_HOME     = ${tc.androidHome}`)
console.log(`  GRADLE_USER_HOME = ${tc.gradleUserHome}`)
console.log(`  gradle           = ${tc.gradleExe}`)

function run(cmd, cmdArgs, cwd, extraEnv = {}) {
  const r = spawnSync(cmd, cmdArgs, {
    cwd,
    stdio: 'inherit',
    shell: isWin,
    env: { ...env, ...extraEnv },
  })
  if (r.status !== 0) fail(`命令失败（退出码 ${r.status}）：${cmd} ${cmdArgs.join(' ')}`)
}

if (!skipWeb) {
  console.log('\n[android-build] 1/3 构建前端 + 暂存 MediaPipe 资源')
  run(process.execPath, [path.join(__dirname, 'cap-build.js')], root)

  console.log('\n[android-build] 2/3 同步进安卓工程')
  run(
    process.execPath,
    [path.join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'sync', 'android'],
    root
  )
}

const task = wantRelease ? 'assembleRelease' : 'assembleDebug'
console.log(`\n[android-build] 3/3 gradle ${task}`)
run(tc.gradleExe, ['--no-daemon', '--console=plain', task], androidDir)

const outDir = path.join(
  androidDir,
  'app',
  'build',
  'outputs',
  'apk',
  wantRelease ? 'release' : 'debug'
)
// 已配置签名时为 app-release.apk；未配置签名时 Gradle 产出 app-release-unsigned.apk
const candidates = wantRelease ? ['app-release.apk', 'app-release-unsigned.apk'] : ['app-debug.apk']
const apk = candidates.map((n) => path.join(outDir, n)).find(exists)

if (apk) {
  const mb = (fs.statSync(apk).size / 1048576).toFixed(1)
  console.log(`\n[android-build] ✅ 出包成功：${path.relative(root, apk)}  (${mb} MB)`)
  if (wantRelease && apk.endsWith('-unsigned.apk')) {
    console.log(
      '[android-build] ⚠️ 这是**未签名**包，不能分发。请在 android/keystore.properties ' +
        '配置签名后重跑（见 docs/ANDROID_BUILD.md §3.4）。'
    )
  }
} else {
  console.log(`\n[android-build] 构建已结束，但未找到预期产物：${path.relative(root, outDir)}`)
  console.log('                请检查该目录下的实际文件。')
}
