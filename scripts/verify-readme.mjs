#!/usr/bin/env node
/**
 * README 下载区守卫
 *
 * ## 为什么有这条守卫（2026-09-27 的决定）
 *
 * 下载表以前是**逐版本写死**的：
 *
 *     | Windows | [NeckGuardian Setup 1.6.2.exe](.../releases/download/v1.6.2/NeckGuardian.Setup.1.6.2.exe) | 188 MB | ... |
 *
 * 产物名和 URL 里都带版本号（`electron-builder.yml` 的三处 `artifactName` + CI 里
 * `NeckGuardian-$VER-android-$kind.apk`），于是**每发一版都要人工改 README** —— 漏了就是 404。
 * 历史上确实漏过、也漂过：2026-09-15 那版下载表里安卓指向 v1.3.4、Windows 指向 v1.3.1。
 * 体积（188 MB / 208 MB …）同样是每版都变的数字，写死了就是"展示无法证实的数字"。
 *
 * 现在改成**零维护**：下载区只放一个指向 Releases 页的入口 + "在 Assets 里找这个文件名"，
 * 不写任何具体版本号与体积（体积在 Release 页每个资产旁边就有）。
 * 本守卫就是这条决定的牙齿 —— 谁把逐版本链接或数字加回来，它就红。
 *
 * ## 🔴 为什么**不**用 `releases/latest/download/<稳定文件名>`
 *
 * 那条路要求产物名**去掉版本号**（`/releases/latest/download/` 必须逐字符匹配文件名）。
 * 实测过：拿稳定名去取当前的 latest，返回 **404**（因为已发布资产的旧名里带版本号）。
 * 它的好处是"永久链接"，代价是：
 *   1. 用户下载到的文件看不出是哪个版本；
 *   2. 要改四端产物命名（`electron-builder.yml` ×3 + CI ×1）并**重打全部产物**；
 *   3. 在"第一个稳定名版本被放行"之前，README 里的链接会 404（存在一个破窗期）。
 * 权衡后选了"只链 Release 页"：零维护、零风险、改完立即生效。
 * **将来若改走那条路，本守卫的 (a)/(b)/(c) 三条规则要跟着改，别直接删掉。**
 *
 * ## 检查项（每条都对应一个真会出问题的改法）
 *
 *   a) 下载区不出现 `releases/download/` —— 逐版本链接必然漂（当年就是这么漏的）
 *   b) 下载区不出现具体版本号（`1.6.2` / `v1.6.2`）
 *   c) 下载区不出现体积数字（`188 MB` / `16.9MB`）
 *   d) 下载入口**只有** `.../releases/latest`：不出现 `releases/tag/<tag>`（钉死在某个旧版本）
 *   e) 五个平台行都在（Windows / macOS arm64 / macOS x64 / Android / iPhone 占位）
 *   f) **反向对照（作用域）**：版本历史区**必须**仍有版本号。
 *      这条是给守卫自己照镜子的：如果分节逻辑坏掉（比如把"下载区"取成了全文），
 *      (b) 会因为历史表里的版本号而变红 —— 反过来，若有人把检查放宽成"不检查"，
 *      这条也会红。它保证 (a)–(e) 只作用于下载区，而不是把整篇 README 变成禁地。
 *      （与 `mutate-exercise-score.py` 的 M6 同一思路：闸门要有明确的射程。）
 *
 * 零依赖。`--file=<路径>` 可指定别的文件（变异测试用临时副本，不去动真 README）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'cwxa/HealthyDesk'
const RELEASES_LATEST = `https://github.com/${REPO}/releases/latest`

const args = process.argv.slice(2)
const fileArg = (args.find((a) => a.startsWith('--file=')) || '').replace('--file=', '') || 'README.md'
const target = path.isAbsolute(fileArg) ? fileArg : path.join(REPO_ROOT, fileArg)

let passed = 0
let failed = 0
/** 所有断言都走这里 —— 失败行以 `✗` 开头（变异脚本的期望关键词取自这些行）。 */
function check(ok, label, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}${detail ? `　→ ${detail}` : ''}`)
  }
}

/** 取某二级标题到下一个二级标题之间的内容（不含边界标题行）。 */
function section(text, headingKeyword) {
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l.startsWith('## ') && l.includes(headingKeyword))
  if (start < 0) return null
  let end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  if (end < 0) end = lines.length
  return { text: lines.slice(start + 1, end).join('\n'), from: start + 2, to: end }
}

console.log(`README 下载区守卫（文件：${path.relative(REPO_ROOT, target) || target}）`)
console.log('')

if (!fs.existsSync(target)) {
  console.log(`  ✗ 找不到文件：${target}`)
  process.exit(1)
}
const readme = fs.readFileSync(target, 'utf-8')

// ---------- 分节：下载区 ----------
const dl = section(readme, '下载')
check(dl !== null, 'README 里有「## …下载」这一节', '标题被改掉了？分节靠它')
const dlText = dl ? dl.text : ''
// 反向对照的前提：分节没切错。切错（比如切成了全文）会让后面几条断言失去意义。
check(dlText.length > 0 && dlText.split('\n').length >= 15 && dlText.length < readme.length / 2,
  '下载区分节正确（非空、且远小于全文）',
  `取到 ${dlText.length} 字符 / 全文 ${readme.length} 字符`)

// ---------- a) 逐版本链接 ----------
const versioned = dlText.match(/releases\/download\/[^\s)"']+/g) || []
check(versioned.length === 0, '下载区没有逐版本下载链接（releases/download/）',
  `发现 ${versioned.length} 条：${versioned.slice(0, 2).join(' , ')}`)

// ---------- b) 具体版本号 ----------
const versions = dlText.match(/\bv?\d+\.\d+\.\d+\b/g) || []
check(versions.length === 0, '下载区没有写死的版本号',
  `发现 ${versions.slice(0, 3).join(' , ')}　（版本号会随每次发版漂，改由 Releases 页承载）`)

// ---------- c) 体积数字 ----------
const sizes = dlText.match(/\b\d+(\.\d+)?\s?(MB|GB|KB)\b/g) || []
check(sizes.length === 0, '下载区没有写死的文件体积',
  `发现 ${sizes.slice(0, 3).join(' , ')}　（体积在 Release 页每个资产旁就有）`)

// ---------- d) 入口只指向 Releases 页 ----------
const latestHits = dlText.split(RELEASES_LATEST).length - 1
const tagHits = (dlText.match(/releases\/tag\//g) || []).length
check(latestHits === 1, `下载区有且仅有 1 个「最新版」入口（${RELEASES_LATEST}）`,
  `出现 ${latestHits} 次`)
check(tagHits === 0, '下载区没有钉死在某个 tag 的链接（releases/tag/）',
  `发现 ${tagHits} 条`)

// ---------- e) 五个平台行 ----------
// 文件名片段按 GitHub 上**实际显示**的形式写（资产名里的空白会被压成点，见 MULTIPLATFORM §9）。
const rows = [
  ['Windows', 'NeckGuardian.Setup.<版本>.exe'],
  ['macOS Apple 芯片', 'NeckGuardian-<版本>-mac-arm64.dmg'],
  ['macOS Intel', 'NeckGuardian-<版本>-mac-x64.dmg'],
  ['Android', 'NeckGuardian-<版本>-android-release.apk'],
]
for (const [label, filename] of rows) {
  check(dlText.includes(filename), `下载区列出了 ${label} 的资产名（${filename}）`,
    '这一行没了（或文件名写法变了，与 Release 上实际的资产名对不上）')
}
check(/\|\s*📱\s*\*\*iPhone \/ iPad\*\*/.test(dlText), '下载区保留了 iPhone / iPad 的占位行',
  'iOS 还没有可分发的安装包，这一行是在如实说明，不能悄悄删掉')

// ---------- f) 反向对照：历史表里的版本号必须还在 ----------
const history = section(readme, '版本历史')
const historyVersions = history ? (history.text.match(/\bv?\d+\.\d+\.\d+\b/g) || []) : []
check(historyVersions.length >= 5, '版本历史区仍保留着版本号（说明检查只作用于下载区）',
  `只找到 ${historyVersions.length} 个 —— 分节可能切错了，或历史表被删了`)

console.log('')
if (failed > 0) {
  console.log(`❌ README 下载区守卫：${failed} 项不符合约定（通过 ${passed} 项）`)
  console.log('   约定见本文件头部注释：下载区只放 Releases 页入口，不写版本号 / 体积 / 逐版本链接。')
  process.exit(1)
}
console.log(`✅ README 下载区守卫通过：${passed} 项断言`)
