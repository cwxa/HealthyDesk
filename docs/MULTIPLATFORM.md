# NeckGuardian 多平台架构与构建矩阵

> 四端（Windows / macOS / Android / iOS）共用**同一份 React 前端**。
> 本文说明平台差异收敛在哪里、各端怎么出包、以及每端的硬性限制。

相关文档：
- 安卓细节（工具链、签名、摄像头权限踩坑）→ [ANDROID_BUILD.md](./ANDROID_BUILD.md)
- 故障排查 → [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

---

## 一、平台矩阵

| | Windows | macOS | Android | iOS |
|---|---|---|---|---|
| 运行时平台 | `electron` | `electron` | `android` | `ios` |
| 形态 | 桌面 | 桌面 | 移动 | 移动 |
| 姿态推理位置 | Python 后端 | Python 后端 | WebView 内 wasm | WKWebView 内 wasm |
| 数据存储 | 后端 SQLite | 后端 SQLite | 本机 IndexedDB | 本机 IndexedDB |
| 产物 | NSIS `.exe` | `.dmg` / `.zip` | `.apk` | `.xcarchive` / `.ipa` |
| 能否在 Windows 上构建 | ✅ | ❌ | ✅ | ❌ |
| 构建机要求 | Windows | **macOS** | 任意 + JDK17/SDK34 | **macOS + Xcode** |

### 1.1 为什么 macOS / iOS 必须用 Mac

不是构建脚本没写好，是两道平台硬约束：

1. **iOS**：Xcode、clang、iOS 代码签名都没有非 macOS 实现。
2. **macOS**：安装包要内置一个 **macOS 原生的 Python 后端**（PyInstaller 产物），
   而 PyInstaller **不能交叉编译**。在 Windows 上执行 `electron-builder --mac`
   会构建成功，但 `.app` 里躺着一个 Windows PE 文件 —— 用户看到的是
   "装上了、图标在、打开卡在正在启动服务"。

因此 macOS / iOS 只能交给 **GitHub Actions 的 macOS runner**（见 §四），
或一台真实 Mac。

> 🔒 针对第 2 点的守卫：`npm run verify:backend` 会读后端可执行文件的 magic bytes，
> 在打包前拦截"格式/架构与目标平台不符"。Windows 上跑 `--target=mac` 会直接 exit 1。

---

## 二、架构分层

```
src/
├── platform/                  ← 平台差异全部收敛在这里
│   ├── runtime.ts             平台判定 + 能力矩阵（唯一的平台真相来源）
│   ├── nativeDiag.ts          摄像头权限诊断（按平台分发 provider）
│   ├── dataLayer.ts           统一数据层：后端 REST ↔ 本机 IndexedDB
│   ├── localPoseEngine.ts     移动端本地推理（与 Python 后端逐位等价）
│   ├── localDb.ts             IndexedDB 四张"表"
│   ├── localStats.ts          本地统计（用 pyRound，勿用 Math.round）
│   └── localReminder.ts       移动端本地提醒调度
├── hooks/
│   ├── usePoseEngine.ts       统一姿态 hook：桌面走 WS / 移动走本地引擎
│   └── useWebSocket.ts        桌面端 WebSocket
├── pages/ components/         业务层 —— **不含任何平台分支**
electron/main.ts              Electron 主进程（跨平台）
backend/                      Python 后端（仅桌面端使用）
ios/                          iOS 原生工程（Capacitor 生成 + 定制）
android/                      Android 原生工程（Capacitor 生成 + 定制）
macos/                        macOS 打包用的 entitlements
```

### 2.1 核心设计：问能力，不问平台

业务组件**不应该**写 `platform === 'android'`。`runtime.ts` 暴露的是一张**能力矩阵**：

```ts
supports('localBackend')        // 有本地 Python 后端？→ 桌面端 true
supports('localInference')      // 推理在本进程内？→ 移动端 true
supports('nativeDiagnostics')   // 能直读系统级相机授权？→ 仅 Android
supports('systemTray')          // 有托盘/菜单栏？→ 桌面端
supports('autoStart')           // 支持开机自启？→ 桌面端
```

新增一个平台时，改的是**这张表**，不是散落各处的 `if`。

### 2.2 平台判定

`getPlatform()` 依次判断：

1. `window.electronAPI` 存在 → `electron`
2. `Capacitor.getPlatform()` → `android` / `ios` / `web`

宿主操作系统（Windows / macOS / Linux）由 **preload 从 Node 上下文取出**
（`electronAPI.platform`），并映射为 `HostOS`。运行时平台同为 `electron`，
但托盘文案、快捷键提示、"去哪儿开摄像头权限"的路径都随操作系统变化。

**开发预览**：在桌面浏览器里用 URL 参数强制走某个平台分支（HashRouter 下
参数必须写在 `#` 之前）：

| URL | 效果 |
|---|---|
| `/?platform=android#/` | 手机端布局 + 本地推理分支 |
| `/?platform=ios#/` | 同上 |
| `/?platform=macos#/` | 桌面端布局，但按 macOS 处理 |
| `/?platform=electron&os=windows#/` | 显式指定 |

### 2.3 双端数值一致性（改评分/角度必读）

评分、角度、平滑器、统计聚合同时存在于 `backend/services/*.py` 与
`src/platform/`，两者必须**逐位等价**：

```bash
npm run verify:parity     # 24 常量 + 80 评分用例 + 439 帧平滑 + 8 角度
                          # + 运动态 32 用例 + 措辞断言 + 语音隔离
                          # + 部位健康度 9 常量 + 3 映射 + 18 用例
                          # + 动作完成度 24 常量 + 3 段离线样本 + 39 用例 + 幅度口径反例 3 条 + 时间支撑反例 6 条
```

核心不变量：**出现任何姿态提醒 ⟺ 分数 < 80**（⚠️ 仅静息态；活动进行中走运动态
通道，达标线是 `EXERCISE_SCORE_BASE = 60`，见 DEVELOPMENT.md §4.1.1）。

⚠️ 取整只有两个口径，都在 `backend/services/rounding.py` 与
`src/platform/scoringModel.ts` 里成对定义：引擎内角度用 `pyRound(x*100)/100`，
统计展示值用 `round_1` / `round_int`。

⚠️ **不要用 Python 内置 `round()` 做双端共享的取整** —— 它对精确二进制值舍入，
JS 无法复刻，实测会在平局点上让两端显示不同的数字（99.5 vs 99.6）。

⚠️ 也不要在 TS 侧写 `Math.round`：三者不是同一个函数，实测能差 1 分 / 0.01。

---

## 三、各端构建

### 3.1 Windows

```bash
npm ci
npm run icons:generate        # 生成 ico / icns / 菜单栏 template 图（改了 SVG 才需要）
npx vite build                # 桌面模式（含 Electron 入口）
npm run backend:build         # PyInstaller（Windows 上建议用干净 venv `.buildenv`，见 TROUBLESHOOTING.md）
npm run verify:backend        # 校验后端产物是 PE/x64
npx electron-builder --win    # → release2/NeckGuardian Setup X.Y.Z.exe
```

> 这五步等价于 `npm run build:win`（macOS / Linux 分别是 `build:mac` / `build:linux`）。
> 用 npm 脚本时 `verify:backend` 会自动带上 `--target`，把"在 Windows 上给 mac 打包含 PE 后端"
> 这类问题拦在出包前。

### 3.2 macOS

```bash
# 必须在 macOS 上
npm ci
npx vite build
npm run backend:build
npm run verify:backend -- --target=mac --arch=arm64   # 或 x64
npx electron-builder --mac --arm64                    # 或 --x64
# → release2/NeckGuardian-X.Y.Z-mac-arm64.dmg
```

**为什么不打 universal 包**：内置的 Python 后端是单架构 Mach-O，
合并成 universal 会让另一半架构上的后端跑不起来。两种架构分别出包。

**签名与公证**（可选，但分发时必须做）：

1. 准备 Apple 开发者账号，导入证书到钥匙串
2. 开启公证：

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="XXXXXXXXXX"
npx electron-builder --mac --arm64 -c.mac.notarize=true
```

3. 未签名的 `.dmg` 在别人机器上会被 Gatekeeper 拦下，用户需
   「右键 → 打开」或在「系统设置 → 隐私与安全性」里放行。

**Info.plist 关键项**（已配在 `electron-builder.yml` 的 `mac.extendInfo`）：

| 键 | 为什么必须有 |
|---|---|
| `NSCameraUsageDescription` | 🔴 macOS 下请求摄像头权限时，**缺这条进程会被系统直接终止**（不是报错，是崩溃） |
| `ITSAppUsesNonExemptEncryption: false` | 免去每次上传 App Store Connect 的合规问答 |

**entitlements**（`macos/entitlements.mac.plist`）：
- `allow-jit` / `allow-unsigned-executable-memory` —— Electron 的 V8 必需，缺了 hardened runtime 下直接崩
- `disable-library-validation` —— 内置 PyInstaller 后端的 `.so` 加载需要
- `device.camera` —— 摄像头

### 3.3 Android

见 [ANDROID_BUILD.md](./ANDROID_BUILD.md)。一键命令：

```bash
npm run cap:build             # debug
npm run cap:build:release     # release（需 android/keystore.properties）
```

### 3.4 iOS

```bash
# 必须在 macOS 上；需要 Xcode + CocoaPods
sudo gem install cocoapods
xcode-select --install

node scripts/ios-build.js                # 未签名归档（验证可编译）
node scripts/ios-build.js --export       # 导出 IPA（需签名）
```

在 Windows 上跑 `scripts/ios-build.js` 会**立即退出**并说明原因，不会留下半成品工程。

**iOS 摄像头权限链路**（这条链已经全部打通，只需知道结论）：

| 环节 | 谁负责 | 说明 |
|---|---|---|
| `allowsInlineMediaPlayback` | Capacitor 6.2.2 已内置 | `<video>` 才能内联播放 |
| `requestMediaCapturePermissionFor → .grant` | Capacitor 6.2.2 已内置 | iOS 15+ 的 WKWebView 授权回调，**不实现则静默拒绝** |
| **`NSCameraUsageDescription`** | **本项目配置**（`ios/App/App/Info.plist`） | 🔴 缺了会**闪退**，这是 iOS 端唯一必须自己配的一项 |
| Permissions API 推断 | `src/platform/nativeDiag.ts` | iOS 无原生桥，权限状态由 web 侧推断 |

**故意不声明 `NSMicrophoneUsageDescription`**：取流约束固定 `audio: false`，
语音提示走 `speechSynthesis`（纯播放），全程不采音频。声明用不到的权限会被审核追问。

**关于 `iosScheme`**：⚠️ **不要**改成 `https`。iOS 上 `https` 被 WKWebView
保留给外部资源，Capacitor 无法用它托管本地资源。默认的 `capacitor://localhost`
**已经属于安全上下文**，`getUserMedia` 能正常工作。也**不要**给 hostname 加端口
（iOS 15.5–16 上带端口的自定义 scheme 会让 `getUserMedia` 报 AbortError）。

---

## 四、CI：四端一起构建

`.github/workflows/build.yml`。**触发条件与分支模型的唯一真相来源是
[BRANCHING.md](BRANCHING.md)** —— 这里只列 job 与产物。要点：

| 触发 | 守门 `verify` | 四端构建 | draft Release |
|---|---|---|---|
| 推 `main` / `feat|fix|chore|docs` 分支 | ✅ | — | — |
| 推 `release/v<X.Y.Z>` 分支 | ✅ | ✅ | ✅ 创建/更新 |
| 推 tag（`v*`） | ✅ | ✅ | ✅ 允许覆盖 |
| 手动触发（`gh workflow run build.yml`） | ✅ | ✅ | — |

| Job | Runner | 产物 |
|---|---|---|
| `verify` | ubuntu-24.04 | 守门（见下） |
| `desktop-windows` | windows-latest | `.exe` |
| `desktop-macos` | `macos-15-intel`(x64) / `macos-15`(arm64) | `.dmg` / `.zip` |
| `mobile-android` | ubuntu-24.04 | `.apk` |
| `mobile-ios` | `macos-15` | `.xcarchive.tgz` |
| `release`（CD） | ubuntu-24.04 | **draft** Release：四端产物 + `SHA256SUMS.txt` |

> 🔴 **Linux 用 `ubuntu-24.04` 而不是 `ubuntu-latest`**：`ubuntu-latest` 将于
> **2026-10-19** 迁到 Ubuntu 26（CI 上已在刷这条注记）。钉住小版本 = 升级由我们决定，
> 而不是某天被动接受。要升就改这一处、跑一遍。
> 同理 `macos-13` 已退役（用它 job **永远排队**，不报错不失败），Intel 只剩 `macos-15-intel`。

> 仓库是 **public**，Actions 分钟数**免费**（含 macOS runner 的 10 倍计费），不用心疼。

### 🔴 runner 标签是会过期的依赖

别把 `runs-on:` 的值当常量。GitHub 按 **N-1 OS 支持策略**，每个 OS 家族只保留最近两个
GA 镜像；旧标签退役后，**用它的 job 会永远排队** —— 既不报错也不失败，
CI 页面看起来只是"一直在跑"。这比"失败"更难发现。

- `macos-13`（Intel）已于 **2025-12-04** 彻底退役。官方给标准 runner 的 Intel 替代标签是
  `macos-15-intel`，且这是**最后一个** Intel 镜像 —— 2027-08 之后 x64 mac 包只能本地出。
- `macos-14` 的弃用支持 **2026-11-02 到期**，所以 arm64 直接用 `macos-15`，别贴着期限走。
- `-large` / `-xlarge` 是**付费** larger runner，标准账号用不了。
- 退役前会有若干 **brownout 窗口**（临时整点失败），那是最后的预警信号。
- 查现状：`endoflife.date/github-actions-runner-images`，或 `actions/runner-images` 的 issue。

### 首次真跑踩到的坑（2026-09-23，均已修）

这四个都是**在 Windows 本机永远复现不出来**的类型 —— 正是引入 CI 最实在的回报。

| 症状 | 根因 | 修法 |
|---|---|---|
| `xcodebuild: error: 'App.xcworkspace' does not exist`（而 `pod install` 明明成功） | `-workspace App.xcworkspace` 是**相对路径**，xcodebuild 的 cwd 不对 | `scripts/ios-build.js` 里 pod install 与 xcodebuild **两步都传** `cwd=ios/App` |
| `ERROR: script '...\main.py' not found` | `neckguardian-backend.spec` 里写了 Windows 反斜杠路径；反斜杠在 POSIX 上只是普通字符 | 改正斜杠（三平台通用） |
| `Failed to find package 'tools'` → exit 1 | `android-actions/setup-android@v3` 内部执行 `sdkmanager tools`，而该包早已从 SDK 仓库移除 | **弃用该 action**，直接用 runner 自带 SDK；`sdkmanager` 按 `cmdline-tools/*/bin/` 动态查找 |
| macOS x64 job **永远 queued** | 用了已退役的 `macos-13` | 换 `macos-15-intel` |

> 查日志技巧：整轮没结束时 `gh run view --log` 取不到，但**单个 job 的日志已经可取**：
> `gh api repos/<owner>/<repo>/actions/jobs/<job_id>/logs`（返回纯文本）。

**`verify` 守门都检查什么**：

1. `tsc --noEmit`
2. **期望值是否与生成器同步** —— 重新用 Python 生成一遍
   `scoring-expected.json` / `angle-expected.json` 并比对。
   这一步很关键：如果只改了生成器或只改了实现，提交里的 json 会与生成器脱节，
   而后续的比对仍然"自洽地通过" —— 盲区就这么来的。
3. `verify:parity` 跨语言一致性
4. `set-version.js --check` 五处版本号一致

> 后端评分/角度模块只依赖 `numpy`（mediapipe 是惰性导入），所以守门任务
> 不需要安装 opencv + mediapipe 那 400MB。

### CD：release 分支 / tag → **draft** Release

两条触发都会走到同一个 `release` job（汇总产物 → 生成 `SHA256SUMS.txt` →
`gh release create --draft`）：

- **推 `release/vX.Y.Z` 分支** → 版本号**取自分支名**，创建或**覆盖**该版本的 draft Release。
  迭代时反复推同一条分支即可（`--clobber` 覆盖同名资产），不用打新 tag。
- **推 tag `v*`** → 同上；tag 被当作**定稿动作**，额外允许覆盖**已发布** Release 的资产。

**手动 dispatch 不碰 Release**（只构建）。

🔴 **分支构建不许覆盖已发布的 Release**：目标 Release 若不是 draft，`release/**` 触发会
直接 `::error::` 失败。已发布资产与 `SHA256SUMS` 是**对外契约**（有人下载过、README 的
`releases/latest` 指着它），要发行就往上**升版本号**。

🔴 **为什么停在 draft**：`"构建成功" ≠ "能用"`。mac / iOS 产物至今**没做过真机验证**，
Android 的摄像头链路也只在 v1.3.4 验过一轮。Release 一旦公开就有人下载，
所以留一道人工闸门：

```bash
gh release edit v1.3.8 --draft=false --latest
```

要全自动发布就把 workflow 里的 `--draft` 删掉 —— 但先确认产物真的被验证过。

**CD 里的五道自动检查**：

| 检查 | 拦什么 |
|---|---|
| tag/分支名与 `package.json` 版本一致 | 发出版本号错乱的 Release。允许预发布后缀（`v1.3.8-rc1` 按 1.3.8 校验，这样预演 CD 不用改版本号） |
| 剔除 Android debug 包 | CI 没配签名 secrets 时产出的是 debug 包，**不可分发**，不能当正式资产 |
| 各打包 job 的**同源校验** | 打包成功、程序也能启动，但里面的前端是旧 dist（见下） |
| **上传后回读校验**（2026-09-29 补） | ① 资产**数量**与 `dist-release/` 对不上（少一个端）；② `SHA256SUMS.txt` 里登记的文件名与 GitHub 上的**实际资产名**不一致 |
| **group 按版本归一化**（2026-09-29 补） | `release/v1.7.0` 分支与 `v1.7.0` tag 并发跑、并发写**同一个** Release |

> 🔴 **为什么"上传后回读"非加不可**：`gh release create/upload` 返回 0 **不等于**资产已可查 ——
> 查询接口有**最终一致性延迟**（实测：create 成功 **19 秒后**查 `assets` 仍是 `0`，几十秒后同一对象是 7 个）。
> 只看一次极易误判成"没传上去"。所以这里**轮询**资产数直到对上，匹配不上才算失败。
>
> 而②是另一个更隐蔽的坑：GitHub 会**改写资产名里的连续空白**
> （`NeckGuardian Setup 1.7.0.exe` → `NeckGuardian.Setup.1.7.0.exe`）。
> 生成 `SHA256SUMS.txt` 时若照抄本地名，用户按 Release 说明跑 `sha256sum -c SHA256SUMS.txt`
> 会**整条 FAILED「找不到文件」** —— 产出一份"看起来齐全、实际没法用"的校验文件，
> 而且**只有用户会发现**。现在由 `release` job 把 `SHA256SUMS.txt` 里的名字与线上资产名**逐个 `diff`**。

**🔴 每个版本公开前，对着 draft 逐条过一遍**（自动检查拦不住下面这些，只有人能判断）：

1. **本版各端产物做过真机验证吗？** CI 只证明「可编译可打包 + 包内容正确 +
   内置后端能在 Mac 上起服务」，**不等于真机跑通**（见 §七的验证分层表）。
   没验过的端，要么别发，要么在 Release 正文的「已知限制」里如实标注。
2. **Android 正式包是不是签名包？** 缺 `ANDROID_*` secrets 时 CI 只出 debug 包、
   CD 会自动剔除 → 需本机 `npm run cap:build:release` 出包后
   `gh release upload <tag> <apk> --clobber` 补传，并**验证书指纹与上一版一致**（§9.3）。
3. **Release 正文里的下载链接、文件大小、版本号是否都对**。
   🔴 顺带查**资产名本身** —— 它随版本变过：v1.3.7 是 `NeckGuardian-Android-1.3.7.apk`，
   现在是 `NeckGuardian-<v>-android-release.apk`；**照抄上一版的命名会 404**。
   正文里的 `<版本>` 占位也必须人工替换 —— **CI 只把模板贴上去，不会替换**，
   替换方式就是本节那条 `gh release edit --notes-file <版本专属说明>`。
   （**README 已经不在这条里**：它的下载区 2026-09-27 起改为只指向 Releases 页，见下面的框。）
4. 公开后**匿名 `curl` 验 Content-Type**（§9.4，这一步不能省）；README 的下载入口
   （Releases 页）与**四个资产文件本身**都要匿名验一遍状态码（200 才算通 ——
   资产 404 说明文件名与 README 里写的对不上，403 说明放行没生效）。
   同一条也要覆盖 **README 版本历史表新增的那一行**是否已上线
   （`raw.githubusercontent.com/.../main/README.md`）。

> **README 的下载区（2026-09-27 起，约定由 `npm run verify:readme` 盯着）**
>
> 以前下载表是**逐版本写死**的：`releases/download/v1.6.2/NeckGuardian.Setup.1.6.2.exe` + `188 MB`。
> 产物名与 URL 都带版本号，于是**每发一版都要人工改 README**，漏了就是 404 ——
> 实测漂过（2026-09-15 那版下载表里安卓指 v1.3.4、Windows 指 v1.3.1）。
>
> 现在只放**一个指向 `releases/latest` 的入口** + 「在 Assets 里找这个文件名」，
> **不写版本号、不写体积**（体积在 Release 页每个资产旁就有）。
> 好处：零维护、draft 期间自动指向"上一已发布版"（正是想要的语义）、放行那一刻无需改任何东西。
>
> 🔴 **为什么不走 `releases/latest/download/<稳定文件名>`**（看起来更"永久"）：那条路要求
> 产物名**去掉版本号**（必须逐字符匹配），实测拿稳定名取当前 latest 返回 **404**（旧资产名带版本号）。
> 代价是用户下载到的文件看不出是哪个版本、要重打四端全部产物、且在"第一个稳定名版本被放行"之前
> README 会有一段时间 404。**将来若改走它，`scripts/verify-readme.mjs` 的规则 a/b/c 必须跟着改 —— 别直接删守卫。**
>
> 发版时 README 唯一还要动的地方：**版本历史表加一行**（那是内容，不是会失效的链接）。
5. **真机门未满足却仍要放行？可以，但两件事必须做**：① Release 正文与 README 逐端写明
   「验到哪一步」，全篇不出现"可用"（`device-matrix.md §二.1`）；② 在
   `device-matrix.md §4.3` 留一行放行记录（决定 / 范围 / 措辞）。
   **「已发布」不能被读成「已验证」** —— 这条门的射程是「怎么说」，不是「能不能发」。

> **`.github/release-notes.md` 是 Release 正文模板**：CI 用 `--notes-file` 取它，
> `--generate-notes` 再把 PR 列表追加在后面。**它面向下载者** ——
> 只放「装哪个、怎么装、有什么限制」。发布者自查项写在文件末尾的 HTML 注释里
> （GitHub 渲染时会把注释隐藏，但**别把该给用户看的内容放进去**，它会被吞掉）。

**`SHA256SUMS.txt` 写的是改名后的文件名**：GitHub 会把资产名里的**连续空白压成一个点**
（`NeckGuardian Setup 1.3.7.exe` → `NeckGuardian.Setup.1.3.7.exe`，`d  e.txt` → `d.e.txt`）。
照抄本地名的话用户跑 `sha256sum -c` 会**整条 FAILED「找不到文件」**，所以生成时做了替换。

> ⚠️ **验 draft 资产别只查一次**：列表接口 `GET /releases` 在 release 刚创建时可能返回
> `assets: []`，看起来像"一个都没传上去"（实测：job 成功后 19 秒查是 0，几十秒后同一对象 7 个）。
> 看**单个** release 接口 `GET /releases/<id>` 并隔一会儿复看，别凭一次查询下结论。
>
> 预演 CD 全链路：**推一条 `release/v<版本>-rc1` 分支**即可 —— 版本号按 `-rc1` 前的部分
> 校验，它会**覆盖**该版本已有的 draft 资产，**不留垃圾 Release**；验完删分支：
> `git push origin --delete release/v1.7.0-rc1`。
> （旧做法是打一个一次性 tag（`v1.3.7-cdverify`），验完还得
> `gh release delete --cleanup-tag` 清掉 —— 有了 release 分支就不必了。）
> 已发布的 Release 数量**跑完要核对没变**（防误删）。

### 往已发布的 Release 补资产（CI 产物 → Release）

典型场景：某个端当时没法构建（mac / iOS 曾经如此），先发了能构建的，
事后从 CI 产物补上。v1.3.7 就是这么从「只有 Windows + APK」补成四端齐全的。

```bash
# 1) 先确认 CI 产物的 commit 与当前源码一致 —— 差异必须只涉及非产物文件
git log --oneline <run 的 head_sha>..HEAD
git diff --stat  <run 的 head_sha>..HEAD     # 例如只差 release-notes.md → 可用

# 2) 下载（artifact 名可从 gh api .../runs/<id>/artifacts 拿）
gh run download <run-id> -n NeckGuardian-macOS-arm64 -D /tmp/art/mac-arm64

# 3) 上传。🔴 必须在 git 仓库目录内执行：
#    在 /tmp 里跑会报 `failed to run git: fatal: not a git repository`
gh release upload v1.3.7 /abs/path/xxx.dmg --clobber

# 4) 校验和
```

**已有资产的 sha256 不必下载**：`gh api .../releases/<id>` 的每个 asset 都带
`digest` 字段（形如 `sha256:46525c85…`），直接拿来写进 `SHA256SUMS.txt`。

> ⚠️ **Windows Git Bash 的 `sha256sum` 输出是 `hash *filename`**（二进制模式带星号），
> 而 Linux / CI 上是 `hash  filename`。混着写出来的校验和文件格式不统一。
> 生成时统一用 `printf '%s  %s\n' "$(sha256sum f | awk '{print $1}')" "$name"`。

### 🔴 同源校验：产物里的前端必须是本次构建的 dist

`scripts/verify-same-source.mjs` 逐文件比对 sha256：

| 平台 | 比对的路径 |
|---|---|
| Windows | `release2/win-unpacked/resources/app/dist/assets` |
| macOS | `release2/mac*/NeckGuardian.app/Contents/Resources/app/dist/assets` |
| Android | 解出 APK 后的 `assets/public/assets` |

比的是 electron-builder 保留的**解包目录**与 APK 内**实际资源**，不依赖
7z / hdiutil / apktool —— 也就没有"这工具在 CI 上不好使"的问题
（dmg / zip / NSIS 都只是对同一份应用目录做压缩，内容不变）。

Android 特意用**真 APK 解出来的资源**，而不是 cap 复制过去的中间目录 ——
后者绕过了 AGP 的资源处理（混淆 / 裁剪），存在"中间目录对、包内不对"的可能。

```bash
npm run verify:source -- --packed=<上面表格里的路径> [--base=dist/assets]
```

> ⚠️ 守卫必须用**必然失败的用例**证明它真的会拦：路径写错 / 基准目录拿错 /
> 基准被改一个字节 —— 三种都要 `exit 1`，否则它只是个装饰。

**Android 签名**：提供以下 repository secrets 则出正式包，否则只出 debug 包。
**已于 2026-09-23 配置完毕**，CI 现在直接产出可分发的签名包。

| Secret | 内容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | keystore 的 base64（见下） |
| `ANDROID_STORE_PASSWORD` | keystore 口令 |
| `ANDROID_KEY_ALIAS` | `neckguardian` |
| `ANDROID_KEY_PASSWORD` | key 口令 |

配置方式（**别把口令写进命令行** —— 会进 shell 历史与进程列表，用管道喂进去）：

```bash
cd <repo>
KS=E:/AndroidDev/keystore/neckguardian-release.jks
P=android/keystore.properties

base64 "$KS" | tr -d '\r\n' | gh secret set ANDROID_KEYSTORE_BASE64
grep -m1 '^storePassword=' "$P" | cut -d= -f2- | tr -d '\r\n' | gh secret set ANDROID_STORE_PASSWORD
grep -m1 '^keyAlias='       "$P" | cut -d= -f2- | tr -d '\r\n' | gh secret set ANDROID_KEY_ALIAS
grep -m1 '^keyPassword='    "$P" | cut -d= -f2- | tr -d '\r\n' | gh secret set ANDROID_KEY_PASSWORD

gh secret list   # 应出现 4 条
```

> 注意 `gh secret set` **必须在 git 仓库目录内执行**（或在项目目录下跑），
> 否则报 `failed to run git: fatal: not a git repository`。

**怎么确认 secrets 真的生效**（三处证据，缺一不可）：

| 证据 | 看哪里 | 期望值 |
|---|---|---|
| 走了签名分支 | Android job 日志 | `检测到签名配置 → 构建 release 包` |
| 产出的是正式包 | job 日志 / 产物名 | 源文件 `apk/release/app-release.apk`，产物名带 **`-release`** 而非 `-debug` |
| **签名指纹与上一版一致** | CI 步骤「校验签名证书指纹（须与历史一致）」的日志 | SHA-256 `9adaa8b2…` |

🔴 **第三条是发布前必查项**：APK 的文件 sha256 每次构建都不同（时间戳等），
**但证书指纹必须逐位相同**。指纹一变，老用户就**无法覆盖安装**（会提示签名冲突），
只能卸载重装、数据全丢。所以 secret 里的 keystore 必须与历史发布用的是同一把。
**2026-09-24 起 CI 会在打包后自动比对并 fail**，本地只需在换过密钥时用下面这条自查：

```bash
AS="$ANDROID_HOME/build-tools/34.0.0/apksigner"
JAVA_HOME=<jdk17> "$AS" verify --print-certs <apk> | grep 'certificate SHA-256'
# 期望：9adaa8b20c384eae1a6ed4f57dbd2d98b3965838f0661c2b88fca3031b3a2bd5
```

⚠️ 本机 keystore 在 `E:/AndroidDev/keystore/neckguardian-release.jks`。
**丢了就永远无法给老用户推更新**，务必多备份（备份在 `E:/AndroidDev/keystore/`）。

⚠️ keystore 是**上传到 GitHub 的**（经 base64 存进 secret）。仓库是 public，
但 Actions secrets **不可被读取**（连 admin 也只能覆盖不能查看），且日志里会被打码；
fork 的 PR 拿不到 secrets。若日后仓库改用「允许 fork PR 跑 workflow」，需重新评估。

---

## 五、版本号：五处同步

```bash
node scripts/set-version.js 1.4.0      # 改版本号（版本变了自动 +1 versionCode）
node scripts/set-version.js --check    # 校验五处一致（CI 用）
```

| # | 位置 | 用途 |
|---|---|---|
| 1 | `package.json` | electron-builder / 构建期注入 `__APP_VERSION__` |
| 2 | `backend/config.py` | `/api/health` 与 `/api/settings` 返回的版本 |
| 3 | `src/pages/Settings.tsx` | 拿不到原生版本时设置页的兜底显示 |
| 4 | `android/app/build.gradle` | `versionName` + `versionCode`（安卓强制递增） |
| 5 | `ios/App/App.xcodeproj` | `MARKETING_VERSION` + `CURRENT_PROJECT_VERSION` |

`--check` 在 CI 里跑。版本号不一致的表现是"设置页显示的版本和安装包对不上"
或"安卓覆盖安装失败"，都属于事后极难定位的问题。

---

## 六、图标

| 产物 | 生成方式 | 用在哪 |
|---|---|---|
| `public/icon.ico` | `scripts/generate-icons.js`（sharp + png-to-ico） | Windows 安装包 / 窗口 |
| `public/icons/*.png` | 同上 | Linux |
| `public/icon.icns` | `scripts/gen-mac-icons.js` | macOS 应用图标 |
| `public/tray-icon.png` | `scripts/generate-icons.js` | Windows/Linux 托盘 |
| `public/tray-iconTemplate.png`(+`@2x`) | `scripts/gen-mac-icons.js` | macOS 菜单栏 |

```bash
npm run icons:generate    # 三个脚本一起跑：桌面 ico/icns/菜单栏图 + iOS 图标与启动图 + 安卓启动图
```

关于 `.icns`：本机（Windows）没有 `iconutil`，所以 `gen-mac-icons.js` 直接
按 Apple 的 ICNS 容器格式打包（文件头 + 若干 `(OSType, 长度, PNG)` 块），
写完会**回读并逐块用 sharp 解码校验**尺寸。

关于 macOS 菜单栏图：必须是**纯黑 + alpha** 的"模板图"（彩色图在深色菜单栏下看不见），
尺寸 16pt 并配 `@2x`。文件名以 `Template` 结尾会被 Electron 自动识别。

---

## 七、已知限制

| 限制 | 影响 | 状态 |
|---|---|---|
| 安卓/iOS 不支持后台常驻 | App 切后台后提醒停止（WebView 被系统冻结） | 需原生前台服务，未实现 |
| 真实推理帧率未实测 | 不知道低端机能否跑到 15fps | 未测 |
| iOS 未在真机验证 | 摄像头链路只有静态推导，无实测 | **待用户验证** |
| macOS 未在真机验证 | 同上 | **待用户验证** |
| **iOS 没有"可安装产物"** | CI 产出的是未签名 `.xcarchive`（开发者归档），**不是 IPA**，普通用户装不上；要装到设备必须由持有 Apple 开发者证书的人用 Xcode 重新签名导出 | 无 Apple 开发者账号，属预期 |
| mac 包未签名、未公证 | 用户下载后首次打开会被 Gatekeeper 拦（"无法验证开发者"），需右键→打开或 `xattr -dr com.apple.quarantine` | 无 Apple 开发者账号，见 §3.2 |

**macOS / iOS 目前"验证到了哪一层"**（2026-09-23，别把"CI 绿"读成"能用"）：

| 层次 | macOS | iOS | 手段 |
|---|---|---|---|
| 能构建 / 能归档 | ✅ CI 真机 runner | ✅ CI 真机 runner | `desktop-macos` / `mobile-ios` job |
| 产物结构正确（权限声明、后端架构、可执行位） | ✅ 已断言 | ✅ 已断言 | CI「校验包内关键资源」/「校验归档产物」 |
| 包内前端 = 本次 dist（逐文件 sha256） | ✅ | ✅ | `verify-same-source.mjs` |
| **内置后端能在 Mac 上真跑起来** | ✅ 已断言 | —（iOS 无后端） | CI「后端启动冒烟」轮询 `/api/health` |
| Electron 窗口能起、摄像头出画面 | ❌ **未验** | ❌ **未验** | 只能人工在真机跑 |
| 签名 / 公证 / 可安装 | ❌ 未签名 | ❌ 未签名（连 IPA 都没有） | 需 Apple 开发者账号 |
| 移动端历史数据不跨端同步 | 换手机数据不带过去 | 设计如此（隐私优先） |
| 跨版本分数刻度变化 | v1.3.6 改了评分公式，旧记录分数与新公式刻度不同 | 统计图表跨版本处有落差 |

---

## 八、新增一个平台要改什么

以"未来支持 Linux 桌面"为例，实际上**已经支持**（`electron-builder.yml` 里有
`linux` 目标）—— 这就是能力矩阵的价值。真要从零加一个平台：

1. `src/platform/runtime.ts` —— 加进 `RuntimePlatform` 与 `CAPABILITIES` 表
2. `src/platform/nativeDiag.ts` —— 若是移动端，加一个诊断 provider
3. `capacitor.config.ts` 或 `electron-builder.yml` —— 构建配置
4. `package.json` —— 构建脚本
5. 本文件与 [DEVELOPMENT.md §2.1 平台矩阵](DEVELOPMENT.md)（README 只给用户看，不放架构细节）
6. `.github/workflows/build.yml` —— 加一个 job

**不要**改 `src/pages/**` 与 `src/components/**`。

---

## 九、发布前验证清单

**"构建成功"不等于"产物可用"。** 下面每一条都是可复现的证据，不是"看起来对"。
踩过的坑都标了 🔴。

### 9.0 🔴 真机验证（这是**门**，不是补充项）

清单再全也证明不了「用户装上去能用一遍」。**每个要对外说"可用"的平台，
必须在 [device-matrix.md](device-matrix.md) 里至少有一行「通过」记录**，
含固定 7 条路径逐条结论 + 可复现证据（命令输出 / 截图 / 录屏）。

- [ ] Android：`device-matrix.md` 有通过行（重点：**「拒绝权限后再允许」**一条必须真机走）
- [ ] macOS：有通过行（含 Gatekeeper 处理、摄像头链路）
- [ ] Windows：有通过行（**装安装包**验，不是跑开发模式）
- [ ] iOS：无通过行时，任何对外的 iOS「可用」表述都不成立（当前缺付费开发者账号，
      产物是未签名归档 —— 如实写「不可安装」，见需求 3）

🔴 **换过签名密钥 / 改过权限桥 / 改过 `Info.plist` / 动过打包配置后，对应行作废、必须重验。**
这三处是"改一行、崩一片"的典型，而 CI 对它们**一无所知**（能构建、结构对、就是装上去不能用）。

### 9.1 通用（先跑，不过就别打包）

**前提**：这些要在 `release/v<X.Y.Z>` 分支上跑（见 [BRANCHING.md](BRANCHING.md)）。
`main` 上跑过同一套守门，但**发版这一轮的结论只能以发版分支上的这次为准**。

```bash
npm run verify:all          # 数值对拍 + 各守卫（含 verify:ci）+ 五处版本号一致性
npm run verify:backend      # 后端产物 magic bytes 与目标平台匹配
npm run build:web           # UI 冒烟需要 dist（下一行依赖它）
npm run verify:ui           # 界面渲染 / 路由 / 平台判定（无头 Chrome，5 平台 × 3 页 + 新手引导 + 收尾屏）
```

- [ ] `verify:parity` 全通过：24 常量 + 80 评分用例 + 439 帧平滑 + 8 角度 + 不变量
      + 运动态 32 用例 + 语音隔离 + 部位健康度 9 常量 + 3 映射 + 18 用例（含取整灵敏度自检）
      + 动作完成度 24 常量 + 3 段离线样本 + 39 用例（含取整灵敏度自检）+ 幅度口径反例 3 条 + 时间支撑反例 6 条
- [ ] `set-version --check` 五处版本号一致
- [ ] `verify:ci` 通过（工作流的触发条件与 `--draft` 闸门没被改坏）
- [ ] `verify-backend --target=<平台>` 通过（🔴 在 Windows 上传 `--target=mac` **必须 exit 1**；
      测退出码不要接管道，`| tail` 会把 `$?` 换成 tail 的）

### 9.2 桌面包

- [ ] 🔴 **同源**：包内 `resources/app/dist/assets/index-*.js` 与本地 `dist/assets/` **md5 逐位一致**。
      不一致 = Release 里躺的是旧代码，"发布产物必须由当前源码构建"是硬要求
- [ ] 包内 `resources/app/package.json` 的 `version` = 本次版本号
- [ ] exe 的 `FileVersion` / `ProductVersion` = 本次版本号
- [ ] 🔴 包内 **`resources/public/` 必须不存在**。它一旦存在，说明有代码在按 `public/` 找资源——
      而那个目录打包后根本不存在。历史 bug 就栽在这里：托盘图标静默空白、零报错
- [ ] `resources/neckguardian-backend/` 下有后端可执行文件，且**验证时产生的 `data/` 已删**
      （否则把含测试数据的 DB 发给用户）
      ✅ **2026-09-29 起 CI 已自动做「后端启动冒烟」**：在 Windows runner 上跑**解包后的** exe、
      等 `/api/health` 且 `status=ok`。它能抓到 PE 能执行 / 端口能监听 / DB 能初始化 / 路径解析正确；
      ⚠️ **验不到的**（仍需人工在真机跑）：安装器 UI、Electron 窗口、摄像头链路、SmartScreen 拦截
      —— 见 §9.8 的"验不到"清单，别把它读成"验过了"

### 9.3 安卓 release APK

- [ ] 🔴 **签名指纹与上一版逐位一致**（`apksigner verify --print-certs` 的 SHA-256，期望
      `9adaa8b20c384…`）。APK 的**文件** sha256 每次构建都不同，**但证书指纹必须相同** ——
      指纹一变，老用户只能卸载重装（签名冲突），本地数据全丢。CI 出的包**尤其要查**：
      secret 里 base64 解出来的 keystore 可能与本机用的不是同一把。
      该值记录在 [ANDROID_BUILD.md §3.4](ANDROID_BUILD.md)，每次发版对照
      ✅ **2026-09-24 起 CI 已自动拦**：Android job 的「校验签名证书指纹（须与历史一致）」
      步骤会把期望值写死在 workflow 里逐位比对，不一致直接 fail。手工只需在**换过密钥**时
      判断"这次是不是有意的"——若无意的，这一步会在发布前拦住，不必等用户装不上
- [ ] `aapt dump badging`：`package` 正确、`versionCode` **已递增**、`versionName` 正确、
      `uses-permission` 含 CAMERA
- [ ] APK 内 `assets/public/assets/index-*.js` 与本地 `dist/assets/` md5 一致
- [ ] 无 `assets/public/main.js` / `preload.js`（Electron 入口误入 = 打错了构建目标）
- [ ] mediapipe 资源 5 项齐全（模型 + 4 个 wasm）
- [ ] 🔴 启动图**不要按文件名找**。release 包资源名会被 AGP 混淆
      （`drawable-port-xxxhdpi/splash.png` → `res/YH.png`），搜 `splash` **一个都匹配不到**，
      极易误判成"没打进去"。正确做法是**按 PNG IHDR 解析像素尺寸**，与源码做集合比对：

      ```python
      import struct
      def png_size(d):
          assert d[:8] == b'\x89PNG\r\n\x1a\n'
          return struct.unpack('>II', d[16:24])   # IHDR 宽高在固定偏移
      ```

- [ ] `JAVA_HOME` 指向**真正的 JDK 根**（形如 `E:/AndroidDev/jdk/jdk-17.0.20.1+1`，不是其父目录），
      否则 `apksigner.bat` 报 `invalid directory`

### 9.4 发布后（必做，不能省）

- [ ] 🔴 **匿名 curl 验 Content-Type**（不带 token）：
      APK 必须是 `application/vnd.android.package-archive`，否则手机当普通文件下载、**点开装不上**。
      `gh release view` 只能证明"传上去了"，证明不了"能装"
- [ ] 匿名 curl 的 `Content-Length` 与本地文件字节数一致
- [ ] Release 已标注 **Latest**（`gh release list` 看 Latest 列）

### 9.5 多端同时出包时的顺序

`vite build` 产出的 `dist/` 是**桌面包与移动包的共同输入**，但两者构建目标不同
（`__BUILD_TARGET__` 注入值不同 → chunk 内容不同），所以**必须串行**：

1. 桌面：`vite build` → PyInstaller → electron-builder
2. 移动：`cap-build`（**会覆盖 `dist/`**）

🔴 **同源验证要在各自构建完成后立刻做**，拖到下一步就被新的 `dist/` 覆盖，再也没法比了。

### 9.6 推送仓库的前置检查

- [ ] 🔴 要推 `.github/workflows/**` 的，**先确认"当前实际生效"的那把凭据有没有 `workflow` scope**。
      GitHub 会**整体拒绝**这次 push（不是跳过那几个文件），
      报错形如 `refusing to allow an OAuth App to create or update workflow ... without 'workflow' scope`。

      本机常见**两把凭据并存**（2026-09 实测）：**GCM**（`credential.helper=manager`）带 `workflow`；
      **gh 自带 token** 只有 `gist, read:org, repo`。查法：

      ```bash
      TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
      curl -sI -H "Authorization: token $TOKEN" https://api.github.com/ | grep -i '^x-oauth-scopes'
      ```

      ⚠️ **最常见的真凶是自己的命令行**：为"指定身份"写了
      `git -c credential.helper= -c credential.helper='!gh auth git-credential' push`，
      这一行会把能用的 GCM **换成** gh 的弱 token。**去掉这个覆盖**即可，用户无需做任何操作。
      确认确实缺 scope 才走 `gh auth refresh -h github.com -s workflow`。

      🔴 **2026-09-23 二次踩到**：明知这条还照踩 —— 因为 push 命令是从"发布流程"里
      复制来的，那行覆盖就在里面。**推 workflow 前先想 3 秒**：这条命令里有没有
      `credential.helper` 覆盖？有就先删掉再推。

### 9.7 macOS / iOS 产物（CI 产出，已固化为 CI 断言）

下面这些**打包成功完全保证不了**，但缺任何一项都等于"装上去用不了"，
且报错方向极易跑偏 —— macOS / iOS 缺 `NSCameraUsageDescription` 时，
进程是被系统**直接终止**的，看起来像崩溃，**不像**权限问题。

CI 里已断言（`desktop-macos` 的「校验包内关键资源」「后端启动冒烟」、
`mobile-ios` 的「校验归档产物」），人工复核用同一组命令：

```bash
APP="release2/mac-arm64/NeckGuardian.app"
/usr/libexec/PlistBuddy -c 'Print :NSCameraUsageDescription' "$APP/Contents/Info.plist"
file "$APP/Contents/Resources/neckguardian-backend/neckguardian-backend"    # 架构必须等于本包架构
ls -l  "$APP/Contents/Resources/neckguardian-backend/neckguardian-backend"  # 必须有 x 位
"$APP/Contents/Resources/neckguardian-backend/neckguardian-backend" &       # 起得来吗
curl -fsS http://127.0.0.1:18920/api/health
```

- [ ] 主 Info.plist 有 `NSCameraUsageDescription`（注意是**主** `.app/Contents/Info.plist`，
      不是 `Frameworks/…Helper*.app` 的）
- [ ] `NSMicrophoneUsageDescription`：macOS **要有**（托盘语音提示用）；iOS **要没有**
      （`audio: false`，故意不声明；出现了说明配置漂了）
- [ ] 🔴 内置后端 `file` 输出 = 本包架构（`arm64` / `x86_64`）。
      这是 2026-09-23 那个 bug 的重灾区：`electron-builder.yml` 的 `target` 层若写死 `arch`，
      arm64 runner 打出的 **x64 包里会装 arm64 后端**，且日志全绿
- [ ] 后端**保留可执行位**（zip 内 `external_attr>>16` 应为 `0o755`；丢了 spawn 报 EACCES）
- [ ] 后端能起来且 `/api/health` 返回 `{"status":"ok",…}`
      —— 这是**唯一**能自动化回答"这个包在 Mac 上到底能不能跑"的手段（macOS runner 就是真 Mac）
- [ ] `Contents/Resources/public/` **不存在**（同 §9.2 的托盘图标坑）
- [ ] 🔴 桌面包里**不该有** `dist/mediapipe/`：桌面走 Python 后端，MediaPipe 资源只给移动端。
      本地先跑过 `cap:build` 再打桌面包，`dist/mediapipe/`（约 28 MB）会被
      `files: dist/**/*` 原样捎进安装包 —— 和"别放 `public/`"是同一类问题
- [ ] iOS：归档内 `App.app/Info.plist` 的 BundleID / 版本 / `NSCameraUsageDescription`；
      主二进制为 Mach-O arm64；**无** `embedded.mobileprovision`
      ⇒ 未签名归档，**不可安装**，分发需另行签名导出 IPA

---

### 9.8 UI 冒烟：`npm run verify:ui`（界面层的第一道网）

数值层（`verify:parity`）与产物层（`verify:source` / `verify:backend`）之间，
一直空着「**界面还画得出来吗**」这一层：

> `vite build` 成功、`tsc` 通过、产物 sha256 对得上，
> 但页面白屏 / 路由指不到 / `?platform=` 覆盖失效 —— 现有守卫全是绿的。

这正是需求 1 里"最便宜的一道网"。

**它做什么**：无头 Chrome（CDP 直连）+ Node 内置静态服务，把
**5 种运行时平台 × 3 个路由**真实渲染一遍，再在每个平台组合上**走一遍新手引导**与**活动收尾流程**，
并在两个**移动端**组合上把一份**假摄像头帧表真的喂进浏览器**（见 §9.9），
共 **305 项断言**：

| 断言类别 | 抓什么 |
|---|---|
| 应用壳渲染 | 启动闸门后面的白屏（`readyState` 完成 ≠ 界面出来了） |
| 路由渲染 | 三页各自的标题 / 关键区块文案在位 |
| **导航交互** | 真的**点击**导航项（`<a href="#/...">`）切页，且**没有整页刷新**（哨兵存活） |
| **平台判定** | 桌面/移动**互斥文案的出现与消失**都要对（只查"应有出现"抓不到 `isMobile()` 恒 false） |
| 平台自述 | 设置页显示的 `平台：<名>（桌面端/移动端）` = URL 覆盖声明的平台 |
| 版本一致 | 界面自报版本 = `package.json` 版本（五处/六处同步漏一处，界面层也能抓到） |
| 摄像头流程落定 | 🔴 **不能永久停在「正在启动摄像头...」** —— "卡 loading 而非报错"是本项目踩过的一类真 bug |
| **新手引导（首次打开）** | 清标志重载后引导出现 → **逐步走完 4 步（每步标题都要变）** → 「开始使用」后遮罩消失 + 「已看过」标志**真的落盘** → **再次打开不再出现** → 设置页「重新查看」能唤回且从第 1 步开始 → 「跳过」能关掉且不清标志 |
| **引导的平台差异** | 第 2 步「手机架在面前 / 摄像头对准自己」、第 4 步「系统托盘 / 不会常驻后台 / 开机自启」—— 措辞必须与 `runtime.ts` 的**能力矩阵**一致，且**互斥**（出现与消失都断言） |
| **引导的布局兜底** | 视口压到 **375×340**（刻意比任何在售机型都矮）：卡片必须仍被**限制在视口内**且**可滚动**。少了 `maxHeight` / `overflowY`，底部主按钮会被推出屏幕，而遮罩挡着底层、页面又不能滚 ⇒ 用户**卡死在引导里**。⚠️ 这一步压的是**兜底**，不是"真实小屏有问题"：当前文案实测卡片高 **376px**，真实小屏放得下 —— 用真实尺寸断言会得到一条永远绿的断言（变异 O10 第一次就是这么发现没牙的） |
| **活动收尾屏** | 点「开始活动」→「结束活动」后：逐动作得分列表在位、**零明细时成绩显示 `--`（不是 0）**、7 个动作**逐个**如实标「未判定」、旧口径标签已消失 |
| **收尾结果真的落库** | 拦 `fetch` / 读 IndexedDB 两条路都查：`action_scores` **逐字节等于规范文本**、`avg_score` **与明细同源** |
| **假摄像头 · 实时引导 / 实时徽章**（移动端） | CDP 在 **document-start** 注入一条 `canvas.captureStream()` 假摄像头，按**墙上时间定长**喂 10 秒（起势 1 帧 + 拉伸帧）：帧真的走完 MediaPipe（姿态读数 ≥ 5°、`<video>.currentTime` 在前进）⇒ **浮层真的渲染出来了**（`liveQuality` 不再恒为 `null`）⇒ 认出「幅度够了」⇒ 🔴 **徽章与提示不矛盾**（`idle ⟺ 0 分`，否则 `≥80 ⟺ completed`）⇒ 收尾判成 `completed`、落库明细 v3 只 1 项且 **id = `neck-flex-left`**、`avg_score` 同源。**两个帧率下界来自 fixture、各有各的问题**：`rate_floor`（离线扫描最低档）/ `rate_floor_browser`（浏览器实测可信下界）—— 见 §9.9 的决策表，**低帧率本身不判红** |
| ↳ **这一轮的环境够不够采信**（同一条断言内） | 判据**两轴交叉**（帧率 × 结论），只有一处实现 `trustCameraRound()`：帧率 ≥ 门或（低帧率但结论与 fixture 一致）⇒ 采信；否则整段重试一次，两轮都不采信才报「环境不足」。🔴 **"低帧率"不是失败理由** —— 实测 CI 被挤到 1.5 帧/秒时，段内下游会红 10 条、条条"帧没进来"，方向全错（§9.9 有决策与实跑证据） |
| ↳ **徽章锚点必须读得到**（同一条断言内） | 🔴 徽章按 `data-ng="*-score"` 锚点读，且**"提示在屏上时徽章必须有读数"本身是断言的一部分**。这条是**被变异测试逼出来的**：原来靠 `p「实时动作达成度」` → `parentElement` → `span` 找，可**移动端练习条上的徽章根本没有那个 `<p>`** ⇒ 读数恒为 `null` ⇒ 一致性循环整段 `continue`，断言一路"✓"却**一次都没检查过任何东西**（变异 M5 漏网才暴露）。另：页面上**每一处** `data-ng="*-score"` 都要逐个查，不是只查第一个 |
| **历史行回读** | 回仪表盘读一遍（写→读→解析→渲染整条链）：零明细显示 `--`；🔴 注入一条**没有 `action_scores` 键**的老记录，断言它**照常显示分数**且被标出「旧口径」；再注入 **v1 与 v2 明细各一条**（形态合法、分数是当年口径）同样断言，并断言说明文案里**分别出现「（v1）」「（v2）」** —— `NULL` 与 `legacy` 走的是 `parsed === null` / `parsed.legacy` **两条不同分支**（只插一条证不到另一条），而 legacy 内部 v1/v2 的**理由并不相同**（用一句话糊过去 = 拿一个错的理由解释一个不可比的数字） |
| 运行时错误 | 未捕获异常、非预期控制台错误、非预期资源 404（后端 / MediaPipe 的预期失败已明确白名单） |

> 🔴 **新手引导那一段必须跑在路由断言之前**：引导的遮罩盖在页面上，但下层**仍挂在 DOM 里**，
> `innerText` 两层都读得到 —— 开着遮罩去断言页面文案，等于把"被盖住了"验成"渲染得出来"。
> 同理，它每个平台组合都要**先清掉 `localStorage` 标志再重载**：同一浏览器 profile 下
> `localStorage` 跨用例共享，不清的话从第二个平台组合起引导根本不出现，
> 而"没出现"会被读成通过（见 DEVELOPMENT 铁律 #55）。
>
> ⚠️ **验不到的部分**：引导与提醒弹窗的互斥（无头环境里没有提醒会弹）、
> `localStorage` 写不进去时的降级（隐私模式）—— 都只在真机上看得出来。
> v1.7.0 那条「实时徽章与实时提示同源」**自 v1.7.1 起才真的被检查到**：
> ① 有帧了（见 §9.9 的假摄像头段），不再只走到回落分支；
> ② 那条一致性断言的**锚点原来选错了**（移动端没有 `p「实时动作达成度」`），
> 读数恒 `null`、整段跳过 —— 是变异 M5 漏网才把它挖出来，同轮修好锚点并补了"锚点必须读得到"。
>
> ⚠️ **低帧率下"通过"的那些轮**（`rate_floor` ≤ 帧率 < `rate_floor_browser`）：结论仍被采信
> （它确实与 fixture 一致），但那一段的**环境本身没达标**（实测 1.6 帧/秒就判不出 `completed`），
> 所以这种轮会打一条**显式 ⚠**、`run` 仍绿 —— 读线报时要知道那些浮层/徽章断言是在**偏挤的环境**下验的。
> 这是 v1.7.1 的取舍（"不为一个已经正确的读数判红"），判据与实跑证据见 §9.9。

```bash
npm run build:web                                  # 冒烟跑的是 dist
npm run verify:ui
node scripts/verify-ui-smoke.mjs --case=android     # 只跑一个平台组合
node scripts/verify-ui-smoke.mjs --dist=.buildenv/dist-x   # 指向别的产物目录（变异测试用）
node scripts/verify-ui-smoke.mjs --evidence=.buildenv/ui-shots   # 顺带出截图（15 张）
node scripts/verify-ui-smoke.mjs --dump             # 守卫失败时打印页面实际文本，别猜
```

**为什么不用 playwright / puppeteer**：① 不该让一个"便宜的门"拖 100MB+ 浏览器进 CI，
而本机与 CI runner 本来就有 Chrome；② **依赖越少，守卫自己坏掉的概率越低 —— 守卫坏了会伪装成全绿**。

**🔴 找不到浏览器时必须显式失败，不许静默跳过**：一个"检测不到就不查"的守卫，
等于一个永远绿的守卫。指定路径用 `NG_CHROME` / `CHROME_PATH`。

**它不覆盖什么**（别读成"UI 已经验过了"）：**真实摄像头设备与权限层**（注入的是一条
`MediaStream`，不是真设备 —— 「申请授权 / 被拒绝 / 切前后台重新取流」仍然只能真机验；
验的是 **app 侧**：attachVideo → 本地引擎 → 帧 → 判定 → 界面）、**时间轴的绝对值**
（"第几秒该出现哪句文案"依赖真实帧率，只断不变量与存在性）、
**桌面端（web / electron）的实时引导**（浮层是移动端专属，桌面走 WS 发帧给 Python 后端，
无头环境里没有后端）、样式与视觉回归、真机 WebView 行为 —— 后者见
[device-matrix.md](device-matrix.md)。
> 有帧时的行为自 v1.7.1 起**已进自动化**（§9.9 + 上面的「假摄像头」一行）；
> 但"这份 fixture 的读数在浏览器里与离线相同"仍**只**在 UI 冒烟那一份帧表上被证过，
> 七个登记案例的期望角度**仍是离线预测值**。

**守卫的有效性用变异测试证明**（路线图需求 1 的验收硬条件）。
`.buildenv/mutate-ui-smoke.py` 植入 7 种回归并要求冒烟**退出码非 0 且原因指向正确那一处**：

| 变异 | 期望被哪条断言抓住 |
|---|---|
| M1 删掉 `/settings` 路由 | `#/settings` 渲染超时 |
| M2 `runtime.ts` 不再采纳 `?platform=` 覆盖 | 移动端平台断言（互斥文案 / 平台自述） |
| M3 Dashboard 页头文案写坏 | `#/dashboard` 渲染超时 |
| M4 只改 `package.json` 版本（模拟 set-version 漏同步） | 设置页自报版本不一致 |
| M5 `activityScore` 改回运动态通道（v1.7.0 修掉的那个缺陷） | `实时徽章与实时提示不矛盾` |
| M6 `liveQuality` 恒为 `null` | `浮层真的渲染出来了` |
| M7 整段判定用错标称时长 | `判成 completed` |

⚠️ 变异测试**不进 CI**（要重构建 7 次，实测约 14 分钟）：它验的是"守卫本身有效"，
属于**改动守卫时**才跑的一次性证据，不是每次提交都跑的门。

🔴 **变异抓到过守卫自身的缺陷，不止一次** —— 这正是"变异不是走形式"的证据：
- **M5 第一轮漏网**：不是变异无效，而是那条一致性断言的**锚点选错了**（移动端练习条上
  没有 `p「实时动作达成度」`），读数恒 `null`、循环整段 `continue` ⇒ 断言恒绿却什么都没查。
  同轮修法：锚点改成挂在 `ScoreGauge` 上的 `data-ng`，并把"锚点读得到"写进断言；
  顺带发现并修掉移动端练习条徽章读 `score`（不同源）这个**真缺陷**。
  ⇒ 教训：**"断言绿"与"断言查过东西"是两件事**，凡读 UI 的数都要有一条"锚点存在"的断言兜着。
- 另有两条断言曾只看 `includes('--draft')` / `conc.includes('refs/tags/')`，
  被别处同形字符串满足 —— 断言必须落到**最小作用域**（那一行 / 那个参数）。

**活动收尾屏那一段单独一套变异**（`.buildenv/mutate-ui-done.py`，8 条）：

| 变异 | 期望被哪条断言抓住 |
|---|---|
| U1 零明细时成绩显示 0 而不是 `--` | `无明细时成绩显示 --（不是 0）` |
| U2 逐动作明细只列前 3 个 | `7 个动作全部如实标「未判定」` |
| U3 明细标题被改掉 | `列出「逐动作得分」` |
| U4 旧口径「平均达成度」留在收尾屏 | `不再出现旧口径「平均达成度」` |
| U5 落库时丢掉 `action_scores` | `落库的 action_scores 是规范文本` |
| U6 `avg_score` 不给 `sessionScoreOf` | `落库的 avg_score 与明细同源` |
| U7 老记录不再标「旧口径」 | `老记录被标出「旧口径」` |
| U8 老记录的成绩不显示 | `老记录（无明细）照常显示分数` |

跑法（**必须用全新 outDir**，理由见 `DEVELOPMENT.md` 铁律 #53）：

```bash
python .buildenv/mutate-ui-done.py            # 全部 8 条（本机可能超时，见下）
python .buildenv/mutate-ui-done.py U7 U8      # 只跑子集，日志另存一份
```

⚠️ 本机单条命令有时长上限，整轮 8 条（每条都要重新构建）**跑不完会被 SIGTERM 打断**。
所以脚本装了信号处理器（收到就把源码写回原字节），并且**收尾自检是"整文件与运行前逐字节相同"**
—— 上一版没做这两件事，实测留下过一处没还原的变异，而我只抽查了另外三个锚点，**没发现**。

### 9.9 假摄像头案例（`scripts/fake-camera/`）

**它填的坑是 §9.8 里最贵的那条「不覆盖」**：无头环境没有摄像头 ⇒ 有帧时的链路
（实时徽章 / `localQuality`）在自动化里从来没验过，只在真机人工看过。

**做法**：先造一份**可控的摄像头输入**（6 帧 640×480 画面素材 + 7 个案例序列），
再让**真实现**跑出期望判定并存成 fixture（`scenarios.json`）。细节与全部实测数字见
[`scripts/fake-camera/README.md`](../scripts/fake-camera/README.md)。

```bash
.buildenv/Scripts/python.exe scripts/fake-camera/build-frames.py   # 重测素材 + 重放 7 个案例并对登记值（需 mediapipe）
npm run verify:fake-camera                                        # 同一 fixture 喂给 TS 实现，双端六字段对拍（纯 node，已进 CI）
python scripts/fake-camera/make-y4m.py --case=completed --out=/tmp/c.y4m   # 生成假摄像头供片盘
```

**为什么它值得进 CI 而多数 fixture 不值得**：断言只用**已落盘**的逐帧序列，
所以那条 node 守卫**不需要 mediapipe**；只有"重新生成案例"才要。分工写在 README 里。

**两条实测结论（写进文档，别只在代码里）**：

1. 🔴 **`PoseDetector` 的跟踪模式在「完全静止的人」身上会漂**：60 秒内 `head_angle`
   0.84° → 4.91°（≈0.07°/s，不收敛）。后果是 `ACTIVITY_IDLE_MAX = 0.25` 对
   「检到人的静止画面」**不可达** —— 真人一动不动会被判 `insufficient`/「幅度还不够」，
   **不是** `idle`；但 **伪造不出 `completed`**（最坏 `peak_activity = 0.400`，只有
   `ACTIVITY_ONSET = 1.0` 的 40%）。这条已作为**语义偏差**登记在 fixture 里。
2. 🔴 **同一张图在不同重采样路径下 `head_angle` 差 1.3°**（1024×768 直送 2.27° vs
   640×480 + q70 0.97°）⇒ fixture 的期望角度是**预测值**；真要拿去断言 app 侧读数，
   **必须先复核余量**（哪几条有翻转风险，README 的余量表里逐条列了）。

**注入浏览器已实测可行，且自 v1.7.1 起已接线进 `verify:ui`**。
两条路都试过，最终用的是**第二条**：

| 路子 | 做法 | 结论 |
|---|---|---|
| A. Chrome 官方开关 | `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream --use-file-for-fake-video-capture=<a.y4m>` | 实测可行（`<video>` 640×480、8 秒推进 39 帧 ≈ 5fps，正好等于桌面端 `setInterval(captureAndSend, 200)`），但①相位不可控 ②y4m 26MB 不入库 ③一个 Chrome 实例只能喂一个文件 |
| **B. CDP 注入（采用）** | document-start 注入 `canvas.captureStream(0)` + `track.requestFrame()`，覆写 `getUserMedia` | 纯 JS、几 KB、帧表与节奏完全可控、能与现有冒烟共用同一个 Chrome |

路 A 的两个坑（**踩过，别重踩**）：

- Y4M 头的色度标记必须是 `C420mpeg2`，帧率写 `F5:1`，且要和 fixture 的 `capture` 一致；
- 🔴 **不能靠 `--dump-dom --virtual-time-budget` 读结果**：虚拟时间会被**未决的媒体请求**
  挂住（`getUserMedia()` 的 Promise 既不 resolve 也不 reject）⇒ dump 出来永远是初始状态。
  实测第一版打印 `0:start`，**看上去像「y4m 不行」，其实探针根本没跑**。必须连 CDP 用真实等待。

路 B 的三个坑（**少一个就静默失效**）：

1. **必须在 document-start 注入**，而那时 `document.documentElement` 还是 `null` ⇒ 直接
   `appendChild` 会抛、整段注入**静默失效**（症状是 `window.__ngFakeCam === undefined`，
   界面照常渲染，看着像"注入没执行"）。整段包 `try/catch`，错误留在 `window.__ngFakeCamErr`。
2. `captureStream(0)` **不主动 `requestFrame()` 就不出新帧** ⇒ 这被当成**特性**用（未 `start()`
   时一条帧都不推，用例前半段保持"没有摄像头"的语义，有断言专门钉它）。
3. 🔴 **喂帧按墙上时间定长**（`start(ms)`），不是"把帧表喂完为止"。无头页里推理是**同步**的、
   占主线程 ~0.45 秒 ⇒ 推帧的 `setInterval` 被拖到 **2.0–5.0 帧/秒**（实测）。
   按帧数定长的话「53 帧 × 200ms」在忙的时候会变成 **22.5 秒**，跨过动作计时器的 **12 秒**边界，
   后半段帧被记到下一个动作上（收尾屏多出一个"判过的动作"、落库明细 1 项变 2 项）；
   而空闲时又只有 10.6 秒 ⇒ "喂多久"取决于机器多忙。定长之后帧率**只影响帧数、不影响时长**，
   而"保持比例"这个被验的量恰好**只依赖时长**。

**还要注意一条时间预算**：喂帧窗口 + 点「结束活动」的 CDP 往返必须整体落在**第一个动作的
标称时长**（`neck-flex-left` = 12 秒，从 `src/data/exercises.ts` 读，不在 fixture 里复刻）之内。
`ui_smoke.feed_ms + click_slack_ms ≤ 动作时长 − 500ms` 这条不等式由
`build-frames.py`（构建期）与 `loadUiSmoke()`（装载期）**两边各查一次** ——
它一旦被破，症状是"收尾屏多了一个判过的动作"，很难归因到"喂帧喂久了"。

🔴 **光有那条不等式还不够 —— 采样循环必须"提前停"。** 这两件事是**分开**的：
不等式管的是 fixture 建模的窗口长短，而**实际什么时候点下去**取决于采样循环怎么写。
第一版循环是"采完再看 `at >= feed_ms` 就退出"，可 `at` 是在**采样之前**测的，
每轮还要花掉 500ms 睡眠 + 一次 CDP 往返 ⇒ 路径变成 `clickAt = feed_ms + 步长 + 往返`。
本机往返 8–408ms 时看不出来，**CI runner 上（往返 120–150ms 起步）直接顶破 `click_slack`**：
`t+10745ms > 10600ms`，android / ios 各红一条（303 通过 / 2 失败）。
修法：退出阈值取 `feed_ms − 一个采样步长 − 一个 click_slack`，于是
`clickAt ≈ feed_ms − 步长 − slack + 往返` —— 往返要超过 1.5 秒才会红。
⚠️ 提前停之后 `rate` 会低估（分母是完整的 `feed_ms`），所以**在点「结束活动」之前**
补读一次帧计数（读早了才有意义：点下去就立刻停止记录帧）。

> 🔴 **「本机全绿」推不出「CI 全绿」**：这条断言就是被 CI 抓出来的 ——
> 本地连跑多轮 305 全绿，一推上去就红 2 条，而红的**不是判定逻辑，是"什么时候点按钮"**。
> 凡是**依赖时序**的断言，都要按"目标环境里最慢的那一步"来留余量。

🔴 **一次环境抖动就红 10 条 —— 所以这一段带"环境不足 ⇒ 整段重试一次"**：
CI runner 的负载波动极大，实测同一台 runner 上帧率在 **0.3 – 4.8 帧/秒**（差 16 倍）。
最差那次 10 秒只推到 **5 帧**（ios 更少，3 帧），连带 **10 项断言红**，而且**全是"帧没进来"
的下游症状**：姿态读数 1.4°、浮层一次都没出现、徽章读不到 0 次、判成 `insufficient score=42` ——
**没有一条在说判定实现错了**，方向完全指错。那种红不是代码缺陷，
但**也不能靠放宽帧率下界消掉**（那正是"为了让测试变绿而削弱断言"，而且 1.5 这个下界是
**离线扫描过**的数、`rate_sweep` 里就有这一档）。

做法（`checkCameraGuidanceWithRetry`）：第一轮跑进**影子收集器**（不打印、不计数）；
帧率达标就把那一轮的断言**原样回放**（所以正常路径的断言条数、顺序、文案一字不变）；
不达标就整段重来一次（那段开头本来就会回到 `#/` 再 reload，天然可重跑）；
两轮都不行 ⇒ **如实红**，但先给一条**形状指向环境**的失败
（"两轮都没跑到 1.5 帧/秒 …… 这一段本次没能验证"），再回放第二轮 ——
不掩盖任何东西，但读线报的人不会去判定实现里找一个不存在的问题。

> 通用判据：**「环境不足」与「被测对象错了」必须在报错里可区分**。
> 分不清的代价是——每次抖动都有人去查一遍判定实现，查完发现什么都没错，然后开始无视这个门。

⚠️ **但"同一次 run 内重试"救不了「runner 本身慢」** —— 实测：某次 run 上 android 与 ios
两轮都是 **0.8 帧/秒**（重试无效，因为两轮跑在**同一台** runner 上；`insufficient score=77`
——差一点，正是"帧少 ⇒ 采到的 `peak_activity` 偏低"），而**同一个 commit 直接 rerun（换实例）
立刻全绿**（2m34s vs 3m55s）。所以线上撞到这条红，**第一步是 rerun，不是查代码** ——
报错话术里也是这么写的。CI 上实测帧率跨度：**0.3 – 4.8 帧/秒**（同一个 job 内差 6 倍，
跨 job 差 16 倍）。

🔴 **`rate_floor` 是"离线扫描过的下界"，不是"浏览器里证过的下界" —— 这两者实测会分叉。**
- `rate_sweep` 的建模方式是"**读数不重测**，只把同一串读数重打时间戳"，它自己的 docstring 里写着
  "读数只取决于喂帧顺序，与时间戳无关"。**这句话在浏览器里是假的**：浏览器里的读数来自
  MediaPipe **逐帧跟踪**（`static_image_mode: false`），而跟踪**依赖帧的时间分布** ——
  相隔越久越容易丢目标、重新收敛，读数就越低。
- 实测对照（同一份帧表）：

  | 帧率 | 结果 |
  |---|---|
  | 4.5 / 4.2（本机） | ✅ `completed` |
  | 2.7 – 2.9（CI） | ✅ `completed` |
  | **1.6 / 1.5（CI）** | ❌ **`insufficient score=76`**（peak 没采到 ⇒ 幅度分不够）|

  而**扫描说 1.5 这一档是 `completed`**。
- ⇒ 浏览器里**真实的安全下界在 1.6 与 2.7 之间**，比扫描给出的 1.5 高。

### 决策（v1.7.1）：两个下界分开登记 + 「环境不够」改成两轴交叉判

**不合并成一个数**，因为它们是两个问题：`rate_floor` 答"离线重放里算法还判得出吗"（模型问题），
`rate_floor_browser` 答"浏览器里这一次的读数还可信吗"（环境问题）。`scenarios.json` 里两个字段并存，
并有关系自检：`rate_floor < rate_floor_browser ≤ rate_sweep 最高档`
（低于/等于前者＝比离线模型还宽松、没有意义；高于后者＝永远到不了、等于把这段守卫静默关掉）。

**"低帧率"本身从此不是失败理由**。判据只有一处实现（`trustCameraRound()`），**两个轴交叉**：

| 帧率 | 结论与 fixture 对得上？ | 判定 | 后果 |
|---|---|---|---|
| ≥ `rate_floor_browser`（2.0） | 任意 | 采信 | 环境在**实测证过**的区间 ⇒ 结论对/错都算数（错＝真失败，照旧红） |
| 1.5 ~ 2.0 | 对 | 采信 | 打一条 **⚠**（这一段是在偏挤的环境下验的），**run 仍绿** |
| 1.5 ~ 2.0 | 不对 | 不采信 | **整段重试一次**；两轮都如此 ⇒ 报「环境不足」（形状指向环境 + 提示 rerun） |
| < 1.5 | 任意 | 不采信 | 连**离线模型**都没证过这一档 ⇒ 结论对得上也不当证据（防"蒙对"） |

> 取舍说清楚：这条政策**放弃**了"帧率 < 1.5 就判红"这一层保护（那档里周边不变量如浮层/徽章
> 可能"因为帧少而侥幸成立"），换来的是"**不会为了一个已经正确的读数红**"。
> 补偿是：段内那条断言改成"本轮环境够采信"（**判据同一处实现**），
> 且"低于离线最低档"那一档仍然拒绝采信 —— 即**低帧率 + 判不出来**照旧是红的，只是红得有形状。

**证据（不是推演）**：
- `verify-ui-smoke.mjs --self-test`：9 例表驱动自测（每次跑 `verify:ui` 都无条件先跑，失败即 `::error::`）。
  它证明的是**判据的形状**，用合成门值（1.5 / 2.0），与 fixture 改数无关。
- `.buildenv/mutate-trust-rule.py`：**4 条变异全部被自测精确抓住**（判据是"被打坏的用例集合"完全相等，
  不是"随便红一条"）+ **负向对照绿** + **字节级还原自检**。4 条坏法分别是：
  T1 丢掉"低于离线最低档也不采信"、T2 退回旧语义（只看帧率）、T3 只看结论不看帧率、
  T4 门写成严格大于。
  ⚠️ 这个脚本第一版是"把判据函数复制到临时目录再改"——**负向对照当场红**：脚本在模块顶层按
  自己所在目录读 `src/platform/exerciseQuality.ts`，复制即 `ENOENT`，四条变异全是"因为崩了所以非 0"，
  一条真证据都没有。⇒ 改成**原地改 + 字节还原**（负向对照存在的意义就是抓这种"设施自己坏了"）。
- `.buildenv/probe-retry-path.py`：**端到端**证明"重试 ⇒ 环境不足"会走上。做法是临时把环境门拉到
  99（并临时短路关系自检）+ 用 M7 的坏法（`duration_ms * 60000`，整段判不出 `completed`）重新构建。
  实测：⚠「整段重试一次」→ 第二轮的采样日志 → **先** `✗ 环境不足`（写明"不能据此说判定实现坏了、
  先 rerun"）**再**回放第二轮的原始失败（`✗ 浏览器路径判成 completed … grade=insufficient score=34`）——
  按判据逐条核验 **6/6**，三处临时改动**字节还原**。这同时是对"红要红得有形状"的一次实跑证明。
- `.buildenv/probe-lowrate-pass.py`：证明另一半 —— 环境门临时改成 5.0（本机帧率 4.2–4.8 ⇒ 必定低于门，
  且 5.0 仍在扫描区间内、**不用**短路任何自检）：低帧率 + 结论一致 ⇒ **退出码 0**、打出
  「照常采信」的 ⚠、**不再重试**、整体报通过。
- 由此得到一条通用铁律（`DEVELOPMENT.md` #72）：**"环境不够"的判据必须两个轴交叉**，
  且判据只允许一处实现。

**帧率下界**：`verify:ui` 只读 fixture 的两个字段（`rate_floor` / `rate_floor_browser`），
**不自己另写一个数**；扫描区间与两个门的关系由 loader 自检兜住。
带外说明：再慢下去会先坏在两处 ——
帧间隔超过 `MAX_FRAME_GAP_MS=1500` ⇒ `held_ms` 整段不计；跟踪器收敛那几帧占掉更长的墙上时间
⇒ 保持比例掉到达标线以下。

**实测（`npm run verify:ui`，2026-09 本机）**：连续 3 轮 × 305 项断言全绿，
帧率 4.2–4.8 帧/秒、浮层零缺失。单用例时间轴：

```
· 采样 18 次 / 喂帧 10000 ms，推送 45 帧（4.5/s）；点结束活动 t+9166ms（窗口结束前 834ms 点的）
· 时间轴 0.0s:没检 0.5s:没检 1.0s:幅度 1.6s:保持 2.1s:保持 … 4.1s:很好 4.6s:很好
        5.1s:很好 5.6s:很好 6.1s:幅度 6.6s:幅度 7.1s:没检 … 8.7s:没检
· 徽章锚点：读到 17 次读数            ← v1.7.1 补；此前这一行是 0 次（锚点选错 ⇒ 整段空转）
```

**CI runner 上同一条用例**（`36658378434` 之后那次全绿）：帧率只有 **2.7–2.9 帧/秒**（≈ 本机的 60%）、
`点结束活动 t+9263 / t+9586ms`（窗口结束前 737 / 414ms）、徽章锚点 12–13 次读数。
⇒ **CI 明显比本机慢**，这正是**两个下界都不取 2.7** 的原因（离线模型门取 **1.5**、
浏览器环境门取 **2.0** —— 见上面那张决策表），
也是上面那条"退出要提前"必须按 **CI 的 CDP 往返**留余量、而不能按本机的 8–408ms 估的原因。
（对照：修之前 CI 上同一条断言是 `t+10745 / t+10724ms` —— 红。）

⚠️ 末尾那几句「没检测到动作」是**已知现象**（起势帧滚出 5 秒窗口后活动范围归零），
不是缺陷，也没被断死；**不覆盖**：真实摄像头设备与权限层、时间轴的绝对值、
七个登记案例在浏览器里的读数（仍只有 UI 冒烟那一份帧表被实跑证过）。

🔴 **这段还留下一条通用教训（v1.7.1）**：「徽章与提示不矛盾」这条断言写了两轮才发现
**它一次都没检查过东西** —— 锚点是 `p「实时动作达成度」`，而移动端练习条上压根没有那个
`<p>`，读数恒 `null`、循环整段 `continue`，于是它一路"✓"。变异 M5 漏网才暴露。
修完锚点，同一次实跑立刻读出 **19 次**读数，M5 也当场被抓住（11 处矛盾，报错精确到
`0.5s exercise-bar-score 徽章48分/提示「没检测到动作」`）。
⇒ **凡是"读界面上某个数再判定"的断言，都要有一条"这个锚点读得到"的兜底**，
否则它会随 UI 改版**静默**退化成空断言 —— 而空断言与真断言在输出里长得一模一样。

