#!/usr/bin/env node
/**
 * 校验内置的 Python 后端可执行文件「格式与架构」是否与目标平台匹配。
 *
 * 为什么需要它
 * ------------
 * `build/neckguardian-backend/` 里是 PyInstaller 的产物，**按平台编译、不可跨平台复用**：
 *   Windows → PE (`.exe`)   macOS → Mach-O   Linux → ELF
 *
 * 而 `electron-builder.yml` 里这份产物是通过 `extraResources` 直接塞进安装包的。
 * 一旦在 Windows 上执行 `electron-builder --mac`，构建**会成功**，但 .app 里躺着
 * 一个 Windows 可执行文件 —— 表现为「装上了、图标在、打开就卡在正在启动服务…」，
 * 而且因为构建日志全绿，极难定位。
 *
 * 本脚本在读文件头（magic bytes）层面把这件事拦在打包之前。
 *
 * 用法：
 *   node scripts/verify-backend-binary.js                 # 期望当前宿主平台
 *   node scripts/verify-backend-binary.js --target=mac    # 期望 macOS
 *   node scripts/verify-backend-binary.js --target=win --arch=arm64
 *
 * 退出码：0 通过；1 不通过（格式/架构不符或产物缺失）。
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const BIN_DIR = path.join(root, 'build', 'neckguardian-backend')

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(a)
    if (m) out[m[1]] = m[2]
  }
  return out
}

const PLATFORM_ALIASES = {
  win: 'win32',
  win32: 'win32',
  windows: 'win32',
  mac: 'darwin',
  macos: 'darwin',
  darwin: 'darwin',
  linux: 'linux',
}

/** 读当前目录下存在的后端可执行文件（Windows 带 .exe，其余平台无扩展名）。 */
function locateBinary() {
  if (!fs.existsSync(BIN_DIR)) return null
  for (const name of ['neckguardian-backend.exe', 'neckguardian-backend']) {
    const p = path.join(BIN_DIR, name)
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  }
  return null
}

/** 从文件头判定可执行格式。 */
function detectFormat(buf) {
  if (buf.length >= 2 && buf[0] === 0x4d && buf[1] === 0x5a) {
    // 'MZ' → PE，再去 e_lfanew 处确认 PE 签名
    const peOff = buf.readUInt32LE(0x3c)
    if (buf.length >= peOff + 4 && buf.toString('ascii', peOff, peOff + 4) === 'PE\u0000\u0000') {
      return { format: 'pe', headerOffset: peOff }
    }
    return { format: 'pe', headerOffset: null }
  }
  if (buf.length >= 4 && buf[0] === 0x7f && buf.toString('ascii', 1, 4) === 'ELF') {
    return { format: 'elf', headerOffset: 0 }
  }
  const be = buf.readUInt32BE(0)
  const le = buf.readUInt32LE(0)
  if (be === 0xcafebabe || be === 0xbebafeca) return { format: 'macho-fat', headerOffset: 0 }
  // 64 位 Mach-O：磁盘上是 CF FA ED FE，按小端读即 0xfeedfacf
  if (le === 0xfeedfacf || le === 0xfeedface) return { format: 'macho', headerOffset: 0 }
  return { format: 'unknown', headerOffset: null }
}

/** 细读架构（PE Machine / Mach-O cputype / ELF e_machine）。 */
function detectArch(buf, info) {
  if (info.format === 'pe' && info.headerOffset !== null) {
    const machine = buf.readUInt16LE(info.headerOffset + 4)
    return { 0x8664: 'x64', 0xaa64: 'arm64', 0x014c: 'ia32' }[machine] ?? `machine:0x${machine.toString(16)}`
  }
  if (info.format === 'macho') {
    const cputype = buf.readUInt32LE(4)
    return { 0x01000007: 'x64', 0x0100000c: 'arm64', 0x00000007: 'ia32' }[cputype] ?? `cputype:0x${cputype.toString(16)}`
  }
  if (info.format === 'elf') {
    const machine = buf.readUInt16LE(18)
    return { 0x3e: 'x64', 0xb7: 'arm64', 0x03: 'ia32' }[machine] ?? `e_machine:0x${machine.toString(16)}`
  }
  return null
}

/** 格式 → 平台。 */
const FORMAT_TO_PLATFORM = { pe: 'win32', macho: 'darwin', 'macho-fat': 'darwin', elf: 'linux' }

const PLATFORM_LABEL = { win32: 'Windows (PE)', darwin: 'macOS (Mach-O)', linux: 'Linux (ELF)' }

function main() {
  const args = parseArgs(process.argv.slice(2))
  const target = PLATFORM_ALIASES[args.target] ?? process.platform
  const wantArch = args.arch ?? null

  const bin = locateBinary()
  if (!bin) {
    console.error(
      `\n✗ 找不到后端可执行文件。\n` +
        `  期望位置：build/neckguardian-backend/neckguardian-backend[.exe]\n` +
        `  请先执行 npm run backend:build（必须在**目标平台**上构建）。\n`,
    )
    process.exit(1)
  }

  const name = path.basename(bin)
  const buf = fs.readFileSync(bin)
  const info = detectFormat(buf)
  const arch = detectArch(buf, info)
  const actualPlatform = FORMAT_TO_PLATFORM[info.format] ?? null

  console.log(`[verify-backend] 文件：${path.relative(root, bin)}（${(buf.length / 1048576).toFixed(1)} MB）`)
  console.log(`[verify-backend] 实测：${info.format}${arch ? ` / ${arch}` : ''}`)
  console.log(`[verify-backend] 期望：${PLATFORM_LABEL[target] ?? target}${wantArch ? ` / ${wantArch}` : ''}`)

  let failed = false

  if (actualPlatform !== target) {
    console.error(
      `\n✗ 后端可执行文件格式与目标平台不匹配！\n` +
        `  产物是 ${actualPlatform ? PLATFORM_LABEL[actualPlatform] : info.format}，` +
        `但目标是 ${PLATFORM_LABEL[target] ?? target}。\n` +
        `  这种包构建不会报错，但装到目标机器后后端一定起不来。\n` +
        `  请在 ${PLATFORM_LABEL[target] ?? target} 的机器上重新执行 npm run backend:build。\n`,
    )
    failed = true
  }

  if (wantArch && arch && arch !== wantArch) {
    console.error(
      `\n✗ 后端可执行文件架构不符：产物 ${arch}，目标 ${wantArch}。\n` +
        `  （Apple Silicon 需要 arm64 产物，Intel Mac 需要 x64。）\n`,
    )
    failed = true
  }

  // 提醒：PyInstaller 验证运行会写入含测试数据的 data/，不应跟着安装包发出去
  const dataDir = path.join(BIN_DIR, 'data')
  if (fs.existsSync(dataDir)) {
    console.warn(
      `\n⚠️ ${path.relative(root, dataDir)} 存在 —— 里面是验证运行时写入的数据库。\n` +
        `   出包前请删除：rm -rf build/neckguardian-backend/data\n`,
    )
  }

  if (failed) process.exit(1)
  console.log('[verify-backend] ✓ 后端产物与目标平台匹配')
}

main()
