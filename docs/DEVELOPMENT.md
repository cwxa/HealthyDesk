# NeckGuardian 开发文档

> **这份文档给开发者。** 想装来用的用户请直接看 [README](../README.md)。

一个肩颈健康助手：摄像头实时监测坐姿 → 评分 → 到点提醒活动。
**同一份 React 前端 + 一个平台能力层**，跑在 Windows / macOS / Android / iOS 四端上。

## 文档地图

| 文档 | 管什么 |
|---|---|
| **本文件** | 架构、目录结构、核心组件、数据库、API、开发流程、开发铁律 |
| [MULTIPLATFORM.md](MULTIPLATFORM.md) | 四端构建与打包、CI/CD、macOS 签名公证、iOS 权限链、**发布前验证清单** |
| [ANDROID_BUILD.md](ANDROID_BUILD.md) | 安卓工具链（JDK/SDK/Gradle）、出包、release 签名与密钥备份 |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | 历年踩坑与排查手册（"又坏了"先翻这个） |
| [archive/vibe-code-prompt.md](archive/vibe-code-prompt.md) | 立项时的原始提示词，**仅历史参考**（写的是单机 Windows 版本，**勿照它实现**） |

---

## 一、快速开始

### 1.1 环境要求

| 依赖 | 版本 | 用途 |
|------|------|------|
| Node.js | >= 18 | 前端构建与运行时 |
| Python | >= 3.10（CI 用 3.12） | 桌面端后端 |
| JDK 17 + Android SDK 34 | — | 出安卓 APK（本机已装在 `E:\AndroidDev`，也可用 Android Studio 自带） |
| macOS + Xcode | — | **出 macOS 包与 iOS 包必需** |

> 🔴 **Windows 上只能构建 Windows 与 Android。** macOS / iOS 必须在 macOS 上构建：
> iOS 需要 Xcode 与代码签名；macOS 安装包里要内置 **macOS 原生的 Python 后端**，
> 而 PyInstaller **不能交叉编译**。没有 Mac 机器就走 CI（见 [MULTIPLATFORM.md](MULTIPLATFORM.md)）。

### 1.2 跑起来

```bash
npm install
npm run python:install     # 装后端依赖（虚拟环境里跑，别污染全局）

npm run start              # 后端 + 前端一起起（开发模式）
# 或者分开起：
npm run python:start       # 只起 FastAPI 后端（端口 18920）
npm run dev                # 只起 Vite 前端（5173）
```

### 1.3 常用命令

```bash
# ---- 桌面端 ----
npm run build              # 按当前系统出包
npm run build:win          # Windows（NSIS 安装包）
npm run build:mac          # macOS（dmg + zip，x64/arm64 各一份；须在 macOS 上跑）
npm run build:linux        # Linux（AppImage + deb）

# ---- 移动端 ----
npm run cap:build            # 安卓 debug APK（前端构建 + sync + gradle 一条龙）
npm run cap:build:release    # 安卓 release APK（需 android/keystore.properties）
npm run cap:build -- --skip-web   # 只改了原生代码时跳过前端构建，快一倍
npm run cap:sync             # 只编译前端 + 同步进安卓工程
npm run cap:open             # 用 Android Studio 打开 android/

node scripts/ios-build.js            # iOS 未签名归档（只能在 macOS 上跑）
node scripts/ios-build.js --export   # 导出 IPA（需签名配置）

# ---- 校验（改数值逻辑后必跑）----
npm run verify:parity      # 双端数值等价对拍（见 §4.2）
npm run verify:backend     # 后端产物 magic bytes 与目标平台是否匹配
npm run verify:all         # verify:parity + 版本号五处一致性
npm run set-version -- --check   # 只检查版本号一致性
```

### 1.4 改代码前必须知道的三件事

1. **改评分/角度/平滑逻辑 → 必须跑 `npm run verify:parity`**，两处实现（Python 与 TS）要逐位等价。
2. **业务组件里不许写 `platform === 'electron'`**，一律问能力：`supports('systemTray')`。
3. **往包里加资源前先想清楚它属于哪一端**：桌面端和移动端共用 `dist/`，放错位置会让另一端凭空增重。

---

## 二、架构

### 2.1 平台矩阵

四端是**同一份前端 + 一个平台能力层**：页面、组件、业务 Hook 完全共用，差异只在
「谁来推理、数据存哪、提醒怎么发」三件事上。

