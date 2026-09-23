# NeckGuardian - 肩颈健康助手

🧘‍♂️ **守护您的肩颈健康，让工作更高效、生活更舒适**

NeckGuardian 是一款智能肩颈健康监测与活动提醒应用，通过摄像头实时监测用户姿势，帮助您养成良好的工作习惯。

**支持四端，同一份前端代码：**

| | 形态 | 推理位置 | 数据存储 | 产物 |
|---|---|---|---|---|
| 🖥️ **Windows** | 桌面 | Python 后端 | 后端 SQLite | NSIS `.exe` |
| 🍎 **macOS** | 桌面 | Python 后端 | 后端 SQLite | `.dmg` / `.zip` |
| 📱 **Android** | 移动 | WebView 内 wasm | 本机 IndexedDB | `.apk` |
| 📱 **iOS** | 移动 | WKWebView 内 wasm | 本机 IndexedDB | `.xcarchive` / `.ipa` |

> 移动端**无需后端、无需联网**，姿态检测全程在本机完成，摄像头画面不出设备。

---

## ⬇️ 下载

| 平台 | 文件 | 大小 | 说明 |
|------|------|------|------|
| 🖥️ Windows | [NeckGuardian Setup 1.3.7.exe](https://github.com/cwxa/HealthyDesk/releases/download/v1.3.7/NeckGuardian.Setup.1.3.7.exe) | 197 MB | 安装包（内含自包含后端，无需装 Python）；首次启动会请求摄像头权限 |
| 📱 Android | [NeckGuardian-Android-1.3.7.apk](https://github.com/cwxa/HealthyDesk/releases/download/v1.3.7/NeckGuardian-Android-1.3.7.apk) | 16.9 MB | 已用自有密钥签名，可直接分发；需允许「未知来源应用」 |
| 🍎 macOS | 构建中 | — | 需 macOS 编译（后端不可交叉编译），见 [docs/MULTIPLATFORM.md](docs/MULTIPLATFORM.md) §3.2 |
| 📱 iOS | 构建中 | — | 需 macOS + Xcode，见 [docs/MULTIPLATFORM.md](docs/MULTIPLATFORM.md) §3.4 |

> 📱 安卓包签名指纹（SHA-256）：`9adaa8b20c384eae1a6ed4f57dbd2d98b3965838f0661c2b88fca3031b3a2bd5`
> 后续升级必须用同一把密钥签名，否则老用户无法覆盖安装（密钥位置与备份要求见 [docs/ANDROID_BUILD.md §3.4](docs/ANDROID_BUILD.md)）。

最新版本：**[v1.3.7](https://github.com/cwxa/HealthyDesk/releases/tag/v1.3.7)**（Windows 与 Android 同为 1.3.7）｜ 全部版本：[Releases](https://github.com/cwxa/HealthyDesk/releases)

> 🍎 **macOS / iOS 需要 macOS 构建**：iOS 的编译链只有 macOS 有；macOS 包要内置
> 一个 macOS 原生的 Python 后端，而 PyInstaller 不能交叉编译。
> 两条路：用 CI（`.github/workflows/build.yml` 会在 GitHub 的 macOS runner 上出包），
> 或在一台真实 Mac 上构建。
> 打 `v*` tag 时 CI 会构建四端并自动创建 **draft Release**（含 `SHA256SUMS.txt`），
> 人工确认无误后再 `gh release edit <tag> --draft=false --latest` 公开。

> ✨ **v1.3.7 是架构版本**：平台差异收敛为「能力矩阵」，补齐 macOS / iOS 两端，修掉若干跨平台
> 静默 bug。**评分与提醒逻辑一个字没改**，同一姿势的分数与 v1.3.6 完全一致。
>
> ⚠️ v1.3.6 起评分模型有调整（详见下方「评分算法」）。旧版本记录的历史分数由旧公式产生，
> 统计图表在跨版本处会有落差，这是预期内的，不是数据出错。
>
> ✅ **同一姿势在四个平台上得到完全相同的分数**：各端的角度计算、EMA 平滑、
> 评分三套逻辑逐位等价，由 `npm run verify:parity` 守卫（21 项常量 + 80 条评分用例 +
> 439 帧平滑序列 + 8 条角度用例）。

---

## 📱 移动端快速上手（Android / iOS）

移动端把姿态检测整个搬进了手机（MediaPipe WASM/GPU 本地推理），摄像头画面**不出设备**。

```bash
# 1. 安装依赖
npm install

# ---- Android ----
npm run cap:build            # debug 包，自测用
npm run cap:build:release    # release 包，已配置签名，用于分发
# 产物：android/app/build/outputs/apk/{debug,release}/app-{debug,release}.apk
npm run cap:build -- --skip-web   # 只改了原生代码时跳过前端构建，快一倍
npm run cap:open             # = npm run cap:sync && cap open android

# ---- iOS（只能在 macOS 上跑）----
node scripts/ios-build.js            # 未签名归档（验证可编译）
node scripts/ios-build.js --export   # 导出 IPA（需签名配置）
npm run ios                          # = npm run cap:sync:ios && cap open ios
```

详细的构建流程、权限配置、签名与常见问题：

- 安卓 → **[docs/ANDROID_BUILD.md](docs/ANDROID_BUILD.md)**
- iOS / macOS、平台矩阵、CI → **[docs/MULTIPLATFORM.md](docs/MULTIPLATFORM.md)**

> 前提：Android 需要 JDK 17 + Android SDK 34（可用 Android Studio 自带，也可纯命令行装）。
> **本仓库的开发机已在 `E:\AndroidDev` 装好整套命令行工具链与 release 签名密钥**，`npm run cap:build` 开箱即用，详见文档 §2.1 / §3.4。
> iOS 需要 Xcode + CocoaPods。

---

## 📖 一、用户使用指南

### 1.1 快速入门

#### 安装与启动

1. **下载安装包** - 从官方渠道获取最新版本的安装包
2. **运行安装程序** - 双击安装包，按照向导完成安装
3. **首次启动** - 启动后系统会提示授予摄像头访问权限，请点击"允许"

#### 界面介绍

| 区域 | 功能说明 |
|------|----------|
| **侧边导航栏** | 切换主页、数据统计、设置页面 |
| **姿势评分仪表盘** | 实时显示当前姿势评分（0-100分） |
| **骨架动画区域** | 实时展示摄像头捕捉的人体姿势骨架 |
| **活动面板** | 肩颈拉伸运动指导与练习区域 |
| **系统托盘图标** | 最小化时可通过右键菜单操作 |

### 1.2 核心功能使用

#### 📷 姿势监测

- 启动应用后，摄像头会自动开启并实时分析您的姿势
- 系统会检测：头部倾斜角度、肩部高度差异、脊柱弯曲程度
- 评分仪表盘会实时显示姿势健康评分（绿色=良好，黄色=一般，红色=需改善）

#### ⏰ 智能提醒

- 默认每 **30分钟** 提醒一次活动（可在设置中调整）
- 提醒弹窗会出现在屏幕中央，可选择：
  - **开始活动** - 进入肩颈拉伸练习模式
  - **稍后提醒** - 5分钟后再次提醒
- 系统托盘会同步显示提醒通知

#### 🧘‍♀️ 肩颈活动

1. 点击"开始活动"按钮进入活动模式
2. 跟随屏幕上的动画指导完成以下动作：
   - 颈部拉伸（左/右/前/后）
   - 肩部环绕
   - 深呼吸练习
3. 完成活动后可获得积分奖励

#### 📊 数据统计

点击左侧导航栏的"数据统计"按钮，查看：
- **今日统计**：姿势评分趋势、活动次数、累计活动时长
- **周统计**：每日评分对比、活动频率图表
- **历史记录**：详细的姿势记录和活动日志

#### ⚙️ 设置

在设置页面可调整：
- 提醒间隔时间（2-120分钟）
- AI 增强模式开关（连接 DeepSeek）
- 语音播报开关
- 开机自启动开关

#### 🤖 AI 肩颈分析（DeepSeek）

NeckGuardian 支持接入 **DeepSeek 大模型**，对您的肩颈情况生成个性化分析报告：

1. 前往 [platform.deepseek.com](https://platform.deepseek.com) 创建 **API Key**
2. 打开「系统设置」→「DeepSeek 大模型」，粘贴 API Key
3. 选择模型（`deepseek-chat` 快速 / `deepseek-reasoner` 深度推理），点击「保存配置」
4. 点击「测试连接」确认 Key 可用
5. 开启「AI 增强模式」后，进入「仪表盘」点击「生成分析」

AI 会结合您的**实时姿态指标**（头部侧倾、肩部高差、脊柱倾斜）与**近期使用数据**（今日/本周评分、活动次数、完成率）生成结构化报告：整体评估 → 问题分析 → 改善建议 → 今日行动。

> 🔒 **隐私说明**：API Key 仅保存在本机数据库，不会上传；仅在您主动点击「生成分析」时，才会将**匿名的姿态指标与统计数据**（不含摄像头画面）发送至 DeepSeek。

### 1.3 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl++` | 放大窗口 |
| `Ctrl+-` | 缩小窗口 |
| `Ctrl+0` | 恢复默认缩放 |

> 以上为桌面端快捷键；移动端（Android / iOS）无键盘快捷键，改用底部标签栏切换页面。

### 1.4 移动端使用说明（Android / iOS）

移动端界面针对触屏与竖屏做了精简（顶部栏 + 内容 + 底部标签栏）：

| 差异点 | 桌面端 | 移动端（Android / iOS） |
|--------|--------|--------|
| 导航 | 左侧边栏 | 底部标签栏（肩颈活动 / 仪表盘 / 设置） |
| 姿态检测 | 连接本地 Python 后端 | **手机本地推理**，无需后端 |
| 摄像头画面 | 上传到本机后端处理 | **完全不出设备** |
| 数据存储 | 本机 SQLite | 应用内 IndexedDB（卸载即清除） |
| AI 分析 | 支持 DeepSeek | 本期不提供（设置页已隐藏入口） |
| 开机自启动 | 支持 | 不提供 |

**首次使用**：打开 App 会弹出「允许使用摄像头？」，点**允许**。若误点拒绝，
Android 去「系统设置 → 应用 → NeckGuardian → 权限 → 相机」，iOS 去「设置 → NeckGuardian → 相机」手动打开。

**已知限制**：
- 切到后台或锁屏后，姿态检测与提醒会暂停（手机系统会冻结后台 WebView）；
- 中低端机型推理帧率较低（GPU 不可用时自动回退 CPU）；
- 语音播报依赖系统中文语音包，缺失时会静默失败。

### 1.5 常见问题

**Q: 摄像头无法启动怎么办？**
- 请检查系统隐私设置，确保已授予摄像头权限
- 尝试重启应用或重新安装

**Q: 提醒功能不工作？**
- 检查设置中的提醒间隔是否设置合理
- 确保应用在系统托盘中正常运行（未被系统休眠）
- 移动端请保持 App 在前台，后台会被系统暂停计时

**Q: 如何退出应用？**
- 右键点击系统托盘图标，选择"退出"
- 或在设置页面点击"退出应用"
- 安卓 / iOS：从最近任务列表划掉，或系统设置中强制停止

---

## 🏗️ 二、开发技术架构

### 2.1 系统架构

四端（Windows / macOS / Android / iOS）是**同一份 React 前端 + 一个平台能力层**：
页面、组件、业务 Hook 完全共用，差异只在「谁来推理、数据存哪、提醒怎么发」三件事上，
而这三件事全部收敛在 `src/platform/` 一处。

#### 平台矩阵

| 端 | 运行壳 | 姿态推理 | 数据存储 | 提醒通道 |
|---|---|---|---|---|
| Windows | Electron（托盘 / 开机自启） | Python 后端 + MediaPipe | 后端 SQLite | 后端调度器 → IPC 弹窗 |
| macOS | Electron（菜单栏 Template 图标） | 同上 | 同上 | 同上 |
| Android | Capacitor WebView | 前端本地 MediaPipe **wasm** | IndexedDB | 本地定时器 + 系统通知 |
| iOS | Capacitor WKWebView | 同上 | 同上 | 同上 |

#### 整体架构图

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

#### 架构特点

| 特性 | 说明 |
|------|------|
| **能力矩阵而非平台分支** | 业务层问 `supports('systemTray')`，不写 `platform === 'electron'`；新增平台只改一张表 |
| **平台与宿主 OS 正交** | `RuntimePlatform`（electron/android/ios/web）与 `HostOS`（windows/macos/…）独立，桌面文案随 OS 变 |
| **单一数值实现** | 评分/角度/平滑各端逐位等价，由 `npm run verify:parity` 守住（详见 2.3.1） |
| **进程隔离** | 桌面端 Electron 主进程与渲染进程隔离，后端作为独立子进程运行 |
| **实时通信** | 桌面走 WebSocket 低延迟数据流；移动端在页面内直接推理，无网络往返 |
| **全程离线** | 移动端无后端依赖，桌面端后端为本地进程，不依赖任何云服务 |

> 端到端的构建、签名与权限配置见 **[docs/MULTIPLATFORM.md](docs/MULTIPLATFORM.md)**。

### 2.2 目录结构与职责

```
HealthyDesk/
├── backend/                    # Python 后端服务 (FastAPI)
│   ├── api/                   # REST API 路由层
│   │   ├── activity.py        # 活动记录 CRUD
│   │   ├── ai.py              # AI 顾问接口
│   │   ├── posture.py         # 姿势数据接口
│   │   ├── reminder.py        # 提醒系统控制
│   │   ├── settings.py        # 用户设置管理
│   │   └── stats.py           # 统计数据查询
│   ├── db/                    # 数据访问层
│   │   └── database.py        # SQLite ORM 封装
│   ├── services/              # 业务逻辑层
│   │   ├── ai_advisor.py      # AI 健康建议 / 综合报告生成
│   │   ├── ai_config.py       # DeepSeek 配置解析（DB > 环境变量）
│   │   ├── fallback.py        # AI 不可用时的降级方案
│   │   ├── pose_detector.py   # MediaPipe 姿势检测核心
│   │   ├── scheduler.py       # APScheduler 定时任务
│   │   └── scorer.py          # 姿势评分算法
│   ├── ws/                    # WebSocket 服务
│   │   └── camera_ws.py       # 实时姿势数据流推送
│   ├── config.py              # 全局配置管理
│   ├── main.py                # FastAPI 应用入口
│   └── requirements.txt       # Python 依赖清单
├── electron/                  # Electron 主进程（Windows / macOS / Linux 通用）
│   ├── main.ts                # 主进程入口：窗口/托盘/自启/后端子进程（平台分支集中在此）
│   └── preload.ts             # 预加载脚本，API 桥接（同时暴露平台与架构信息）
├── src/                       # React 前端 (渲染进程)
│   ├── components/            # 可复用 UI 组件
│   │   ├── AIAnalysisPanel.tsx   # AI 肩颈分析面板
│   │   ├── BottomTabs.tsx        # 移动端底部标签栏
│   │   ├── BreathingCircle.tsx   # 呼吸练习动画组件
│   │   ├── ExerciseGuide.tsx     # 活动指导组件
│   │   ├── ExercisePanel.tsx     # 活动面板容器
│   │   ├── Markdown.tsx          # 轻量 Markdown 渲染
│   │   ├── PostureSkeleton.tsx   # 骨架动画渲染
│   │   ├── ScoreGauge.tsx        # 环形评分仪表盘
│   │   ├── Sidebar.tsx           # 侧边导航栏（桌面端）
│   │   └── TrendChart.tsx        # 趋势图表组件
│   ├── hooks/                 # 自定义 React Hooks
│   │   ├── useAI.ts           # AI 配置 / 分析请求封装
│   │   ├── useApi.ts          # API 请求封装（按平台分流）
│   │   ├── usePoseEngine.ts   # 统一姿态检测（桌面 WS / 移动本地）
│   │   └── useWebSocket.ts    # WebSocket 连接管理（桌面端）
│   ├── platform/              # 平台能力层（四端差异的唯一收敛处）
│   │   ├── runtime.ts         # 平台 / 宿主 OS 判定 + 能力矩阵（唯一真相来源）
│   │   ├── nativeDiag.ts      # 原生权限诊断（Android 原生桥 · iOS/Web Permissions API）
│   │   ├── dataLayer.ts       # 统一数据层（HTTP vs IndexedDB）
│   │   ├── localDb.ts         # 移动端 IndexedDB 封装
│   │   ├── localStats.ts      # 移动端统计聚合（对齐后端 SQL）
│   │   ├── localPoseEngine.ts # 移动端本地 MediaPipe 推理与评分
│   │   └── localReminder.ts   # 移动端本地提醒调度器
│   ├── pages/                 # 页面级组件
│   │   ├── Dashboard.tsx      # 数据统计页
│   │   ├── NeckActivity.tsx   # 肩颈活动主页面
│   │   └── Settings.tsx       # 设置页
│   ├── utils/                 # 工具函数
│   │   └── speech.ts          # 语音播报封装
│   ├── App.tsx                # 应用根组件（含移动端布局分流）
│   ├── main.tsx               # React 入口
│   └── types.ts               # TypeScript 类型定义
├── android/                   # Capacitor 安卓工程（Android Studio 打开）
│   └── app/src/main/
│       ├── java/com/neckguardian/app/MainActivity.java  # 摄像头权限覆写
│       ├── assets/public/     # 由 cap sync 拷入的 Web 产物（含媒体模型）
│       └── res/               # 图标、启动图、主题、颜色资源
├── ios/                       # Capacitor iOS 工程（Xcode 打开，必须在 macOS 上构建）
│   └── App/App/
│       ├── Info.plist         # NSCameraUsageDescription 等权限声明
│       └── Assets.xcassets/   # AppIcon / LaunchScreen（由生成脚本产出）
├── macos/                     # macOS 打包资源
│   ├── entitlements.mac.plist          # 主进程权限（JIT / 摄像头等）
│   └── entitlements.mac.inherit.plist  # 子进程权限（仅 JIT 相关）
├── public/                    # 桌面端静态资源（会被 Vite 全量复制进 dist/）
├── mediapipe-assets/          # 移动端 MediaPipe 资源（不入 public/，避免污染桌面包）
│   └── models/                #   pose_landmarker_full.task（9.4MB，随包内置）
├── scripts/                   # 构建与校验脚本
│   ├── cap-build.js           # 移动端 Web 构建（tsc + vite build + 拷贝 MediaPipe 资源）
│   ├── android-build.js       # 安卓出包（cap sync → gradle assemble）
│   ├── ios-build.js           # iOS 出包（仅 macOS：cap sync → pod install → xcodebuild）
│   ├── set-version.js         # 五处版本号统一写入 / --check 校验
│   ├── verify-backend-binary.js  # 校验后端产物格式与架构是否匹配目标平台
│   ├── gen-mac-icons.js       # ICNS / 菜单栏 Template 图 / iOS 图标与启动图
│   ├── gen-android-splash.js  # 安卓启动图重绘
│   ├── gen-android-icons.py   # 安卓图标生成
│   ├── gen-scoring-cases.py   # 生成评分期望值（Python 侧）
│   ├── gen-angle-cases.py     # 生成角度期望值（Python 侧）
│   ├── verify-scoring.mjs     # 评分等价性验证
│   └── verify-angles.mjs      # 角度等价性验证
├── docs/                      # 文档
│   ├── MULTIPLATFORM.md       # 四端架构与构建总览（含 mac 签名公证、iOS 权限链）
│   ├── ANDROID_BUILD.md       # 安卓构建指南
│   └── TROUBLESHOOTING.md     # 故障排查
├── .github/workflows/         # CI/CD：四端构建 + 同源/架构/版本校验 + tag 自动发 draft Release
├── capacitor.config.ts        # Capacitor 配置（android / ios）
├── package.json               # 前端依赖与脚本矩阵
├── vite.config.ts             # Vite 构建配置（双目标：桌面 / 移动，注入版本与构建目标）
├── tsconfig.json              # TypeScript 配置
└── electron-builder.yml       # Electron 打包配置（win / mac / linux）
```

### 2.3 核心技术组件

#### 2.3.1 姿势检测系统

**核心算法流程**：

```
摄像头输入 → MediaPipe 人体姿态估计 → 关键点提取 → 角度计算 → 评分生成
```

**检测指标**：
- **头部倾斜角度**：耳朵连线与水平线的夹角（阈值 ±5°）
- **肩部高度差**：双肩关键点的垂直距离（阈值 4% 肩宽）
- **脊柱弯曲角度**：颈部与背部关键点的连线角度（阈值 ±10°）

**评分算法**（`backend/services/scorer.py`，手机端在 `src/platform/localPoseEngine.ts` 逐行等价实现）：

评分与姿态提醒**严格绑定**，核心不变量：

> **出现任何提醒 ⟺ 分数低于 80**

每项指标按超标量分「轻微 / 明显 / 严重」三档，扣分与提醒文案一一对应；最差的一项算满，
其余两项按 0.3 权重递减叠加（三个指标来自同一组关键点、彼此强相关，直接相加会过度惩罚）。
阈值内另有一段「预警区」，接近阈值时轻微扣分，避免「刚好合格 = 100 分、刚超标 = 78 分」的突变。

| 头部侧倾（阈值 5°，其余两项正常时） | 分数 | 提醒 |
|---|---|---|
| ≤ 5° | 90 – 100 | — |
| 5° – 11° | 72 – 78 | 头部轻微侧倾 |
| 11° – 17° | 54 – 66 | 头部明显侧倾 |
| > 17° | 35 – 48 | 头部严重侧倾 |

各端一致性由 `npm run verify:parity` 保证（80 条评分用例 + 42 条 / 439 帧平滑序列 +
8 条角度用例，含上述不变量的断言；前端侧直接 bundle **真实源码**执行，不用内联副本）。

> 阈值处有一处**有意的台阶**：`head` 从 5.00° 到 5.01°，分数由 94 掉到 78。这是
> 「有提醒 ⟺ 分数 < 80」的必然结果——提醒一旦出现，分数就必须已经在 80 以下。
> 因此 80–89 分是模型的**死区**，永远不会出现（无提醒 ≥ 90，有提醒 ≤ 78）。

#### 2.3.2 实时通信架构

**WebSocket 数据流**：
1. 前端通过 `/ws/camera` 连接 WebSocket
2. 后端 `pose_detector.py` 持续推送姿势数据（30fps）
3. 前端接收数据后实时更新骨架动画和评分

**IPC 通信**（Electron）：
- `get-backend-url` - 获取后端 API 地址
- `minimize-to-tray` - 最小化到托盘
- `quit-app` - 退出应用
- `onReminder` - 提醒事件通知

#### 2.3.3 定时提醒系统

**核心组件**：`backend/services/scheduler.py`

- 使用 **APScheduler** 实现定时任务
- 支持动态调整提醒间隔
- 回调机制通知前端和 Electron

**提醒触发逻辑**：
```
时间触发 → 检查当前状态 → 发送 WebSocket 通知 → Electron 弹窗提醒
```

#### 2.3.4 AI 健康顾问（DeepSeek 接入）

**配置优先级**：数据库设置（用户在应用内填写） > 环境变量（部署默认值）。
用户在「系统设置」填写的 API Key 会写入 `settings` 表，重启后依然生效；接口下发的 Key 一律**掩码处理**，绝不回传明文。

**技术方案**：
- 集成 **DeepSeek Chat Completions API**（`/v1/chat/completions`，Bearer 鉴权）
- 支持 **降级方案**（未配置 Key 时使用本地预设建议）
- 支持两类调用：
  - `/api/ai/suggestion` — 实时单条轻量建议
  - `/api/ai/analyze` — 结合实时姿态 + 近期使用数据的结构化分析报告

**数据流向**：
```
姿态指标 + 使用统计 → 组装结构化 Prompt → DeepSeek API → Markdown 报告 → 前端渲染
```

**接口一览**：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ai/config` | 读取配置（Key 掩码） |
| PUT | `/api/ai/config` | 更新配置（Key 留空表示不修改） |
| POST | `/api/ai/test` | 测试连通性（返回 401/402/404 等友好错误） |
| POST | `/api/ai/suggestion` | 实时轻量建议（含本地降级） |
| POST | `/api/ai/analyze` | 综合肩颈分析报告 |

### 2.4 数据库设计

#### 表结构

> 实际表结构以 `backend/db/database.py` 中的 `init_db()` 为准。

**usage_record**（每日使用时长）：
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键，自增 |
| date | TEXT (UNIQUE) | 日期 (YYYY-MM-DD) |
| usage_minutes | INTEGER | 当日电脑使用时长（分钟），由调度器每分钟 +1 |
| break_count | INTEGER | 当日活动（休息）次数 |

**posture_score**（姿势评分记录）：
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键，自增 |
| timestamp | TEXT | ISO 8601 记录时间 |
| head_angle | REAL | 头部侧倾角（度） |
| shoulder_diff | REAL | 肩部高度差（占肩宽百分比） |
| spine_angle | REAL | 脊柱倾斜角（度） |
| score | INTEGER | 姿态评分 (20–100) |

**activity_log**（活动记录）：
| 字段 | 类型 | 说明 |
|------|------|------|
| id | INTEGER | 主键，自增 |
| timestamp | TEXT | 活动完成时间 |
| activity_type | TEXT | 活动类型，默认 `'exercise'` |
| exercise_count | INTEGER | 完成的动作数量 |
| duration_sec | INTEGER | 活动时长（秒） |
| avg_score | INTEGER | 活动期间平均姿态评分 |

**settings**（用户设置）：
| 字段 | 类型 | 说明 |
|------|------|------|
| key | TEXT (PK) | 设置键名 |
| value | TEXT | 设置值 |

默认设置：`reminder_interval='30'`、`ai_enabled='false'`、`auto_start='false'`、`voice_enabled='true'`、`deepseek_api_key=''`、`deepseek_base_url=''`、`deepseek_model='deepseek-chat'`。

### 2.5 API 接口设计

#### 接口分类

> 实时姿势流通过 WebSocket `/ws/camera` 推送，不属于下方 REST 接口。

| 模块 | 接口数量 | 功能说明 |
|------|----------|----------|
| posture | 4 | 姿势评分记录、历史、均值、趋势 |
| stats | 2 | 周报统计、今日摘要 |
| reminder | 3 | 结束休息、延迟提醒、状态查询 |
| ai | 5 | 配置读写、连通性测试、实时建议、综合分析 |
| settings | 3 | 获取全部/单个设置、更新设置 |
| activity | 3 | 记录活动、最近活动、今日活动数 |

#### 核心接口示例

**POST /api/ai/suggestion**

请求体：
```json
{
  "head_angle": 28.0,
  "shoulder_diff": 12.0,
  "spine_angle": 15.0,
  "history_avg": 55.0,
  "issues": ["头部明显侧倾", "肩部明显不平衡"]
}
```

响应体（命中 AI，需配置 `DEEPSEEK_API_KEY`）：
```json
{ "source": "ai", "suggestion": "..." }
```

响应体（降级本地规则）：
```json
{ "source": "fallback", "suggestions": ["...", "..."] }
```


### 2.6 部署与构建

#### 环境要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Node.js | >= 18.x | 前端运行时 |
| Python | >= 3.10 | 后端运行时（桌面版） |
| npm | >= 9.x | 包管理器 |
| JDK 17 + Android SDK 34 | — | 出安卓 APK（本机已装在 `E:\AndroidDev`，或用 Android Studio 自带） |
| macOS + Xcode | — | **出 macOS 包与 iOS 包必需**（见下方说明） |

> 🔴 **Windows 上只能构建 Windows 与 Android**。macOS 与 iOS 都必须在 macOS 上构建：
> iOS 需要 Xcode / clang / 代码签名（没有非 macOS 实现）；macOS 安装包里要内置一个
> **macOS 原生的 Python 后端**，而 PyInstaller 不能交叉编译。
> 没有 Mac 机器时走 CI（`.github/workflows/build.yml`，已在仓库里配好）。

#### 开发流程

```bash
# 1. 安装依赖
npm install
npm run python:install

# 2. 启动开发服务器
npm run start

# 3. 构建桌面版
npm run build          # 按当前系统出包
npm run build:win      # Windows（NSIS 安装包）
npm run build:mac      # macOS（dmg + zip；须在 macOS 上执行）
npm run build:linux    # Linux（AppImage + deb）

# 4. 仅启动后端 / 仅启动前端（调试用）
npm run python:start
npm run dev

# ---- 移动端 ----
npm run cap:build          # 安卓 debug APK（一条命令：前端构建 + sync + gradle）
npm run cap:build:release  # 安卓正式包（需 android/keystore.properties）
npm run cap:sync           # 只编译前端 + 同步进安卓工程
npm run cap:open           # 用 Android Studio 打开 android/
npm run android            # = cap:sync + cap:open

npm run cap:build:ios      # iOS 未签名归档（须在 macOS 上执行）
npm run cap:sync:ios       # 只编译前端 + 同步进 iOS 工程
npm run ios                # = cap:sync:ios + cap:open:ios（用 Xcode 打开）

npm run verify:all         # 数值一致性 + 版本号五处一致性
```

#### 打包配置

`electron-builder.yml` 关键配置：
- **目标平台**：Windows (NSIS) / macOS (dmg + zip，x64 与 arm64 各出一份) / Linux (AppImage + deb)
- **资源打包**：backend 目录（PyInstaller 产物）、dist 资源
- **macOS 权限**：`macos/entitlements.mac.plist`（JIT、摄像头、库校验豁免）
- **图标配置**：`public/icon.ico` / `public/icon.icns`；菜单栏另有 `tray-iconTemplate.png`

### 2.7 移动端架构（Capacitor：Android + iOS）

移动端复用同一套 React 前端，通过 **平台能力层** 在运行时分流：桌面走 Python 后端，
移动端把推理、存储、提醒全部下沉到 WebView 本地。

```
┌──────────────────────────────────────────────────────────────┐
│          React 前端（同一份代码，四端复用）                    │
│   NeckActivity / Dashboard / Settings / 组件库                │
└───────────────────────────┬──────────────────────────────────┘
                            │ runtime.ts: supports('localBackend')
              ┌─────────────┴─────────────┐
              ▼                           ▼
   ┌────────────────────┐      ┌─────────────────────────────────┐
   │ 桌面 Windows/macOS │      │ 移动 Android / iOS               │
   │ useWebSocket        │      │ usePoseEngine + LocalPoseEngine  │
   │   ↓                 │      │   ↓ MediaPipe WASM/GPU           │
   │ Python 后端         │      │ IndexedDB（本地存储）             │
   │  · MediaPipe 推理   │      │ LocalReminderScheduler           │
   │  · SQLite           │      │   （本地定时提醒）                │
   │  · APScheduler      │      │ 摄像头画面不出设备                 │
   └────────────────────┘      └─────────────────────────────────┘
```

**平台能力对照：**

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
| Android | `WebChromeClient.onPermissionRequest` | 必须在启动阶段**预申请** CAMERA，持有权限时在回调内**同步** `grant()`；诊断走 `addJavascriptInterface` 暴露的只读 `NeckGuardianNative.diagnostics()` |
| iOS | `WKUIDelegate.requestMediaCapturePermissionFor` | Capacitor 已内置授权回调与 `allowsInlineMediaPlayback`，**唯一要手配的是 `Info.plist` 的 `NSCameraUsageDescription`** —— 缺了会被系统直接终止进程（表现为闪退） |

**模型离线内置**：MediaPipe WASM 与 `pose_landmarker_full.task`（约 9.4 MB）随包打进 APK，安装后无需联网。

**数值一致性保障**：前端本地推理的角度计算与评分逻辑，与 Python 后端 **逐行等价**，并用脚本做回归验证：

```bash
python scripts/gen-scoring-cases.py > scripts/scoring-expected.json
python scripts/gen-angle-cases.py   > scripts/angle-expected.json
node scripts/verify-scoring.mjs   # 评分：80 条用例 + 平滑 42 条序列 / 439 帧
node scripts/verify-angles.mjs    # 角度：8 条用例（含边界保护）
# 或一键：npm run verify:parity
```

> 校验脚本用 esbuild 把 `src/platform/localPoseEngine.ts` **真实源码**打出来执行，
> 而不是维护一份内联副本——副本一旦漂移，「各端一致」就成了自我安慰。

> 该验证曾发现两处真实的跨语言差异：
> 1. Python `round()` 用「银行家舍入」（`round(32.5)=32`），而 JS `Math.round` 会进位到 33。
>    已通过 `pyRound()` 对齐。
> 2. 后端平滑器曾写 `round(x, 2)`，而前端是 `pyRound(x * 100) / 100`——**两者不是同一个函数**：
>    `x * 100` 恰好落在半整数时结果不同（`x = 0.015` → 前者 0.01、后者 0.02）。
>    已统一为 `round(x * 100) / 100`，并把 40 个平局点固化成回归用例。

### 2.8 安全性考虑

| 安全措施 | 实现位置 | 说明 |
|----------|----------|------|
| **上下文隔离** | Electron preload.ts | 禁用 nodeIntegration，使用 contextIsolation |
| **CORS 限制** | FastAPI middleware | 仅允许本地访问（开发服务器 + file://） |
| **API Key 保护** | 本机 SQLite + 掩码 | Key 仅存本机数据库，接口返回一律掩码；环境变量作为可选默认值 |
| **单实例运行** | Electron main.ts | 防止多进程竞争 |
| **摄像头权限** | 用户授权 | 首次使用需用户确认；画面仅本地处理，不上传 |

---

## 📋 版本历史

完整变更说明见 [Releases](https://github.com/cwxa/HealthyDesk/releases)。

| 版本 | 主题 | 要点 |
|------|------|------|
| **v1.3.7** | 四端架构 | 平台差异收敛为「能力矩阵」，补齐 macOS / iOS，修掉托盘图标静默失效等跨平台 bug。**评分逻辑未改动**，同一姿势分数与 v1.3.6 完全一致 |
| v1.3.6 | 评分与提醒对齐 | 建立核心不变量「有提醒 ⟺ 分数 < 80」；评分公式调整 |
| v1.3.5 | 修画面跳动 | 随高频数据出现/消失的提示改为固定容器内的绝对定位浮层；修练习动画遮挡徽章 |
| v1.3.4 | 摄像头链路 + 手机整屏布局 | **安卓真机通过**；「肩颈活动」页改为固定高度不滚动 |
| v1.3.2 ~ v1.3.3 | 安卓接入 | Capacitor 套壳 + 手机本地 MediaPipe 推理；修「允许权限但打不开」的授权竞态 |
| v1.3.1 | 修「正在连接后端...」 | `mediapipe==0.10.13` 必须配 `protobuf<5`，否则后端启动即失败 |
| v1.3.0 | AI 肩颈分析 | 接入 DeepSeek |

> ⚠️ **升级注意**：v1.3.6 起评分公式有调整，旧版本记录的历史分数与新公式刻度不同，
> 统计图表在跨版本交界处会出现落差，这是预期内的、不是数据出错。
>
> 🔒 **安卓覆盖安装**：每个版本的 APK 都由同一把密钥签名（SHA-256 指纹见上方「下载」一节），
> 可直接覆盖安装，不会被系统以「签名不一致」拒绝。

---

## 📄 License

MIT License

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

*保持健康姿势，享受高效工作！* 🌟