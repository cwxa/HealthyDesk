# 分支模型与发版流程

> 2026-09-29 起生效。**CI 触发的唯一真相来源**是 `.github/workflows/build.yml`，
> 由 `npm run verify:ci` 守着（21 条断言 + 变异自证）。
>
> 为什么单独写一份：以前 `main` 是**裸的** —— 推上去 CI **什么都不跑**（工作流的 `on:`
> 只有 tag 与手动），而"推发版分支就出包"这件事没有任何地方写下来过。
> 模型不清楚，就会退化成"想到哪推到哪"。

---

## 一、三条线

```
main      ──●──────●──────────●────────●──   稳定主干：只进验证过的东西
             \    /            \      /
   feat/x  ────●──┘              \    /
   fix/y   ──────●────────────────┘  /
                                      /
   release/v1.7.0 ───────────────────●──●──   发版专线：推它就出包
                                          \
                                           tag v1.7.0 → 定稿 → 人工放行
```

| 分支 | 从哪来 | 合到哪 | 干什么 | CI 对它们做什么 |
|---|---|---|---|---|
| `main` | — | — | 稳定主干 | **只跑守门** |
| `feat/<名>` | main | main | 新功能 | 只跑守门 |
| `fix/<名>` | main | main | 修 bug | 只跑守门 |
| `chore/<名>`、`docs/<名>` | main | main | 重构 / 文档 / 工具链 | 只跑守门 |
| `release/v<X.Y.Z>` | main | main（+ tag） | 发版准备与出包 | 守门 **+ 四端构建 + 创建/更新该版本的 draft Release** |

> 刻意**没有** `develop` 层：只有一位开发者 + 一个智能体，多一层集成分支只多一次合并。
> 哪天变成多人并行开发，再加不迟 —— 那时 `feat/*` 先合 `develop`、发版时 `develop → main`。

---

## 二、日常开发

```bash
git switch main && git pull
git switch -c fix/reminder-not-firing
# 改；跑 npm run verify:all；必要时跑对应变异脚本
git commit -m "fix(reminder): ..."
git push -u origin fix/reminder-not-firing
# 合回主干（本地 ff-only 或开 PR 都行）
git switch main && git merge --ff-only fix/reminder-not-firing && git push origin main
git branch -d fix/reminder-not-firing
```

三条规矩：

1. **不直接往 `main` 推功能改动。** `main` 是"最后一道网"，不是工作区。
2. **一个分支只干一件事**，名字带类型前缀与关键词（`fix/` `feat/` `chore/` `docs/`）。
3. **合并前本地 `npm run verify:all` 必须绿**；动了守卫/数值就再跑一次的变异脚本。
   CI 会在 `main` 上再跑一遍 —— 它是兜底，不是第一道。

---

## 三、发版：用 release 分支出包

```bash
# 1) 版本号五处同步（versionCode 会在版本变化时自动 +1）
node scripts/set-version.js 1.7.0
npm run verify:all

# 2) 开发版专线并推上去 —— 这一步就会开始构建四端
git switch -c release/v1.7.0
git push -u origin release/v1.7.0
```

推上去之后：

- **版本号取自分支名**（`release/v1.7.0` → tag `v1.7.0` → 版本 `1.7.0`），
  并与 `package.json` 比对；不一致直接 `::error::` **失败**，不会发出版本号错乱的 Release。
  允许预发布后缀：`release/v1.7.0-rc1` 按 `1.7.0` 校验（预演 CD 不用动 `package.json`）。
- **同一条分支可以反复推**：每次都覆盖同名资产（`gh release upload --clobber`），迭代很快。
  往分支上补一个提交就重出一轮包，不用打新 tag。
- 🔴 **目标是已发布的 Release 时，分支构建直接失败**：
  已发布的资产与 `SHA256SUMS` 是**对外契约**（有人下载过、README 的 `releases/latest` 指着它），
  要发行就往上**升版本号**，别去覆盖别人手上的下载。
  `tag` 被当作**定稿动作**，保留覆盖能力（否则打错 tag 就没法修）。

定稿与放行：

```bash
git tag v1.7.0 && git push origin v1.7.0          # tag = 定稿（允许覆盖已发布资产）
gh release edit v1.7.0 --draft=false --latest    # 人工放行（CI 的 Summary 里会打印这条）
```