| 端 | 运行壳 | 姿态推理 | 数据存储 | 提醒通道 | 产物 |
|---|---|---|---|---|---|
| Windows | Electron（托盘 / 开机自启） | Python 后端 + MediaPipe | 后端 SQLite | 后端调度器 → IPC 弹窗 | NSIS `.exe` |
| macOS | Electron（菜单栏 Template 图标） | 同上 | 同上 | 同上 | `.dmg` / `.zip` |
| Android | Capacitor WebView | 前端本地 MediaPipe **wasm** | IndexedDB | 本地定时器 + 系统通知 | `.apk` |
| iOS | Capacitor WKWebView | 同上 | 同上 | 同上 | `.xcarchive` |

### 2.2 整体架构图

```
┌───────────────────────────────────────────────────────────────────────┐
│               共用前端  React + TypeScript（四端同一份产物）            │
│     pages / components / hooks / usePoseEngine —— 业务代码零平台分支    │
└────────────────────────────────┬──────────────────────────────────────┘
                                 │  只问能力，不问平台
                                 ▼
┌───────────────────────────────────────────────────────────────────────┐
│        平台能力层  src/platform/     ← 全部平台差异的唯一收敛处         │
│  runtime.ts         能力矩阵 supports('localBackend')；平台 ⊥ 宿主 OS   │
│  dataLayer.ts       HTTP(REST + WebSocket)  ⇄  IndexedDB               │
│  localPoseEngine.ts 本地 MediaPipe wasm 推理 + 评分（与 scorer.py 等价）│
│  localDb / localStats / localReminder / nativeDiag                     │
└────────┬──────────────────────────────────────────┬───────────────────┘
         │ supports('localBackend') === true        │ false
         ▼                                          ▼
┌────────────────────────────────┐  ┌────────────────────────────────────┐
│      Windows / macOS 桌面       │  │        Android / iOS 移动           │
│  Electron 主进程                │  │  Capacitor WebView（无后端）        │
│   · 窗口 / 托盘 / 自启 / 弹窗    │  │   · 摄像头 → wasm 推理 → IndexedDB  │
│         │ HTTP + WebSocket      │  │   · 提醒 = 本地定时器 + 系统通知     │
│         ▼                       │  │   · 权限：原生桥（Android）/         │
│  Python FastAPI 后端（内嵌）     │  │           WKWebView（iOS）          │
│   MediaPipe / SQLite / 调度器    │  └────────────────────────────────────┘
└────────────────────────────────┘
```

### 2.3 架构特点

| 特性 | 说明 |
|------|------|
| **能力矩阵而非平台分支** | 业务层问 `supports('systemTray')`，不写 `platform === 'electron'`；新增平台只改一张表 |
| **平台与宿主 OS 正交** | `RuntimePlatform`（electron/android/ios/web）与 `HostOS`（windows/macos/…）是两个独立维度，桌面端文案随 OS 变 |
| **单一数值实现** | 评分/角度/平滑各端逐位等价，由 `npm run verify:parity` 守住（§4.2） |
| **进程隔离** | 桌面端 Electron 主进程与渲染进程隔离，后端作为独立子进程运行 |
| **实时通信** | 桌面走 WebSocket 低延迟数据流；移动端在页面内直接推理，无网络往返 |
| **全程离线** | 移动端无后端依赖；桌面端后端为本地进程。不依赖任何云服务（AI 分析除外，且需用户自配 Key） |

### 2.4 平台能力层（四端差异的唯一真相来源）

`src/platform/runtime.ts` 是**唯一**允许出现平台判断的地方。它导出：

- `supports(capability)` —— 能力查询。现有能力位：
  `localInference` / `localBackend` / `systemTray` / `autoStart` / `nativeDiagnostics` /
  `systemNotification` / `speech`
- `getPlatformInfo()` / `getHostOS()` / `getFormFactor()` / `isDesktop()` / `platformLabel()`
- `hasLocalBackend()` —— **仅 electron 为 true**，决定走 HTTP 还是 IndexedDB

> 🔴 **运行时平台 ⊥ 宿主 OS**：桌面端两个架构都是 `RuntimePlatform = 'electron'`，
> 但 `HostOS` 可能是 windows 或 macos。文案与资源路径要按 `HostOS` 分，不要按运行时平台分。

