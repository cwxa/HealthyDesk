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

评分、角度、平滑器同时存在于 `backend/services/*.py` 与
`src/platform/localPoseEngine.ts`，两者必须**逐位等价**：

```bash
npm run verify:parity     # 21 项常量 + 80 条评分用例 + 42 条序列/439 帧平滑 + 8 条角度
```

核心不变量：**出现任何姿态提醒 ⟺ 分数 < 80**。

⚠️ 取整一律用 `pyRound(x*100)/100`（银行家舍入），**不要写 `Math.round`**，
也不要写 Python 的 `round(x, 2)` —— 三者不是同一个函数，实测能差 1 分 / 0.01。

---

## 三、各端构建

### 3.1 Windows

```bash
npm ci
npm run icons:generate        # 生成 ico / icns / 菜单栏 template 图（改了 SVG 才需要）
npx vite build                # 桌面模式（含 Electron 入口）
npm run backend:build         # PyInstaller（干净 venv，见 README）
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

`.github/workflows/build.yml`，打 tag（`v*`）或手动触发（`gh workflow run build.yml`）。
⚠️ **推 main 不会触发** —— 改了工作流要验证，必须手动 dispatch。

| Job | Runner | 产物 |
|---|---|---|
| `verify` | ubuntu-latest | 守门（见下） |
| `desktop-windows` | windows-latest | `.exe` |
| `desktop-macos` | `macos-15-intel`(x64) / `macos-15`(arm64) | `.dmg` / `.zip` |
| `mobile-android` | ubuntu-latest | `.apk` |
| `mobile-ios` | `macos-15` | `.xcarchive.tgz` |

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

**CI 只构建、不发布 Release**。产物需要在真机上验证（尤其是安卓/iOS 的摄像头链路），
确认后再人工执行 `gh release create/upload`。这能避免"构建成功"被当成"能用了"发出去。

**Android 签名**：提供以下 repository secrets 则出正式包，否则只出 debug 包：

| Secret | 内容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 neckguardian-release.jks` |
| `ANDROID_STORE_PASSWORD` | keystore 口令 |
| `ANDROID_KEY_ALIAS` | `neckguardian` |
| `ANDROID_KEY_PASSWORD` | key 口令 |

⚠️ 本机 keystore 在 `E:/AndroidDev/keystore/neckguardian-release.jks`。
**丢了就永远无法给老用户推更新**，务必多备份。

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
| macOS / iOS 产物尚未产出过 | 本机不可能构建，需 macOS 或 CI（见 §四） | 待产出 |
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
5. 本文件与 README 的矩阵表
6. `.github/workflows/build.yml` —— 加一个 job

**不要**改 `src/pages/**` 与 `src/components/**`。

---

## 九、发布前验证清单

**"构建成功"不等于"产物可用"。** 下面每一条都是可复现的证据，不是"看起来对"。
踩过的坑都标了 🔴。

### 9.1 通用（先跑，不过就别打包）

```bash
npm run verify:all          # 数值对拍 + 五处版本号一致性
npm run verify:backend      # 后端产物 magic bytes 与目标平台匹配
```

- [ ] `verify:parity` 全通过：21 常量 + 80 评分用例 + 42 序列/439 帧平滑 + 8 角度 + 不变量
- [ ] `set-version --check` 五处版本号一致
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

### 9.3 安卓 release APK

- [ ] 🔴 **签名指纹与上一版逐位一致**（`apksigner verify --print-certs` 的 SHA-256）。
      不一致则老用户**无法覆盖安装**。把这个值写进 README，每次发版对照
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

- [ ] 🔴 要推 `.github/workflows/**` 的，先看 `gh auth status` 的 scopes。
      GitHub 要求 token 具备 **`workflow` scope**（只有 `repo` 不够），且会**整体拒绝**这次 push
      ——不是跳过那几个文件。**提交链里只要有一个这样的提交，后面全部推不动**。
      拿不到授权就先 `git reset --soft HEAD~1` 摘链、把 `.github/` 暂存到 `.git/` 内，
      发完版再恢复，别让它阻塞发布