🔴 **为什么"放行"那一步不自动化**：四端的**真机通过行到现在还是空的**（见
[device-matrix.md](device-matrix.md)）。"构建成功" ≠ "能用" —— 自动 publish 等于把前者
当后者推到用户面前。这条闸门在 `verify:ci` 的第 8 条断言上。

发版前的验证清单在 [MULTIPLATFORM.md §9](MULTIPLATFORM.md)，**必须逐条走**。

---

## 四、CI 触发表（唯一真相来源）

| 触发 | 守门 | 四端构建 | draft Release |
|---|---|---|---|
| 推 `main` | ✅ | — | — |
| 推 `feat/**` `fix/**` `chore/**` `docs/**` | ✅ | — | — |
| 推 `release/**` | ✅ | ✅ | ✅ 创建/更新 |
| 推 tag `v*` | ✅ | ✅ | ✅ 允许覆盖 |
| Actions 手动 `workflow_dispatch` | ✅ | ✅ | —（只构建） |

> **首次生效记录（2026-09-29，实测，不是推断）**
>
> 模型上线时推了一次 `main`，**第一次是失败的**：`cancel-in-progress` 忘了包 `${{ }}`，
> GitHub **拒掉了整个工作流文件** —— run `36522483327` 的 run 名显示成
> `.github/workflows/build.yml`（不是「四端构建」）、`/jobs` 返回空、`check-runs` 也为空。
> 本地 `yaml.load()` 与 `verify:ci` 都是绿的（详见 §五 与铁律 #59）。
>
> 修好后重推（run **`36522835201`**）：**守门 16 步全绿**（含新增的第 13 步「CI 工作流守卫」），
> 而 **`Windows 安装包` / `macOS 安装包` / `Android APK` / `iOS 归档` / `汇总产物 · 创建/更新 draft Release`
> 五个 job 全部 `completed/skipped`** —— 这就是"推 `main` 只跑守门、不打包"这条规则的**真凭实据**。
> （在此之前它只是一行 `if:`，没人验过 GitHub 真的会跳过。）

> 🔴 **`release/**` 链路的首次实效记录（2026-09-29，v1.7.0；**第一次实跑就抓到一处真缺陷**）**
>
> 上面那段当时只敢写到"`release/**` 与 `tag` 两条链路**仍未实跑**"。当天就实跑了，结论：
>
> - 推 `release/v1.7.0`（run **`36528065523`**）：**守门绿（2m5s，CI 上跑通了 `verify:ui`）**、
>   四个打包 job 全部启动并完成 —— 也就是说「推发版分支就出包」**确实生效了**。
> - **但最后一个 job 失败**：`branch release/v1.7.0 与 package.json 版本 1.7.0 不一致`，
>   紧接着一句 `请先把版本号 bump 到位：node scripts/set-version.js **v**1.7.0`。
>   那句"建议"里带着 `v` 就是线索 —— `set-version.js` 要的是**不带 v** 的版本号。
>   根因：`TAG="v${GITHUB_REF_NAME#release/}"`。分支名已经叫 `release/v1.7.0`（带 v），
>   剥掉 `release/` 得到 `v1.7.0`，再补一个 `v` ⇒ **`vv1.7.0`**，比对基准变成 `v1.7.0` ≠ `1.7.0`。
>   四个端的包都构建好了，**却一个资产都没发出去**。（已用 bash 逐字复现，不是推断。）
> - 修法不是改分支名：分支名带 `v` 既是本文档与 §一 的约定，也是 `concurrency.group`
>   把 tag 归一化到同一并发组（`verify:ci` 断言 15）的前提。改成把分支名的 `v` **可选地**剥掉：
>   `BRANCH_VER="${GITHUB_REF_NAME#release/}"; TAG="v${BRANCH_VER#v}"` ——
>   于是 `release/v1.7.0`、`release/1.7.0`、`release/v1.7.0-rc1` 三种写法都落到同一个 TAG。
> - 已补守卫 **`verify:ci` 16b**（+ 变异 `C16`：退回旧写法必须红）。
>   ⚠️ 这一条属于**第三类失效**："射程"没问题、"作用域"也没问题，**是那一行自己的表达式写错了** ——
>   本地 YAML 与 actionlint 都是绿的，只有**真的跑一次**才会暴露。
>   **教训：「流程写下来」≠「流程跑通过」；没跑过的链路，文档里就要写着"没跑过"。**