调试用 URL 覆盖（HashRouter 下**参数必须写在 `#` 之前**）：

```
?platform=android|ios|web|electron     # 覆盖运行时平台
?platform=macos|windows|linux          # 覆盖宿主 OS
?os=xxx
```

### 2.5 移动端架构（Capacitor）

移动端复用同一套前端，通过能力层在运行时分流：桌面走 Python 后端，
移动端把**推理、存储、提醒全部下沉到 WebView 本地**。

| 能力 | Windows / macOS | Android | iOS | 代码位置 |
|------|--------|--------|--------|----------|
| 平台判定 | `window.electronAPI` | Capacitor `android` | Capacitor `ios` | `src/platform/runtime.ts` |
| 姿态推理 | Python + MediaPipe | 浏览器内 MediaPipe（WASM/GPU） | 同 Android | `src/platform/localPoseEngine.ts` |
| 视频流 | WebSocket 传帧 | 本地 `<video>` 直读 | 同 Android | `src/hooks/usePoseEngine.ts` |
| 数据存储 | SQLite（后端） | IndexedDB | IndexedDB | `src/platform/localDb.ts` |
| 统计聚合 | 后端 SQL | 前端 JS 重写（数字口径一致） | 同 Android | `src/platform/localStats.ts` |
| 定时提醒 | APScheduler | JS 定时器 + 系统通知 | 同 Android | `src/platform/localReminder.ts` |
| 统一数据接口 | HTTP `/api/*` | 同上接口的本地实现 | 同 Android | `src/platform/dataLayer.ts` |
| AI 分析 | DeepSeek | 本期不支持（设置页隐藏） | 同 Android | — |

**摄像头权限**（两端机制完全不同，是移动端最容易踩的坑）：

| 端 | 机制 | 关键点 |
|----|------|--------|
| Android | `WebChromeClient.onPermissionRequest` | 必须在启动阶段**预申请** CAMERA；持有权限时在回调内**同步** `grant()`。诊断走 `addJavascriptInterface` 暴露的只读 `NeckGuardianNative.diagnostics()`（宿主类必须 public） |
| iOS | `WKUIDelegate.requestMediaCapturePermissionFor` | Capacitor 已内置授权回调与 `allowsInlineMediaPlayback`，**唯一要手配的是 `Info.plist` 的 `NSCameraUsageDescription`** —— 缺了进程会被系统直接终止（表现为闪退，**不是**"权限被拒"） |

**模型离线内置**：MediaPipe WASM 与 `pose_landmarker_full.task`（约 9.4 MB）随包打进 APK，安装后无需联网。

---

## 三、目录结构与职责

