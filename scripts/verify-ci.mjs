#!/usr/bin/env node
/**
 * CI/CD 工作流守卫（`.github/workflows/build.yml`）
 *
 * ## 为什么有这条守卫（2026-09-29 引入分支模型时一起立的）
 *
 * 这个文件里的 `on:` / 各 job 的 `if:` / `concurrency` 决定了**什么会触发构建、什么会对外发布**。
 * 它是全仓库**唯一一处"改错了没有编译错误、也没有测试会红"的地方** —— 但它决定的事最贵：
 *
 *   - 把 `--draft` 去掉 → 之后每次打 tag 都**自动对外发布**，而四端真机通过行还是空的；
 *   - 把打包 job 的 `if:` 去掉 → 推 `main` 也烧四个 runner（钱），且主干提交混进产物；
 *   - 把 `release/**` 触发删掉 → "推发版分支就出包"这条流程**静默失效**，等到发版那天才发现；
 *   - 给 `verify` job 加 `if:` → 守门自己变成"有条件才跑"，而它正是用来兜住上面那些的。
 *
 * 所以本守卫盯的不是"YAML 合不合法"，而是**这几条语义还在不在**。
 *
 * ## 检查项（每条都对应一个真会出问题的改法）
 *
 *   1) `on.push.branches` 含 `main` —— 主干每次合入都要过守门
 *   2) 含 `release/**` —— 发版分支推上去要能出包
 *   3) 含 `feat/**` 与 `fix/**` —— 开发/修 bug 分支也要过守门
 *   4) `on.push.tags` 含 `v*` —— tag 仍能触发定稿构建
 *   5) `workflow_dispatch` 仍在（应急手动构建的口子）
 *   6) **四个打包 job 都带 `if:`**，且条件里同时有 `release/` 分支与 `tag` 与 `workflow_dispatch`
 *      —— 少一样，不是"某些触发不该打包"就是"该打包时不打包"
 *   7) `release` job 的 `if` 仍含 `refs/tags/v`
 *   8) `release` job 仍写 `--draft` —— 🔴 **闸门本身**，不许被悄悄改成自动发布
 *   9) `release` job 仍保留"**已发布的 Release 不许被分支构建覆盖**"的护栏，
 *      且断言的是**判断条件原文 + `exit 1`**（只查变量名的话，把条件掏空也抓不到）
 *   10) `concurrency.cancel-in-progress` 排除 tag —— tag 构建半路被取消会留下空壳 release
 *   11) **反向对照**：`verify` job **不许有 `if:`**（守门必须对所有触发无条件跑）。
 *       这条也是给守卫自己照镜子的：它证明前面几条读的是**各自的作用域**，
 *       而不是"拿全文随便 includes 一下"。
 *
 * ## 为什么是文本断言而不是 YAML 解析
 *
 * 与 `verify-readme.mjs` 同一取舍：守卫的**依赖越少，它自己坏掉的概率越低** ——
 * 守卫坏了会伪装成全绿。本仓库没有直接的 YAML 解析依赖（`node_modules/js-yaml` 是
 * 传递依赖，随时可能随上游消失），所以这里用**按缩进取块**的极小解析
 * （`subBlock`），断言落在"块内是否还有某一行"上，而不是对全文做子串搜索。
 * 断言有没有牙由 `.buildenv/mutate-ci.py`（C1–C8 + 负向对照）证明。
 *
 * 零依赖。`--file=<路径>` 可指定别的文件（变异测试用临时副本，不去动真文件）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const args = process.argv.slice(2)
const fileArg =
  (args.find((a) => a.startsWith('--file=')) || '').replace('--file=', '') ||
  '.github/workflows/build.yml'
const target = path.isAbsolute(fileArg) ? fileArg : path.join(REPO_ROOT, fileArg)

const SRC = fs.readFileSync(target, 'utf8')

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

/**
 * 按缩进取出一块。`indent` 是键本身所在列的缩进宽度。
 * 从 `^<indent>key:` 开始，到"缩进 ≤ indent 的第一个非空行"为止。
 * 空行照收（YAML 里的空行不影响块归属）。
 */
function subBlock(text, key, indent) {
  const prefix = ' '.repeat(indent)
  const lines = text.split('\n')
  const start = lines.findIndex((l) => l === `${prefix}${key}:`)
  if (start < 0) return null
  const out = [lines[start]]
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    if (l.trim() === '') {
      out.push(l)
      continue
    }
    const lead = l.length - l.trimStart().length
    if (lead <= indent) break
    out.push(l)
  }
  return out.join('\n')
}

/**
 * 取某块里 `if:` 的完整值（含 `>-` 折叠标量的续行）。
 * 找不到返回 `''`。`indent` 是 `if:` 所在列的缩进宽度。
 */
function ifOf(body, indent = 4) {
  const lines = body.split('\n')
  const key = `${' '.repeat(indent)}if:`
  // ⚠️ 不能要求整行等于 `if:` —— 折叠标量写法是 `if: >-`。只要求前缀对得上，
  //    且 `if:` 后面紧跟空格或行尾（免得匹配到 `iffy:` 这种同前缀的键）。
  const i = lines.findIndex(
    (l) => l.startsWith(key) && (l.length === key.length || l[key.length] === ' '),
  )
  if (i < 0) return ''
  const out = [lines[i]]
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]
    if (l.trim() === '') break
    if (l.length - l.trimStart().length <= indent) break
    out.push(l)
  }
  return out.join('\n')
}