**守门**（`verify` job）包含：类型检查、期望值是否与生成器同步、`verify:parity`、
`verify:schema`、`verify:exercises`、`verify:readme`、`verify:ci`、`build:web` + `verify:ui`、
`set-version --check`。

**每个 job 都有 `timeout-minutes`**（2026-09-29 补）：这是**兜「挂死」**的宽松上限，不是性能目标。
不设的话，中途卡住（等网络、等锁、轮询不退出）会一直烧到默认上限（6 小时），
而**挂起比失败贵得多、也没有任何提示**。本项目真的发生过：退役的 runner 标签让 job
既不报错也不失败地永远排队、`electron-builder` 退避重试、后端冒烟 60 次轮询。

**每个打包 job 的收尾门**（各自都做，缺一不可）：

| job | 静态校验 | 运行时冒烟 |
|---|---|---|
| `desktop-windows` | 后端 PE 格式 + 同源校验 | ✅ 跑**解包后的** exe，等 `/api/health` 且 `status=ok` |
| `desktop-macos`（×2 架构） | 权限声明 / Mach-O 架构 / 可执行位 / 同源校验 | ✅ 跑 `.app` 内后端，等 `/api/health` |
| `mobile-android` | 签名指纹与历史一致 + 同源校验 | —（真机才测得出，见 §四） |
| `mobile-ios` | 权限声明 / BundleID / Mach-O + 同源校验 | —（CI 出的是未签名 `.xcarchive`） |

> Windows 的运行时冒烟是 **2026-09-29 补的**：它是**主力分发平台**，此前只有静态校验 ——
> 而"格式对 + 哈希对"推不出"起得来"（端口占用、DB 初始化失败、PyInstaller 漏收动态库、
> 路径解析错，全都只有真跑一次才暴露）。

**CD 收尾会回读校验**（`release` job）：`gh release create/upload` 返回 0 **不等于**资产已可查
（列表接口有最终一致性延迟，实测 create 成功 19 秒后仍返回 `assets=0`），
所以上传后**轮询资产数量**直到与 `dist-release/` 对上；再**逐字比对** `SHA256SUMS.txt` 里登记的
文件名与 GitHub 上的实际资产名 —— GitHub 会把资产名里的连续空白压成一个点
（`NeckGuardian Setup 1.7.0.exe` → `NeckGuardian.Setup.1.7.0.exe`），照抄本地名就等于
给用户一份 `sha256sum -c` **跑不通**的校验文件。

**并发**：组名按**版本**归一化（`release/v1.7.0` 分支与 `v1.7.0` tag 落进**同一组**），
重复触发会取消上一次；但 **tag 与 `release/**` 不取消**
（它们后面接着写 Release，半路取消会留下资产残缺的空壳）。
> ⚠️ 2026-09-29 之前组名用的是 `github.ref`，于是 `release/v1.7.0` 与 `v1.7.0` 是**两个不同的组** →
> 并发跑、并发写**同一个** Release（一个 `create`、一个 `upload --clobber`）。
> 归一化只能**反过来做**：GitHub 表达式**没有**字符串替换/切片
> （可用函数只有 always / cancelled / case / contains / endsWith / failure / format / fromJSON /
> hashFiles / join / startsWith / success / toJSON）—— 所以是把 **tag 的组名伪装成同名 release 分支**。

---

## 五、这套规则自己也有守卫

`npm run verify:ci` —— **21 条断言**，盯的就是上面那张表：

| 断言 | 抓什么 |
|---|---|
| 1–4 | `on.push` 里 `main` / `release/**` / `feat/**` / `fix/**` / `tags: v*` 缺一个就红 |
| 5 | `workflow_dispatch` 被删掉（应急手动构建的口子没了） |
| 6 | 四个打包 job 的 `if:` 被拿掉或改坏（推 `main` 也会烧四个 runner、主干提交混进产物） |
| 7 | `release` job 不再由 tag / release 分支触发 |
| 8 | 🔴 **`--draft` 闸门被去掉**（之后每次打 tag 都自动对外发布） |
| 9 | "已发布不许覆盖"的判断条件被掏空（护栏还在但永远不触发） |
| 10 | `cancel-in-progress` 改成恒真（tag 构建半路被取消） |
| 10b | 🔴 **`cancel-in-progress` 没包 `${{ }}`** —— 本地 YAML 合法，但 **GitHub 拒掉整个工作流文件** |
| 11 | **反向对照**：`verify` job 被加上 `if:`（守门变成"有条件才跑"） |
| 12 | 某个 job 的 `timeout-minutes` 被拿掉（挂住就烧到 6 小时上限） |
| 13 | 往 `verify:all` 加了守卫却**没接进 CI**（CI 永绿、只有本地会红） |
| 14 | `release` job 的**上传后回读校验**被删掉（资产可能缺、校验文件名可能与线上不一致） |
| 15 | `concurrency.group` 改回按 `github.ref`（分支与 tag 并发写同一个 Release） |
| 16 | 某个打包 job 的**同源校验**被拿掉（那个端可以打包出旧前端而全程绿） |
| 17 | Windows 或 macOS 的**后端启动冒烟**被删掉 / 被掏空 |

