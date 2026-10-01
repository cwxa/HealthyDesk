#!/usr/bin/env node
/**
 * CI/CD 工作流守卫（`.github/workflows/build.yml`）
 *
 * ## 为什么有这条守卫（2026-09-29 引入分支模型时一起立的）
 *
 * 这个文件里的 `on:` / 各 job 的 `if:` / `concurrency` 决定了**什么会触发构建、什么会对外发布**。
 * 它是全仓库**唯一一处"改错了没有编译错误、也没有测试会红"的地方** —— 但它决定的事最贵：
 *
 *   - 把 `--draft` 去掉 → 之后每次打 tag 都**自动对外发布**，而残余风险台账里还有未处置项；
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
 *   10b) `cancel-in-progress` 必须是 `${{ }}` 表达式或布尔字面量。
 *       🔴 2026-09-29 实测踩到：写成折叠标量（`>-` + 裸表达式）时**本地 YAML 解析完全正常**，
 *       但 GitHub 拒掉**整个工作流文件** —— 推上去的 run 里**一个 job 都没有**。
 *       `if:` 可以省略 `${{ }}` 是它**专属**的例外，别的字段不适用。
 *   11) **反向对照**：`verify` job **不许有 `if:`**（守门必须对所有触发无条件跑）。
 *       这条也是给守卫自己照镜子的：它证明前面几条读的是**各自的作用域**，
 *       而不是"拿全文随便 includes 一下"。
 *
 *   ── 下面这批是 2026-09-29 第二轮审计补的（每一条都对应一个"真会出事、且没人会注意到"的改法）──
 *
 *   12) **每个 job 都有 `timeout-minutes`** —— 不设的话挂住的 job 会烧到默认上限（6 小时），
 *       而挂起比失败贵得多、也没有提示。本项目**真的发生过**：退役的 runner 标签让 job
 *       既不报错也不失败地永远排队（macos-13）；electron-builder 退避重试；后端冒烟 60 次轮询。
 *   13) **`verify:all` 里的每一项都必须出现在 CI 的 `verify` job 里**（交叉一致性）。
 *       往 `verify:all` 加了新守卫却忘了加进 CI → **CI 永绿、只有本地会红**，
 *       而这正是"合进主干时没人拦"的形态。反向也提醒：CI 单独多跑的几步是**有意的**。
 *   14) `release` job 在上传之后**回读校验资产**（数量轮询 + SHA256SUMS 名字与线上逐字对拍）。
 *       `gh release create/upload` 返回 0 **不等于**资产已可查；且 GitHub 会改写资产名里的
 *       连续空白 —— 校验文件照抄本地名就会变成一份**用户跑不通**的校验文件。
 *   15) `concurrency.group` **把 tag 归一化到同名 release 分支**。
 *       `release/v1.7.0` 与 `v1.7.0` 是两个不同 ref → 按 `github.ref` 分组会落进不同组、
 *       **并发**写同一个 Release（一个 create、一个 upload --clobber）。
 *   16) **四个打包 job 都有同源校验**（`verify:source`）—— 少了哪个，那个端就能装进旧前端。
 *   16b) `release` job 的**「分支名 → 版本」解析容忍可选的 `v`**。
 *       🔴 2026-09-29 release 分支链路**第一次实跑**就死在这一步：四个端的包都构建好了，
 *       最后一步 `TAG="v${GITHUB_REF_NAME#release/}"` 把 `release/v1.7.0` 拼成 **`vv1.7.0`**，
 *       比对基准变成 `v1.7.0` ≠ `1.7.0` ⇒ `exit 1`、**一个资产都发不出去**。
 *       （分支名带 `v` 是文档与建模的约定，也是断言 15 能把 tag 归一化到同一并发组的前提。）
 *   17) **Windows 与 macOS 都有后端启动冒烟**（跑包内后端、等 `/api/health` 且 status=ok）。
 *       静态校验（格式 / 哈希）推不出"起得来"；Windows 是主力分发平台，尤其不能少。
 *
 * ## ⚠️ 本守卫的射程边界（如实记下）
 *
 * 它能查的是**"这些语义还在不在"**，查不了"GitHub 认不认这个文件"。
 * 这个边界已经被**实测踩过两次**，两条断言都是事故之后才补的：
 *   - 10b：`cancel-in-progress` 写折叠标量 → GitHub 拒掉**整个工作流文件**，本地 YAML 正常；
 *   - 15 ：`replace()` 在 GitHub 表达式里**根本不存在** → actionlint 报
 *          `undefined function "replace"`，而本地 YAML 依旧完全正常。
 * **改完 `build.yml` 请务必再用 `actionlint` 过一遍**（GitHub Actions 的语义校验器，
 * 能抓 `${{ }}` 写法、**函数名是否存在**、context 名拼错、`needs` 指向不存在的 job 等一整类问题）：
 *
 * ```bash
 * gh release download v1.7.12 -R rhysd/actionlint -p 'actionlint_*_windows_amd64.zip' -D .buildenv/actionlint
 * (cd .buildenv/actionlint && unzip -o -q actionlint_*_windows_amd64.zip)
 * .buildenv/actionlint/actionlint.exe .github/workflows/build.yml
 * ```
 *
 * 没把它接进 CI：那会给守门引入一个**需要联网下载的二进制依赖**，
 * 而本项目的取舍是"守卫的依赖越少越不容易自己坏掉"（见 `verify-readme.mjs` 同一段取舍）。
 *
 * ## 🔴 一类失效：断言"落在错误的作用域上"（与射程无关，靠变异才能发现）
 *
 * 射程边界说的是"守卫查不了什么"；这里说的是"守卫**以为**自己在查、其实没查"。
 * 形态是**子串/块级 includes 被别处的文本满足**，本仓库已经踩过两次：
 *
 *   - 第 8 条：查 `includes('--draft')`，而被 Summary 里的 `--draft=false` 满足；
 *   - 第 10 条：查 `conc.includes('refs/tags/')`，而 `concurrency` 块里的 **`group:` 行**
 *     （归一化表达式自带 `refs/tags/`）就满足了它 —— 于是 `cancel-in-progress` 改回恒真也照样绿。
 *
 * 规律：**断言的范围越宽，越容易被范围里的"别的正确东西"满足**。
 * 所以本守卫一律走"先按缩进取块、再取到具体那一行/那个参数"的路子 ——
 * 而**只有变异测试能证明这一条做到了**：每条断言都要有能把它打红的变异。
 *
 * ## 🔴 还有第三类：**工作流里的逻辑本身就写错了**（射程与作用域都没问题）
 *
 * 16b 就是这一类：断言"读哪一行"完全正确，错的是**那一行自己的表达式**。
 * 它只有靠**真的跑一次**才会暴露 —— 本地 `yaml.load()` 与 `actionlint` 都是绿的，
 * 因为 `v${GITHUB_REF_NAME#release/}` 语法上无懈可击，只是**语义**错了。
 * 教训：**"流程写下来" ≠ "流程跑通过"**。本项目在 `BRANCHING.md` 的"首次生效记录"里
 * 只敢写"推 `main` 已验证、`release/**` 与 `tag` 两条链路**仍未实跑**"——
 * 一天后首次实跑，**第一条就死在 release 分支上**（正是这一条）。
 * 补上守卫的意义：**它不会第二次坏**。
 *
 * ## 为什么是文本断言而不是 YAML 解析
 *
 * 与 `verify-readme.mjs` 同一取舍：守卫的**依赖越少，它自己坏掉的概率越低** ——
 * 守卫坏了会伪装成全绿。本仓库没有直接的 YAML 解析依赖（`node_modules/js-yaml` 是
 * 传递依赖，随时可能随上游消失），所以这里用**按缩进取块**的极小解析
 * （`subBlock`），断言落在"块内是否还有某一行"上，而不是对全文做子串搜索。
 * 断言有没有牙由 `.buildenv/mutate-ci.py`（C1–C15 全须被抓住 + N1/N2 负向对照须保持绿）证明。
 * 🔴 变异测试**真的抓到过两条守卫自身的缺陷**，都不是"猜"出来的：
 *    - 第 8 条：`includes('--draft')` 被子串 `--draft=false` 满足（断言落在**注释上**）；
 *    - 第 10 条：`conc.includes('refs/tags/')` 被 `group:` 那一行满足（断言落在**错误的块上**）。
 *    两次都是"守卫看起来在盯，其实盯错了地方"—— 所以**改完断言必须重跑变异**，
 *    而且要有一条负向对照证明它不过敏。
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
// 🔴 断言必须落在 `cancel-in-progress` 的**取值**上，**不能**落在整个 `concurrency` 块上。
//    2026-09-29 第二轮审计时 `group:` 被改成带 `refs/tags/` 的表达式，于是
//    "块内出现过 refs/tags/" 被 **group 行**满足 —— 把 `cancel-in-progress` 改回恒真，
//    守卫照样绿（变异 C7 实测抓不到）。这是"断言写在**错误的作用域**上"的形态：
//    与第 8 条（`--draft` 被子串 `--draft=false` 满足）是同一类错误，只是从"行内"升到了"块内"。
const conc = subBlock(SRC, 'concurrency', 0) || ''
const cancelVal = ((conc.match(/^ {2}cancel-in-progress:(.*)$/m) || [])[1] || '').trim()
check(
  cancelVal.includes('refs/tags/'),
  '10) tag 构建不被后来的推送取消（半路取消会留下空壳 release）',
  `实际 cancel-in-progress：${cancelVal || '(空)'} —— 判断必须落在这一行上，不是整个 concurrency 块`,
)

// 🔴 实测踩到（2026-09-29）：`cancel-in-progress` 写成折叠标量（`>-` + 裸表达式）时，
//    本地 `yaml.load()` **完全正常**，但 GitHub 会拒掉**整个工作流文件** ——
//    推上去的 run 里**一个 job 都没有**，页面只说 "workflow file issue"。
//    原因：该字段只接受**单个 `${{...}}` 表达式或布尔字面量**，
//    **不适用 `if:` 那种"可以省略 `${{ }}`"的例外**（那是 `if` 专属）。
//    这条断言就是那次事故的牙齿。
check(
  /^\$\{\{[\s\S]*\}\}$/.test(cancelVal) || cancelVal === 'true' || cancelVal === 'false',
  '10b) cancel-in-progress 是 `${{ }}` 表达式或布尔字面量（裸文本会被 GitHub 拒掉整个文件）',
  `实际：${cancelVal || '(空)'} —— 必须包 ${{ }}，别写折叠标量`,
)

// ── 反向对照 ───────────────────────────────────────────────────────────────
const verifyJob = subBlock(SRC, 'verify', 2) || ''
check(
  verifyJob !== '' && ifOf(verifyJob) === '',
  '11) 反向对照：verify job 没有任何 `if:`（守门必须无条件跑）',
  '给守门加 if 等于让"兜底的那一道"变成有条件的 —— 它一失效，上面几条都没人看了',
)

// ── 12) 每个 job 都要有 timeout-minutes ────────────────────────────────────
// 不设的话中途卡住会一直烧到默认上限（6 小时）：挂起比失败贵得多，而且**没有任何提示**。
// 本项目真的发生过（退役 runner 标签 → job 永远排队，不报错也不失败）。
const jobsBlock = subBlock(SRC, 'jobs', 0) || ''
const jobNames = [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((m) => m[1])
const noTimeout = jobNames.filter((n) => {
  const body = subBlock(SRC, n, 2) || ''
  return !/^ {4}timeout-minutes: *[0-9]+$/m.test(body)
})
check(
  jobNames.length >= 6 && noTimeout.length === 0,
  '12) 每个 job 都有 timeout-minutes（挂住的 job 会烧到默认上限，且不报错）',
  `共 ${jobNames.length} 个 job，缺 timeout-minutes 的：${noTimeout.join(' ') || '(无)'}`,
)

// ── 13) verify:all 与 CI 的 verify job 必须一致 ─────────────────────────────
// 往 verify:all 加了新守卫却忘了加进 CI → CI 永绿、只有本地会红（"合进主干时没人拦"）。
// 只比对**去掉注释行之后**的 job 正文：否则"被注释掉的步骤 + 注释里写着命令"会假通过。
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
const verifyAllCmds = String(pkg.scripts['verify:all'] || '')
  .split('&&')
  .map((s) => s.trim())
  .filter(Boolean)
const verifyJobCode = verifyJob
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n')
const notInCi = verifyAllCmds.filter((c) => !verifyJobCode.includes(c))
check(
  verifyAllCmds.length >= 5 && notInCi.length === 0,
  '13) `verify:all` 的每一项都出现在 CI 的 verify job 里（防"加了守卫忘了接 CI"）',
  `verify:all 共 ${verifyAllCmds.length} 项；CI 里找不到：${notInCi.join(' | ') || '(无)'}`,
)

// ── 14) release job 上传后要回读校验资产 ───────────────────────────────────
// `gh release create/upload` 返回 0 ≠ 资产已可查；GitHub 还会改写资产名里的连续空白
// （`NeckGuardian Setup 1.7.0.exe` → `NeckGuardian.Setup.1.7.0.exe`）——
// 校验文件照抄本地名 = 给用户一份跑不通的 SHA256SUMS。
const releaseJobCode = releaseJob.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
check(
  releaseJobCode.includes('--json assets') &&
    releaseJobCode.includes('diff -u') &&
    releaseJobCode.includes('sums-names.txt') &&
    releaseJobCode.includes('gh-assets-checked.txt'),
  '14) release job 上传后回读校验（读线上资产 + `diff` 对拍 SHA256SUMS 名字）',
  '少了它 = "看起来传上去了"：资产可能缺、校验文件名可能与线上不一致（用户 sha256sum -c 整条 FAILED）。' +
    '⚠️ 本断言只保护"有回读 + 有对拍"这两件事，**不**保护轮询次数/退避间隔（那是取值，不是结构）',
)

// ── 15) concurrency group 必须把 tag 归一化到同名 release 分支 ──────────────
// release/v1.7.0 与 v1.7.0 是两个不同 ref，按 github.ref 分组会**并发**写同一个 Release。
// ⚠️ GitHub 表达式没有 replace/slice，只能反过来"把 tag 伪装成 release 分支"。
const groupVal = (conc.match(/^ {2}group:(.*)$/m) || [])[1] || ''
check(
  groupVal.includes("startsWith(github.ref, 'refs/tags/')") &&
    groupVal.includes("format('release/{0}', github.ref_name)"),
  '15) concurrency group 把 tag 归一化到同名 release 分支（防分支与 tag 并发写同一个 Release）',
  `实际 group：${groupVal.trim() || '(空)'} —— 直接用 github.ref 会让两者落进不同的并发组`,
)

// ── 16) 四个打包 job 都要做同源校验 ────────────────────────────────────────
const noSameSource = PACKAGING_JOBS.filter(
  (n) => !(subBlock(SRC, n, 2) || '').includes('verify:source'),
)
check(
  noSameSource.length === 0,
  '16) 四个打包 job 都有同源校验（包内前端 = 本次 dist）',
  `缺 verify:source 的：${noSameSource.join(' ') || '(无)'} —— 少了它，那个端可以打包出旧前端而全程绿`,
)

// ── 16b) release job 的「分支名 → 版本」解析必须容忍可选的 `v` ────────────────
// 🔴 2026-09-29 **实测**踩到 —— release 分支链路**第一次实跑**就死在这一步，
//    四个端的包都构建好了，却在最后一个 job 直接 `exit 1`，**一个资产都没发出去**：
//      `::error::branch release/v1.7.0 与 package.json 版本 1.7.0 不一致`
//      `::error::…请先把版本号 bump 到位：node scripts/set-version.js v1.7.0`
//    根因：`TAG="v${GITHUB_REF_NAME#release/}"` —— 分支已经叫 `release/v1.7.0`（带 v），
//    剥掉 `release/` 后是 `v1.7.0`，再补一个 `v` 就拼成 **`vv1.7.0`**，
//    于是比对基准成了 `v1.7.0` ≠ `1.7.0`。（那句"建议"里带着 `v` 就是线索：
//    `set-version.js` 要的是**不带 v** 的版本号。已用 bash 逐字复现过。）
//    分支名带 v 是**文档与建模都约定的写法**（`release/v1.7.0`，也是断言 15 能归一化 tag 的前提），
//    所以修法是把分支名的 `v` **可选地**剥掉，而不是要求改名。
//
// 判据落在**剥 v 的那一行**上，且用去注释后的代码（`releaseJobCode`）——
// 否则上面这段解释里就含有"正确写法"的字样，断言会被自己的注释满足（见本文件头部那两类事故）。
check(
  releaseJobCode.includes('BRANCH_VER="${GITHUB_REF_NAME#release/}"') &&
    releaseJobCode.includes('TAG="v${BRANCH_VER#v}"') &&
    !releaseJobCode.includes('TAG="v${GITHUB_REF_NAME#release/}"'),
  '16b) release job 的「分支名 → 版本」容忍可选 `v`（不许拼成 vv1.7.0）',
  '分支名 release/v1.7.0 会被拼成 vv1.7.0 ⇒ 版本比对失败 ⇒ release job 退出 1、一个资产都发不出去',
)

// ── 17) Windows 与 macOS 都要有后端启动冒烟 ────────────────────────────────
// 静态校验（格式 / 哈希 / 权限声明）推不出"起得来"。Windows 是主力分发平台，尤其不能只有静态检查。
// 判据取**各自独有的**锚点，避免"步骤名还在、内容被掏空"也能过：
//   - Windows：必须引用**解包后的** exe 路径（不是 build/ 里的中间产物）+ 断言 status=ok；
//   - macOS  ：必须打 /api/health + 断言 status=ok。
const smokeSpec = [
  {
    job: 'desktop-windows',
    must: [
      'release2/win-unpacked/resources/neckguardian-backend/neckguardian-backend.exe',
      '"status":"ok"',
    ],
  },
  { job: 'desktop-macos', must: ['/api/health', '"status":"ok"'] },
]
const noSmoke = []
for (const { job, must } of smokeSpec) {
  const body = subBlock(SRC, job, 2)
  if (body === null) {
    noSmoke.push(`${job}(找不到 job)`)
    continue
  }
  const lack = must.filter((k) => !body.includes(k))
  if (lack.length) noSmoke.push(`${job}(缺 ${lack.join(' / ')})`)
}
check(
  noSmoke.length === 0,
  '17) Windows 与 macOS 都有后端启动冒烟（跑包内后端 + 断言 /api/health status=ok）',
  noSmoke.join(' ') || '(无)',
)

console.log(`\n共 ${passed + failed} 项断言：${passed} 通过，${failed} 失败`)
if (failed > 0) {
  console.log('✗ CI 工作流守卫未通过')
  process.exit(1)
}
console.log('✓ CI 工作流守卫通过')
