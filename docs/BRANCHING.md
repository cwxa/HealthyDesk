# 分支模型与发版流程

> 2026-09-29 起生效。**CI 触发的唯一真相来源**是 `.github/workflows/build.yml`，
> 由 `npm run verify:ci` 守着（14 条断言 + 变异自证）。
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

**守门**（`verify` job）包含：类型检查、期望值是否与生成器同步、`verify:parity`、
`verify:schema`、`verify:exercises`、`verify:readme`、`verify:ci`、`build:web` + `verify:ui`、
`set-version --check`。

**并发**：同一个 ref 重复触发会取消上一次；但 **tag 与 `release/**` 不取消**
（它们后面接着写 Release，半路取消会留下资产残缺的空壳）。

---

## 五、这套规则自己也有守卫

`npm run verify:ci` —— **15 条断言**，盯的就是上面那张表：

| 断言 | 抓什么 |
|---|---|
| 1–4 | `on.push` 里 `main` / `release/**` / `feat/**` / `fix/**` / `tags: v*` 缺一个就红 |
| 5 | `workflow_dispatch` 被删掉（应急手动构建的口子没了） |
| 6 | 四个打包 job 的 `if:` 被拿掉或改坏（推 `main` 也会烧四个 runner、主干提交混进产物） |
| 7 | `release` job 不再由 tag / release 分支触发 |
| 8 | 🔴 **`--draft` 闸门被去掉**（之后每次打 tag 都自动对外发布） |
| 9 | "已发布不许覆盖"的判断条件被掏空（护栏还在但永远不触发） |
| 10 | `concurrency` 改成恒真（tag 构建半路被取消） |
| 10b | 🔴 **`cancel-in-progress` 没包 `${{ }}`** —— 本地 YAML 合法，但 **GitHub 拒掉整个工作流文件** |
| 11 | **反向对照**：`verify` job 被加上 `if:`（守门变成"有条件才跑"） |

它有牙的证明是 `.buildenv/mutate-ci.py`（**不入库**）：C1–C9 九条变异**全部被抓住**，
外加 N1 负向对照（只改一条注释，守卫必须保持绿 —— 证明它盯的是结构与条件，不是"文本变了就红"）。

### ⚠️ 本守卫查不了"GitHub 认不认"

它查的是**"这些语义还在不在"**，不是"这个文件合法"。第 10b 条就是这么补出来的 ——
**事故先发生，才有的断言**：把 `cancel-in-progress` 从 `${{ … }}` 改成折叠标量后，
本地 `yaml.load()` 完全正常，`verify:ci` 也全绿，但推上去的 run 里**一个 job 都没有**，
页面只说 `workflow file issue`（`if:` 可以省略 `${{ }}` 是它**专属**的例外，别的字段不适用）。

所以 **改完 `build.yml` 请再用 `actionlint` 过一遍**（GitHub Actions 的语义校验器）：

```bash
gh release download v1.7.12 -R rhysd/actionlint \
  -p 'actionlint_*_windows_amd64.zip' -D .buildenv/actionlint
(cd .buildenv/actionlint && unzip -o -q actionlint_*.zip)
.buildenv/actionlint/actionlint.exe .github/workflows/build.yml
```

它一条命令就能指出上面那次事故（`expecting a single ${{...}} expression or boolean literal`），
还能抓 context 名拼错、`needs` 指向不存在的 job 等一整类问题。

**刻意没接进 CI**：那会给守门引入一个**需要联网下载的二进制依赖**，而本项目的取舍是
"守卫的依赖越少，守卫自己坏掉的概率越低"（同 `verify-readme.mjs`）。代价就是：
**这一步是人工的，别忘**。

**改 `build.yml` 之前先读本文件与那个变异脚本。**

---

## 六、已废弃

| 分支 | 处置 | 依据 |
|---|---|---|
| `dev1.0` | **2026-09-29 删除**（本地 + 远程） | 停在 v1.1.0（2026-05-05），落后 `main` **92 个提交**，且**没有任何 `main` 里没有的提交**（合并前已 `git log main..dev1.0` 确认为空） |