```
HealthyDesk/
├── backend/                    # Python 后端服务 (FastAPI)
│   ├── api/                    # REST API 路由层
│   │   ├── activity.py         # 活动记录 CRUD
│   │   ├── ai.py               # AI 顾问接口
│   │   ├── posture.py          # 姿势数据接口
│   │   ├── reminder.py         # 提醒系统控制
│   │   ├── settings.py         # 用户设置管理
│   │   └── stats.py            # 统计数据查询
│   ├── db/database.py          # SQLite ORM 封装（表结构以 init_db() 为准）
│   ├── services/               # 业务逻辑层
│   │   ├── ai_advisor.py       # AI 健康建议 / 综合报告生成
│   │   ├── ai_config.py        # DeepSeek 配置解析（DB > 环境变量）
│   │   ├── fallback.py         # AI 不可用时的降级方案
│   │   ├── pose_detector.py    # MediaPipe 姿势检测核心
│   │   ├── scheduler.py        # APScheduler 定时任务
│   │   ├── scorer.py           # 🔴 姿势评分算法（双端一致性的一端）
│   │   └── smoother.py         # 🔴 EMA 平滑器（同属评分链路）
│   ├── ws/camera_ws.py         # 实时姿势数据流推送
│   ├── config.py               # 全局配置（含 APP_VERSION，版本号五处之一）
│   ├── main.py                 # FastAPI 应用入口
│   └── requirements.txt        # Python 依赖清单（有严格 pin，见 §9）
├── electron/                   # Electron 主进程（win/mac/linux 通用）
│   ├── main.ts                 # 窗口/托盘/自启/后端子进程（平台分支集中在此）
│   └── preload.ts              # API 桥接（同时暴露平台与架构信息）
├── src/                        # React 前端（渲染进程）
│   ├── components/             # 可复用 UI 组件（ScoreGauge / PostureSkeleton / BottomTabs …）
│   ├── hooks/                  # useAI / useApi / usePoseEngine / useWebSocket
│   ├── platform/               # 🔴 平台能力层（四端差异唯一收敛处）
│   │   ├── runtime.ts          # 平台 / 宿主 OS 判定 + 能力矩阵（唯一真相来源）
│   │   ├── nativeDiag.ts       # 原生权限诊断（Android 原生桥 · iOS/Web Permissions API）
│   │   ├── dataLayer.ts        # 统一数据层（HTTP vs IndexedDB）
│   │   ├── localDb.ts          # 移动端 IndexedDB 封装
│   │   ├── localStats.ts       # 移动端统计聚合（对齐后端 SQL）
│   │   ├── localPoseEngine.ts  # 🔴 移动端本地推理与评分（与 scorer.py 逐行等价）
│   │   └── localReminder.ts    # 移动端本地提醒调度器
│   ├── pages/                  # Dashboard / NeckActivity / Settings
│   ├── utils/speech.ts         # 语音播报封装
│   ├── App.tsx                 # 应用根组件（含移动端布局分流）
│   └── types.ts                # TypeScript 类型定义
├── android/                    # Capacitor 安卓工程
│   └── app/src/main/
│       ├── java/com/neckguardian/app/MainActivity.java  # 摄像头权限覆写
│       ├── assets/public/     # 由 cap sync 拷入的 Web 产物（含媒体模型）
│       └── res/               # 图标、启动图、主题、颜色资源
├── ios/                        # Capacitor iOS 工程（必须在 macOS 上构建）
│   └── App/App/
│       ├── Info.plist         # NSCameraUsageDescription 等权限声明
│       └── Assets.xcassets/   # AppIcon / LaunchScreen（由脚本产出）
├── macos/                      # macOS entitlements
│   ├── entitlements.mac.plist          # 主进程（JIT / 摄像头等）
│   └── entitlements.mac.inherit.plist  # 子进程（仅 JIT）
├── public/                     # 桌面端静态资源（Vite 会**全量**复制进 dist/）
├── mediapipe-assets/           # 移动端 MediaPipe 模型（🔴 不入 public/，见 §9）
├── scripts/                    # 构建与校验脚本
│   ├── cap-build.js            # 移动端构建（tsc + vite build + 拷 MediaPipe 资源）
│   ├── android-build.js        # 安卓出包（cap sync → gradle assemble）
│   ├── ios-build.js            # iOS 出包（macOS：cap sync → pod install → xcodebuild）
│   ├── set-version.js          # 版本号五处统一写入 / --check 校验
│   ├── verify-backend-binary.js   # 后端产物格式与架构是否匹配目标平台
│   ├── verify-scoring.mjs      # 评分等价性对拍
│   ├── verify-angles.mjs       # 角度等价性对拍
│   ├── verify-same-source.mjs  # 产物内前端 == 本次 dist（逐文件 sha256）
│   ├── gen-*.py                # 生成期望值 / 图标 / 启动图
│   └── gen-mac-icons.js        # ICNS / 菜单栏 Template / iOS 图标与启动图
├── docs/                       # 文档（见上方「文档地图」）
├── .github/workflows/build.yml # CI/CD：四端构建 + 同源/架构/版本校验 + tag 发 draft Release
├── capacitor.config.ts         # Capacitor 配置（android / ios）
├── vite.config.ts              # Vite 配置（双目标：桌面 / 移动）
├── tsconfig.json               # TypeScript 配置
└── electron-builder.yml        # Electron 打包配置（win / mac / linux）
```

---

## 四、核心技术组件

### 4.1 姿势检测与评分

```
摄像头输入 → MediaPipe 姿态估计 → 关键点提取 → 角度计算 → EMA 平滑 → 评分 → 提醒
```

**三项检测指标与阈值**：

| 指标 | 定义 | 阈值 |
|---|---|---|
| 头部侧倾 | 双耳连线与水平线的夹角 | ±5° |
| 肩部高差 | 双肩关键点的垂直距离 | 4% 肩宽 |
| 脊柱倾斜 | 颈与背关键点连线的倾角 | ±10° |

地标索引（MediaPipe Pose）：`NOSE=0` / `EAR=7,8` / `SHOULDER=11,12` / `HIP=23,24`。

