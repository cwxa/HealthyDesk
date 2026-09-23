#!/usr/bin/env node
/**
 * 同源校验：确认「打进安装包/APK 里的前端资源」就是「本次构建产出的 dist」。
 *
 * 为什么需要它
 * ------------
 * electron-builder / cap sync 都是"把 dist 拷进去再打包"。这一步一旦出问题
 * （比如 dist 是上一次构建残留、被别的分支覆盖、或者打包前忘了重新构建），
 * **打包会成功、产物能启动、日志全绿**，只是里面的前端是旧的。
 * 发布出去以后才发现功能对不上，且极难倒查。所以发布前要用内容哈希钉死。
 *
 * 为什么比对的是「打包中间产物」而不是「最终安装包」
 * ------------------------------------------------
 * electron-builder 打完包后保留了解包状态的应用目录，直接读它即可，
 * 不需要准备 7z / hdiutil / apktool 这类工具去拆 exe / dmg / apk。
 * dmg、zip、NSIS 都只是对同一份应用目录做压缩，内容不会变。
 *
 * 用法
 * ----
 *   node scripts/verify-same-source.mjs --packed=<打包后的 assets 目录> [--base=dist/assets]
 *
 * 各平台的 --packed 取值：
 *   Windows   release2/win-unpacked/resources/app/dist/assets
 *   macOS     release2/mac-<arch>/NeckGuardian.app/Contents/Resources/app/dist/assets
 *   Android   android/app/src/main/assets/public/assets
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const HINTS = [
  'Windows   release2/win-unpacked/resources/app/dist/assets',
  'macOS     release2/mac-<arch>/NeckGuardian.app/Contents/Resources/app/dist/assets',
  'Android   android/app/src/main/assets/public/assets',
]

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    if (m) out[m[1]] = m[2] === undefined ? true : m[2]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const packedDir = args.packed
const baseDir = args.base || path.join('dist', 'assets')

if (!packedDir) {
  console.error('用法: node scripts/verify-same-source.mjs --packed=<打包产物里的 assets 目录> [--base=dist/assets]')
  for (const h of HINTS) console.error('  ' + h)
  process.exit(2)
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** 递归收集 相对路径 → sha256 */
function walk(dir) {
  const out = new Map()
  if (!fs.existsSync(dir)) return out
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else out.set(path.relative(dir, p).split(path.sep).join('/'), sha256(p))
    }
  }
  return out
}

const packed = walk(packedDir)
const base = walk(baseDir)

if (packed.size === 0) {
  console.error(`::error::同源校验无法进行：${packedDir} 不存在或为空（路径不对？）`)
  console.error('  打包中间产物应位于以下之一：')
  for (const h of HINTS) console.error('    ' + h)
  process.exit(1)
}
if (base.size === 0) {
  console.error(`::error::同源校验无法进行：基准目录 ${baseDir} 不存在或为空（dist 没构建？）`)
  process.exit(1)
}

const changed = []
const missingInPacked = []
for (const [k, h] of base) {
  if (!packed.has(k)) missingInPacked.push(k)
  else if (packed.get(k) !== h) changed.push(k)
}
const extra = [...packed.keys()].filter((k) => !base.has(k))

if (changed.length || missingInPacked.length) {
  console.error('::error::同源校验失败：打包产物里的前端与 dist/ 不是同一份')
  console.error(`  基准 ${baseDir}：${base.size} 个文件`)
  console.error(`  产物 ${packedDir}：${packed.size} 个文件`)
  if (changed.length) {
    console.error(`  内容不一致 (${changed.length}):`)
    for (const k of changed.slice(0, 20)) {
      console.error(`    ${k}\n      产物 ${packed.get(k)}\n      dist ${base.get(k)}`)
    }
  }
  if (missingInPacked.length) {
    console.error(`  产物里缺失 (${missingInPacked.length}):`)
    for (const k of missingInPacked.slice(0, 20)) console.error(`    ${k}`)
  }
  process.exit(1)
}

console.log(`✅ 同源校验通过：${base.size} 个文件逐一 sha256 一致`)
console.log(`   基准 ${baseDir}`)
console.log(`   产物 ${packedDir}`)
if (extra.length) {
  // 打包过程可能额外塞入文件（例如 Android 的 cordova.js），只提示不判失败
  console.log(`   （产物另有 ${extra.length} 个非 dist 文件，已忽略：${extra.slice(0, 5).join(', ')}${extra.length > 5 ? ' …' : ''}）`)
}
