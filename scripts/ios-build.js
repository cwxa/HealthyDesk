#!/usr/bin/env node
/**
 * iOS 一键出包（前端构建 → cap sync ios → pod install → xcodebuild archive）。
 *
 * 🔴 **只能在 macOS 上运行。** iOS 的编译链（Xcode / clang / 代码签名 / CocoaPods）
 * 没有 Windows 或 Linux 版本，这不是"配置问题"，是平台本身的约束。
 * 在非 macOS 上运行本脚本会**立即退出并说明原因**，不会留下半成品工程。
 *
 * 在没有 Mac 的情况下要出 iOS 包，走 CI：
 *   .github/workflows/build.yml 的 `mobile-ios` 任务（GitHub 的 macOS runner）。
 *
 * 前置条件（macOS）：
 *   - Xcode（含 Command Line Tools）：`xcode-select --install`
 *   - CocoaPods：`sudo gem install cocoapods`
 *   - 真机分发还需要一个 Apple 开发者账号与签名证书（见 docs/MULTIPLATFORM.md）
 *
 * 用法：
 *   node scripts/ios-build.js               # 归档（未签名，用于验证可编译）
 *   node scripts/ios-build.js --export      # 归档并导出 IPA（需要签名配置）
 *   node scripts/ios-build.js --skip-web    # 跳过前端构建，只跑 Xcode
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const iosAppDir = path.join(root, 'ios', 'App')
const args = process.argv.slice(2)
const skipWeb = args.includes('--skip-web')
const wantExport = args.includes('--export')

const SCHEME = 'App'
const ARCHIVE_PATH = path.join(root, 'release2', 'ios', 'NeckGuardian.xcarchive')
const EXPORT_PATH = path.join(root, 'release2', 'ios', 'export')

function fail(msg) {
  console.error(`\n[ios-build] ✗ ${msg}\n`)
  process.exit(1)
}

function run(cmd, cmdArgs, cwd = root, extraEnv = {}) {
  console.log(`\n[ios-build] $ ${cmd} ${cmdArgs.join(' ')}`)
  const r = spawnSync(cmd, cmdArgs, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  if (r.error) fail(`无法执行 ${cmd}：${r.error.message}`)
  if (r.status !== 0) fail(`命令失败（退出码 ${r.status}）：${cmd} ${cmdArgs.join(' ')}`)
}

function has(cmd) {
  const r = spawnSync('which', [cmd], { stdio: 'ignore' })
  return r.status === 0
}

// ---- 平台闸门：先把"跑不了"这件事说清楚，别让用户对着莫名其妙的报错排查 ----
if (process.platform !== 'darwin') {
  fail(
    `iOS 构建只能在 macOS 上进行，当前系统是 ${process.platform}。\n` +
      `        Xcode / clang / iOS 代码签名都没有非 macOS 的实现，无法绕过。\n` +
      `        替代方案：推送到 GitHub 后由 CI 的 macOS runner 构建\n` +
      `        （见 .github/workflows/build.yml 的 mobile-ios 任务）。`,
  )
}

// ---- 依赖检查 ----
if (!has('xcodebuild')) fail('找不到 xcodebuild，请先安装 Xcode 并执行 `xcode-select --install`。')
if (!has('pod')) fail('找不到 CocoaPods，请执行 `sudo gem install cocoapods`。')
if (!fs.existsSync(iosAppDir)) {
  fail('ios/ 工程不存在。请先在项目根执行 `npx cap add ios`。')
}

// ---- 1. 前端构建 + MediaPipe 资源暂存 ----
if (!skipWeb) {
  console.log('[ios-build] 1/4 构建前端 + 暂存 MediaPipe 资源')
  run(process.execPath, [path.join(__dirname, 'cap-build.js')], root)
} else {
  console.log('[ios-build] 1/4 跳过前端构建（--skip-web）')
}

// ---- 2. 同步进 iOS 工程 ----
// ⚠️ 必须走 cap sync：它把 dist/ 拷进 ios/App/App/public/，
// 同时更新 capacitor.config.json 与 Podfile 里的插件列表。
console.log('[ios-build] 2/4 cap sync ios')
run(
  process.execPath,
  [path.join(root, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor'), 'sync', 'ios'],
  root,
)

// ---- 3. CocoaPods ----
console.log('[ios-build] 3/4 pod install')
run('pod', ['install', '--repo-update'], iosAppDir)

// ---- 4. 归档 ----
fs.mkdirSync(path.dirname(ARCHIVE_PATH), { recursive: true })
const archiveArgs = [
  '-workspace',
  'App.xcworkspace',
  '-scheme',
  SCHEME,
  '-configuration',
  'Release',
  '-destination',
  'generic/platform=iOS',
  '-archivePath',
  ARCHIVE_PATH,
  'archive',
]

if (!wantExport) {
  // 未签名归档：用于验证"代码能编译、能归档"，产物不能直接装到设备上。
  // 这样 CI 在没有证书的情况下也能跑通并给出可检查的产物。
  archiveArgs.push('CODE_SIGNING_ALLOWED=NO', 'CODE_SIGN_IDENTITY=""', 'CODE_SIGNING_REQUIRED=NO')
}

console.log('[ios-build] 4/4 xcodebuild archive')
// 🔴 cwd 必须是 ios/App：`-workspace App.xcworkspace` 是**相对路径**，
// 在仓库根跑会报 `xcodebuild: error: 'App.xcworkspace' does not exist.`（2026-09-23 CI 实测踩到）。
run('xcodebuild', archiveArgs, iosAppDir)

if (!wantExport) {
  console.log(
    `\n[ios-build] ✅ 未签名归档完成：${path.relative(root, ARCHIVE_PATH)}\n` +
      `            这是**未签名**产物，不能安装到设备，仅用于验证 iOS 目标可编译。\n` +
      `            要出可安装的 IPA，请配置签名后用 --export（见 docs/MULTIPLATFORM.md §iOS 签名）。`,
  )
  process.exit(0)
}

// ---- 可选：导出 IPA ----
const exportOpts = path.join(root, 'ios', 'ExportOptions.plist')
if (!fs.existsSync(exportOpts)) {
  fail(
    `--export 需要 ${path.relative(root, exportOpts)}（签名方式、Team ID、分发渠道）。\n` +
      `        可从 Xcode 的 Organizer 里导出一次生成，或参考 docs/MULTIPLATFORM.md。`,
  )
}

fs.mkdirSync(EXPORT_PATH, { recursive: true })
console.log('[ios-build] 导出 IPA')
run('xcodebuild', [
  '-exportArchive',
  '-archivePath',
  ARCHIVE_PATH,
  '-exportPath',
  EXPORT_PATH,
  '-exportOptionsPlist',
  exportOpts,
])

const ipa = fs
  .readdirSync(EXPORT_PATH)
  .filter((f) => f.endsWith('.ipa'))
  .map((f) => path.join(EXPORT_PATH, f))[0]
if (ipa) {
  const mb = (fs.statSync(ipa).size / 1048576).toFixed(1)
  console.log(`\n[ios-build] ✅ IPA：${path.relative(root, ipa)}  (${mb} MB)`)
} else {
  console.log(`\n[ios-build] 构建结束但未找到 .ipa，请检查 ${path.relative(root, EXPORT_PATH)}`)
}