它有牙的证明是 `.buildenv/mutate-ci.py`（**不入库**）：C1–C15 十五条变异**全部被抓住**，
外加 N1/N2 两条负向对照（N1 只改一条注释、N2 只改 `timeout-minutes` 的取值 45→60，
两种情况守卫**都必须保持绿** —— 证明它盯的是结构与条件，不是"文本变了就红"或"把数字写死"）。

> 🔴 **变异测试真的抓到过两条守卫自身的缺陷**，都不是"猜"出来的：
> - 第 8 条：`includes('--draft')` 被 Summary 里的 `--draft=false` 满足（断言落在**注释上**）；
> - 第 10 条：`conc.includes('refs/tags/')` 被 `group:` 那一行满足（断言落在**错误的块上**）——
>   这是 2026-09-29 第二轮改 `group:` 时**当场**被变异抓到的。
>
> 规律：**断言的范围越宽，越容易被范围里"别的正确东西"满足**。
> 所以断言必须"先按缩进取块、再落到具体那一行/那个参数"，且**改完断言必须重跑变异**。

### ⚠️ 本守卫查不了"GitHub 认不认"

它查的是**"这些语义还在不在"**，不是"这个文件合法"。这个边界已经被实测踩过**两次**：

| # | 改法 | 本地 YAML | 后果 |
|---|---|---|---|
| 10b | `cancel-in-progress` 写成折叠标量 + 裸表达式 | 完全正常 | GitHub **拒掉整个工作流文件**，run 里一个 job 都没有 |
| 15 | 用了 `replace(github.ref_name, 'release/', '')` 归一化 group | 完全正常 | `replace` 在 GitHub 表达式里**根本不存在**（actionlint：`undefined function "replace"`） |

两次都是 `verify:ci` 全绿、`yaml.load()` 全绿，**只有 actionlint 能抓**。

所以 **改完 `build.yml` 请再用 `actionlint` 过一遍**（GitHub Actions 的语义校验器）：

```bash
gh release download v1.7.12 -R rhysd/actionlint \
  -p 'actionlint_*_windows_amd64.zip' -D .buildenv/actionlint
(cd .buildenv/actionlint && unzip -o -q actionlint_*.zip)
.buildenv/actionlint/actionlint.exe .github/workflows/build.yml
```

它一条命令就能指出上面两次事故，例如：

```
build.yml:62:37: expecting a single ${{...}} expression or boolean literal "true" or "false",
                 but found plain text node                          ← 10b 那次
build.yml:62:37: undefined function "replace". available functions are ...  ← 15 那次
```

还能抓 context 名拼错、`needs` 指向不存在的 job 等一整类问题。
⚠️ 别加 `-color never` —— 它会被当成文件名（`could not read "never"`）。

**刻意没接进 CI**：那会给守门引入一个**需要联网下载的二进制依赖**，而本项目的取舍是
"守卫的依赖越少，守卫自己坏掉的概率越低"（同 `verify-readme.mjs`）。代价就是：
**这一步是人工的，别忘**。改过 `build.yml` 的提交，在推之前必须跑过一次。

**改 `build.yml` 之前先读本文件与那个变异脚本。**

---

## 六、已废弃

| 分支 | 处置 | 依据 |
|---|---|---|
| `dev1.0` | **2026-09-29 删除**（本地 + 远程） | 停在 v1.1.0（2026-05-05），落后 `main` **92 个提交**，且**没有任何 `main` 里没有的提交**（合并前已 `git log main..dev1.0` 确认为空） |