**🔴 核心不变量：出现任何提醒 ⟺ 分数低于 80。**

扣分分档的边界与提醒分档判断**共用同一组常量**。每项指标按超标量分「轻微/明显/严重」三档，
扣分与提醒文案一一对应；**最差的一项算满，其余两项按 0.3 权重叠加**
（三个指标来自同一组关键点、彼此强相关，直接相加会过度惩罚）。
阈值内另有一段「预警区」（阈值 60% 起，每项最多扣 6 分），避免"刚好合格 100 分、刚超标 78 分"的突变。

| 头部侧倾（阈值 5°，其余两项正常时） | 分数 | 提醒 |
|---|---|---|
| ≤ 5° | 90 – 100 | — |
| 5° – 11° | 72 – 78 | 头部轻微侧倾 |
| 11° – 17° | 54 – 66 | 头部明显侧倾 |
| > 17° | 35 – 48 | 头部严重侧倾 |

> 阈值处有一处**有意的台阶**：`head` 从 5.00° 到 5.01°，分数由 94 掉到 78。这是
> 「有提醒 ⟺ 分数 < 80」的必然结果 —— 提醒一旦出现，分数就必须已经在 80 以下。
> 因此 **80–89 分是模型的死区**，永远不会出现。
>
> 阈值附近**没有去抖**，所以 94/78 闪烁是已知取舍（要消抖就得放弃"提醒与分数严格同步"）。

### 4.2 双端数值一致性（改评分必读）

评分逻辑只有两处实现，**必须逐位等价**：

| Python（桌面后端） | TypeScript（移动端） |
|---|---|
| `backend/services/scorer.py` | `src/platform/localPoseEngine.ts` |
| `backend/services/smoother.py`（EMA 0.35） | `PoseSmoother` |
| `backend/services/pose_detector.py`（角度） | 同文件的角度计算 |

```bash
npm run verify:parity     # 21 项常量 + 80 条评分用例 + 42 条序列/439 帧平滑 + 8 条角度用例
```

改动任何一个文件后**必须**跑一遍。几条硬规矩：

- 🔴 **取整一律 `round(x * 100) / 100`**（前端封装为 `pyRound()`）。
  Python 的 `round()` 是**银行家舍入**，JS 的 `Math.round` 不是；
  而 `round(x, 2)` 与 `round(x*100)/100` **也不是同一个函数**（`x=0.015` 时结果不同）。
- 🔴 **对拍脚本要用真实源码**：`verify-scoring.mjs` 用 esbuild 把
  `localPoseEngine.ts` bundle 出来执行。**不要退回内联副本** —— 副本与源码各错各的，
  测试却全绿。
- 🔴 **守卫要用变异测试证明有效**：改一个常量，`verify:parity` 必须 `exit 1`。
  没做过变异测试的守卫等于没有。

> 这套对拍抓出过两处真实的跨语言差异：Python 银行家舍入、以及后端平滑器的
> `round(x, 2)` 与前端 `pyRound` 不等价。两处都已修，并固化成回归用例。

### 4.3 实时通信

**WebSocket 数据流**（桌面端）：

1. 前端连 `ws://127.0.0.1:18920/ws/camera`
2. 后端 `pose_detector.py` 持续推送姿势数据（约 30fps）
3. 前端实时更新骨架动画与评分

**Electron IPC**（`preload.ts` 暴露）：`get-backend-url` / `minimize-to-tray` / `quit-app` / `onReminder`。

> 🔴 **前端 hook 依赖铁律**（摄像头「无限正在启动」的元凶）：
> `useWebSocket()` 返回的是每次渲染新建的对象字面量，`useCallback` / `useEffect`
> **不能把 `ws` 整个写进依赖数组**，必须解构出用到的成员。
> `NeckActivity` 的"启动摄像头" effect 必须是 `[]` 依赖（用 ref 持最新回调）。
> **定位口诀：界面永久 pending ≠ 报错，是某个 `await` 永不 settle** —— 优先怀疑
> effect 反复重建 / abort 竞态，而不是权限被拒。链路里所有 `await` 都要有超时
> （`withTimeout.ts`：取流 30s、模型 45s）。

### 4.4 定时提醒系统

`backend/services/scheduler.py`，基于 **APScheduler**：

```
时间触发 → 检查当前状态 → 发 WebSocket 通知 → Electron 弹窗提醒
```