const onBlock = subBlock(SRC, 'on', 0)
// 去掉引号再比，免得被 'main' / "main" 的写法差异绊倒。
const branches = (subBlock(onBlock || '', 'branches', 4) || '').replace(/['"]/g, '')
const tags = (subBlock(onBlock || '', 'tags', 4) || '').replace(/['"]/g, '')
const branchItems = branches
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean)

const PACKAGING_JOBS = ['desktop-windows', 'desktop-macos', 'mobile-android', 'mobile-ios']

console.log(`CI 工作流守卫 · ${path.relative(REPO_ROOT, target).replace(/\\/g, '/')}`)

// ── 触发条件 ────────────────────────────────────────────────────────────────
check(onBlock !== null, '1) 有 `on:` 块')
check(
  branchItems.includes('- main'),
  '1) 推 main 会触发（主干受守门）',
  `实际：${branchItems.join(' | ')}`,
)
check(branchItems.includes('- release/**'), '2) 推 release/** 会触发（发版分支出包）')
check(branchItems.includes('- feat/**'), '3) 推 feat/** 会触发（开发分支过守门）')
check(branchItems.includes('- fix/**'), '3) 推 fix/** 会触发（修 bug 分支过守门）')
check(
  tags.split('\n').map((l) => l.trim()).includes('- v*'),
  '4) 推 v* tag 会触发（定稿构建）',
)
check(/^ {2}workflow_dispatch:$/m.test(SRC), '5) 保留 workflow_dispatch（应急手动构建）')

// ── 打包 job 的启用条件 ─────────────────────────────────────────────────────
let missingIf = []
let badIf = []
for (const name of PACKAGING_JOBS) {
  const body = subBlock(SRC, name, 2)
  if (body === null) {
    missingIf.push(`${name}(找不到 job)`)
    continue
  }
  const ifLine = ifOf(body)
  if (!ifLine) {
    missingIf.push(name)
    continue
  }
  const need = ['refs/heads/release/', 'refs/tags/v', 'workflow_dispatch']
  const lack = need.filter((k) => !ifLine.includes(k))
  if (lack.length) badIf.push(`${name}(缺 ${lack.join('/')})`)
}
// 🔴 合成**一条**断言：拆成"有没有 if"和"if 内容对不对"两条的话，前者不满足时后者会因为
//    没进循环而**空转通过**（打出一个 ✓），正是本项目最忌讳的假绿。
const pkgProblems = [...missingIf.map((n) => `无 if：${n}`), ...badIf]
check(
  pkgProblems.length === 0,
  '6) 四个打包 job 的 if: 齐备，且条件 = release 分支 / tag / 手动',
  pkgProblems.join(' '),
)

// ── release job：闸门 ──────────────────────────────────────────────────────
const releaseJob = subBlock(SRC, 'release', 2) || ''
const releaseIf = ifOf(releaseJob)
check(releaseIf.includes('refs/tags/v'), '7) release job 仍由 tag 触发')
check(releaseIf.includes('refs/heads/release/'), '7) release job 也由 release 分支触发')
// ⚠️ 不能只查 `includes('--draft')`：Summary 里那句提示
//    `gh release edit <tag> --draft=false --latest` 也含这个子串，于是**删掉真正的
//    `--draft` 参数守卫照样绿**（变异 C5 实测抓不到 —— 这就是"断言写在注释上"的形态）。
//    要查的是「有一行**整体就是** `--draft` 这个参数」（允许行尾的续行反斜杠）。
const draftArgs = releaseJob
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => /^--draft(\s*\\)?$/.test(l))
check(
  draftArgs.length === 1,
  '8) release job 仍只创建 draft（🔴 闸门：不许自动对外发布）',
  `找到 ${draftArgs.length} 处 \`--draft\` 参数（应为 1）—— 去掉它等于把"构建成功"当"能用"直接推到用户面前`,
)
check(
  releaseJob.includes('[ "$IS_DRAFT" != "true" ]') &&
    releaseJob.includes('[ "$FROM_TAG" != "1" ]') &&
    releaseJob.includes('exit 1'),
  '9) 分支构建拒绝覆盖已发布的 Release（判断条件 + 非零退出都在）',
  '缺 isDraft/fromTag 判断、或少了 exit 1 → 推 release/v<已发布版本> 会把线上资产冲掉',
)

// ── 并发：tag 不许被取消 ────────────────────────────────────────────────────
const conc = subBlock(SRC, 'concurrency', 0) || ''
check(
  conc.includes('refs/tags/'),
  '10) tag 构建不被后来的推送取消（半路取消会留下空壳 release）',
  `实际 cancel-in-progress：${(conc.match(/cancel-in-progress:[\s\S]*/) || [''])[0].trim()}`,
)

// ── 反向对照 ───────────────────────────────────────────────────────────────
const verifyJob = subBlock(SRC, 'verify', 2) || ''
check(
  verifyJob !== '' && ifOf(verifyJob) === '',
  '11) 反向对照：verify job 没有任何 `if:`（守门必须无条件跑）',
  '给守门加 if 等于让"兜底的那一道"变成有条件的 —— 它一失效，上面几条都没人看了',
)

console.log(`\n共 ${passed + failed} 项断言：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  console.log('✗ CI 工作流守卫未通过')
  process.exit(1)
}
console.log('✓ CI 工作流守卫通过')