支持动态调整提醒间隔，并回调通知前端与 Electron。移动端用 `localReminder.ts` 的
本地定时器 + 系统通知实现同语义（切后台会被系统冻结，见"已知限制"）。

### 4.5 AI 健康顾问（DeepSeek）

**配置优先级**：数据库设置（用户在应用内填写） > 环境变量（部署默认值）。
用户填的 API Key 写入 `settings` 表，重启仍生效；**接口下发的 Key 一律掩码，绝不回传明文**。

- 集成 **DeepSeek Chat Completions API**（`/v1/chat/completions`，Bearer 鉴权）
- 支持两类调用：`/api/ai/suggestion`（实时轻量建议）、`/api/ai/analyze`（综合报告）
- **未配置 Key 时走本地规则降级**（`fallback.py`）

```
姿态指标 + 使用统计 → 组装结构化 Prompt → DeepSeek API → Markdown 报告 → 前端渲染
```

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ai/config` | 读取配置（Key 掩码） |
| PUT | `/api/ai/config` | 更新配置（Key 留空表示不修改） |
| POST | `/api/ai/test` | 测试连通性（返回 401/402/404 等友好错误） |
| POST | `/api/ai/suggestion` | 实时轻量建议（含本地降级） |
| POST | `/api/ai/analyze` | 综合肩颈分析报告 |

---

## 五、数据库设计

> 以下为概览，**实际表结构以 `backend/db/database.py` 的 `init_db()` 为准**。

**usage_record**（每日使用时长）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键，自增 |
| date | TEXT (UNIQUE) | 日期 (YYYY-MM-DD) |
| usage_minutes | INTEGER | 当日使用时长（分钟），由调度器每分钟 +1 |
| break_count | INTEGER | 当日活动（休息）次数 |

**posture_score**（姿势评分记录）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键，自增 |
| timestamp | TEXT | ISO 8601 记录时间 |
| head_angle | REAL | 头部侧倾角（度） |
| shoulder_diff | REAL | 肩部高差（占肩宽百分比） |
| spine_angle | REAL | 脊柱倾斜角（度） |
| score | INTEGER | 姿态评分 (20–100) |

**activity_log**（活动记录）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键，自增 |
| timestamp | TEXT | 活动完成时间 |
| activity_type | TEXT | 活动类型，默认 `'exercise'` |
| exercise_count | INTEGER | 完成的动作数量 |
| duration_sec | INTEGER | 活动时长（秒） |
| avg_score | INTEGER | 活动期间平均姿态评分 |

**settings**（用户设置）：`key` TEXT PK / `value` TEXT。
默认值：`reminder_interval='30'`、`ai_enabled='false'`、`auto_start='false'`、
`voice_enabled='true'`、`deepseek_api_key=''`、`deepseek_base_url=''`、`deepseek_model='deepseek-chat'`。

---

## 六、API 接口

> 实时姿势流走 WebSocket `/ws/camera`，不在下表内。桌面端走 HTTP，移动端走同一组接口的本地实现。

| 模块 | 接口数 | 功能 |
|------|----------|----------|
| posture | 4 | 姿势评分记录、历史、均值、趋势 |
| stats | 2 | 周报统计、今日摘要 |
| reminder | 3 | 结束休息、延迟提醒、状态查询 |
| ai | 5 | 配置读写、连通性测试、实时建议、综合分析 |
| settings | 3 | 获取全部/单个设置、更新设置 |
| activity | 3 | 记录活动、最近活动、今日活动数 |

**`POST /api/ai/suggestion`** 请求：

```json
{
  "head_angle": 28.0,
  "shoulder_diff": 12.0,
  "spine_angle": 15.0,
  "history_avg": 55.0,
  "issues": ["头部明显侧倾", "肩部明显不平衡"]
}
```

响应（命中 AI，需配置 Key）：`{ "source": "ai", "suggestion": "..." }`
响应（降级本地规则）：`{ "source": "fallback", "suggestions": ["...", "..."] }`

---

## 七、安全设计

| 措施 | 位置 | 说明 |
|------|------|------|
| 上下文隔离 | `electron/preload.ts` | 禁用 `nodeIntegration`，启用 `contextIsolation` |
| CORS 限制 | FastAPI middleware | 仅允许本地来源（Vite 5173 + `file://`） |
| API Key 保护 | 本机 SQLite + 掩码 | Key 只存本机；接口返回一律掩码 |
| 单实例运行 | `electron/main.ts` | 防止多进程竞争 |
| 摄像头隐私 | 用户授权 | 画面仅本地处理，不上传；移动端不出设备 |
| 后端监听 | `127.0.0.1:18920` | 只绑本机回环，不对外暴露 |

---

## 八、构建与发布

各端构建细节（含 macOS 签名/公证、iOS 权限链、安卓工具链）见
[MULTIPLATFORM.md](MULTIPLATFORM.md) 与 [ANDROID_BUILD.md](ANDROID_BUILD.md)。
这里只讲三条容易漏的：

### 8.1 版本号五处同步

`npm run set-version`（`--code=N` 递增安卓 versionCode / `--dry-run` / `--check`）：

1. `package.json` 的 `version`
2. `backend/config.py` 的 `APP_VERSION`
3. `src/pages/Settings.tsx` 的兜底串
4. `android/app/build.gradle` 的 `versionName`（`versionCode` 需**另行递增**）
5. `ios/.../project.pbxproj` 的 `MARKETING_VERSION`

`npm run set-version -- --check` 不一致就 `exit 1`。

### 8.2 发布流程

打 `v*` tag → CI 构建四端 → 建 **draft** Release → 人工确认后
`gh release edit <tag> --draft=false --latest` 公开。

**停在 draft 是刻意的**：mac / iOS 未做真机验证，Release 一旦公开就有人下载。
Android 无签名 secrets 时产出的是 debug 包（不可分发），会被 CD 自动剔除。

发布前必须过 [MULTIPLATFORM.md §9 验证清单](MULTIPLATFORM.md)，
发布后必须匿名 `curl` 验 Content-Type。

### 8.3 出包顺序

`vite build` 的 `dist/` 是**桌面包与移动包的共同输入**，且 `cap-build` 会**覆盖** `dist/`。
所以同一版本要出多端时必须**串行**：先桌面后移动，且**同源验证要在各自构建完成后立刻做**
（拖到下一步就被新的 `dist/` 覆盖，再也比不了）。

---

## 九、开发铁律速查

这些是踩过坑换来的，违反通常**不报错**，只是结果悄悄不对。

| # | 铁律 | 违反的后果 |
|---|---|---|
| 1 | 改 `scorer.py` / `smoother.py` / `pose_detector.py` / `localPoseEngine.ts` 后必跑 `verify:parity` | 各端分数不一致，用户看到"同一姿势两种分数" |
| 2 | 取整一律 `round(x*100)/100`（前端 `pyRound()`） | Python 银行家舍入与 JS 不一致，边界处差 1 分 |
| 3 | 业务组件问能力（`supports()`），不写 `platform === 'electron'` | 新增平台要改一堆业务代码 |
| 4 | `useWebSocket()` 的返回值不许整个进依赖数组 | effect 反复重建 → 摄像头"无限正在启动" |
| 5 | MediaPipe 资源放 `mediapipe-assets/`，**不许放 `public/`** | Vite 全量复制 → 桌面包凭空增重 27 MB |
| 6 | `mediapipe==0.10.13` 必须配 `protobuf>=4.25.3,<5` | protobuf 5+ 抛 `FieldDescriptor has no attribute 'label'`，表现为前端永远"正在连接后端..." |
| 7 | 打包后删掉 `build/neckguardian-backend/data/` | 把含测试数据的 DB 发给用户 |
| 8 | 托盘图标取 `getDistAsset()`，不用 `getAssetPath('public',...)` | 打包后 `resources/public/` 不存在 → 图标静默空白、零报错 |
| 9 | `android/gradlew` 必须保留可执行位（`git update-index --chmod=+x`） | Unix CI 上 Permission denied |
| 10 | 推 `.github/workflows/**` 前确认凭据带 `workflow` scope | GitHub **整体拒绝**这次 push（不是跳过那几个文件） |
| 11 | 保证「有提醒 ⟺ 分数 < 80」这条不变量 | 出提醒却不扣分，提醒链路形同虚设 |
| 12 | 改评分公式要接受 80–89 死区与阈值处的台阶 | 以为是自己写错了 |

> 更细的排查手册见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)；
> 本机（Windows + 沙箱 + 代理）特有的环境坑见技能 `windows-powershell-pitfalls`。
