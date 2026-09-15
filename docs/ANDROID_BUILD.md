# NeckGuardian 安卓端构建与运行

本文档说明如何把 NeckGuardian 打包成安卓 APK，以及在手机上运行的注意事项。

---

## 一、方案总览

安卓端采用 **Capacitor 套壳** 方案：把现有的 React 前端（`src/`）编译成纯静态资源，整体塞进安卓 WebView 里跑。**不依赖 Python 后端**，所有原本由后端承担的能力都下沉到了前端：

| 桌面端（Electron） | 安卓端（Capacitor） | 实现位置 |
|--------------------|---------------------|----------|
| Python 后端跑 MediaPipe 推理 | 手机浏览器内跑 MediaPipe（WASM/GPU） | `src/platform/localPoseEngine.ts` |
| WebSocket `/ws/camera` 传帧 | 本地直接吃 `<video>` 元素，**画面不出设备** | `src/hooks/usePoseEngine.ts` |
| SQLite 数据库 | IndexedDB | `src/platform/localDb.ts` |
| APScheduler 定时提醒 | `setInterval` 调度器 | `src/platform/localReminder.ts` |
| REST `/api/*` | 前端直接读写 IndexedDB | `src/platform/dataLayer.ts` |
| DeepSeek AI 分析 | **本期不支持**（设置页已隐藏相关入口） | — |

平台分流由 `src/platform/runtime.ts` 的 `getPlatform()` / `hasLocalBackend()` 统一判断：
- `window.electronAPI` 存在 → 桌面端，走 HTTP/WebSocket
- 否则 → 移动端，走本地实现

**模型文件已随包内置**，APK 安装后**无需联网**即可做姿态检测。资源落位规则见 [§4.5](#45-mediapipe-运行资源从哪来)。

> 注意：MediaPipe 资源**不放在 `public/`**。Vite 会把 `public/` 全量复制进 `dist/`，而桌面端 `electron-builder.yml` 打包了整个 `dist/**` —— 放 `public/` 会让桌面安装包白白多出 27MB 只给安卓用的文件。详见 §4.5。

---

## 二、环境准备

### 2.1 本机开发环境（当前机器）

已验证可用：
- Node.js（项目用 `node_modules` 内的依赖）
- 前端依赖已安装（`npm install` 完成）

当前机器**未安装** JDK / Android SDK / Gradle，因此**无法在本机直接 `gradlew assemble`**，需要用 Android Studio 出包。

### 2.2 出 APK 需要的环境

任选其一：

**方案 A：Android Studio（推荐，最省事）**
1. 下载并安装 [Android Studio](https://developer.android.com/studio)
2. 首次启动时，安装向导会自动装好 **JDK 17**、**Android SDK**、**Gradle**
3. 在 SDK Manager 里确认已装 **Android SDK Platform 34**（compileSdk 34）

**方案 B：命令行（需自行装工具链）**
- JDK 17（如 [Adoptium Temurin 17](https://adoptium.net/temurin/releases/?version=17)）
- Android SDK Command-line Tools，设置 `ANDROID_HOME` 指向 SDK 目录
- 装 `platforms;android-34` 与 `build-tools;34.0.0`

```bash
# 方案 B 的环境变量示例
export JAVA_HOME="/c/Program Files/Eclipse Adoptium/jdk-17.x.x-hotspot"
export ANDROID_HOME="$LOCALAPPDATA/Android/Sdk"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
```

---

## 三、构建流程

### 3.1 一键同步（每次改完前端代码都要做）

```bash
# 一键完成「编译前端 + 同步进安卓工程」
npm run cap:sync
#   = node scripts/cap-build.js && cap sync android
```

`scripts/cap-build.js` 做三件事：
1. `tsc --noEmit` 类型检查
2. `vite build`（带 `CAP_BUILD=1`，跳过 Electron 插件）
3. 把 MediaPipe 运行资源补齐到 `dist/mediapipe/`

然后 `cap sync android` 把整个 `dist/` 拷进 `android/app/src/main/assets/public/`。

> ⚠️ 桌面端构建（`npm run build` / `npm run electron:build`）也会写 `dist/`，但会额外生成 `dist/main.js`、`dist/preload.js`，且**不含** `dist/mediapipe/`。
> 所以：**先跑 `npm run cap:sync` 再打开 Android Studio**，保证 `dist/` 是纯 Web + MediaPipe 的移动端产物。

### 3.2 用 Android Studio 出包（推荐）

```bash
npm run android
# = npm run cap:sync && cap open android
```

这会自动同步前端产物，并用 Android Studio 打开 `android/` 工程。然后：

1. 等待 Gradle Sync 完成（首次会下载 Gradle 8.2.1 与依赖，比较慢）
2. **调试包**：菜单 `Build → Build Bundle(s) / APK(s) → Build APK(s)`
   - 产物：`android/app/build/outputs/apk/debug/app-debug.apk`
3. **正式包**：`Build → Generate Signed Bundle / APK…`，按向导创建/选择签名证书，选 `release`

### 3.3 命令行出包（需方案 B 环境）

```bash
npm run cap:sync
cd android
./gradlew assembleDebug      # Windows: gradlew.bat assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

`npm run cap:build` 已封装「同步 + assembleDebug」两步。

### 3.4 直接装到手机调试

手机开启「开发者选项 → USB 调试」，连上电脑：

```bash
adb devices                       # 确认设备已识别
cd android && ./gradlew installDebug   # 或 adb install -r app-debug.apk
```

---

## 四、关键配置说明

### 4.1 摄像头权限（最容易踩的坑）

Capacitor 默认的 `WebView` 会**拒绝**网页的 `getUserMedia` 请求，表现为前端摄像头直接打不开。为此我们做了两处配置：

1. `android/app/src/main/AndroidManifest.xml` 声明权限：
   ```xml
   <uses-permission android:name="android.permission.CAMERA" />
   <uses-feature android:name="android.hardware.camera" android:required="false" />
   ```

2. `android/app/src/main/java/com/neckguardian/app/MainActivity.java` 覆写 `WebChromeClient.onPermissionRequest`，把 WebView 的媒体请求映射到系统运行时权限（CAMERA），用户授权后放行。

> 首次启动相机时，系统会弹「允许 NeckGuardian 使用摄像头？」——必须点允许。
> 若误点拒绝，去「设置 → 应用 → NeckGuardian → 权限」手动打开。

### 4.2 关键参数

| 项 | 值 | 位置 |
|----|----|------|
| 包名 | `com.neckguardian.app` | `capacitor.config.ts` / `android/app/build.gradle` |
| 应用名 | NeckGuardian | `android/app/src/main/res/values/strings.xml` |
| minSdk | 22（Android 5.1） | `android/variables.gradle` |
| targetSdk / compileSdk | 34（Android 14） | `android/variables.gradle` |
| Gradle | 8.2.1 | `android/gradle/wrapper/gradle-wrapper.properties` |
| JDK | 17 | `android/app/capacitor.build.gradle` |
| WebView 调试 | 开启 | `capacitor.config.ts` 的 `server.webContentsDebuggingEnabled` |

### 4.3 安卓包版本号

修改 `android/app/build.gradle`：

```gradle
defaultConfig {
    versionCode 1        // 整数，每次发版 +1（应用商店按此判断升级）
    versionName "1.3.1"  // 展示给用户的版本号
}
```

### 4.4 图标

启动图标由 `scripts/gen-android-icons.py` 从 `public/icon.png` 生成，覆盖各密度（mdpi ~ xxxhdpi）：

```bash
python scripts/gen-android-icons.py
```

自适应图标（Android 8+）：`mipmap-anydpi-v26/ic_launcher.xml` 用「浅绿背景 + 绿色卡通形象前景」组合。

### 4.5 MediaPipe 运行资源从哪来

手机端要在 WebView 里跑 MediaPipe，需要两类文件，合计约 27MB：

| 文件 | 用途 | 来源 | 是否入库 |
|------|------|------|----------|
| `vision_wasm_internal.{js,wasm}` | SIMD 版推理引擎 | `node_modules/@mediapipe/tasks-vision/wasm/` | ❌ 由 npm 提供，构建时复制 |
| `vision_wasm_nosimd_internal.{js,wasm}` | 非 SIMD 兜底（老机型） | 同上 | ❌ 同上 |
| `pose_landmarker_full.task` | 姿态模型（9.4MB） | `mediapipe-assets/models/` | ✅ 入库 |

**为什么不放进 `public/`**：Vite 会把 `publicDir` 的内容全量复制到 `dist/`，而桌面端 `electron-builder.yml` 的 `files` 包含 `dist/**/*`。放 `public/` 会导致：
- 桌面安装包凭空增重 ~27MB
- 用户磁盘上多出永远用不到的 wasm/模型

**实际流程**（`scripts/cap-build.js` 第 3 步）：

```
node_modules/@mediapipe/tasks-vision/wasm/*  ─┐
                                              ├─► dist/mediapipe/{wasm,models}/
mediapipe-assets/models/pose_landmarker_full.task ─┘
```

所以 `dist/mediapipe/` 由构建脚本按需生成，桌面构建完全不产生它。运行时 URL（`src/platform/localPoseEngine.ts`）以 `document.baseURI` 为基准，在 WebView 的 `https://localhost/` 下解析为 `https://localhost/mediapipe/...`，与文件落位一致。

**换模型**：把新的 `.task` 覆盖到 `mediapipe-assets/models/`，重新 `npm run cap:sync` 即可。

**升级 MediaPipe 版本**：`npm i @mediapipe/tasks-vision@x.y.z` 后重新 `cap:sync`，wasm 会自动跟着更新（无需手工同步，避免版本错配）。

---

## 五、运行期行为说明

| 场景 | 行为 |
|------|------|
| 打开 App | 进入「肩颈活动」页，自动请求相机权限并启动本地姿态检测 |
| 姿态推理 | 全部在手机本地完成（MediaPipe WASM/GPU），**视频帧不上传任何服务器** |
| 评分口径 | 与桌面端逐行一致（`HEAD_TILT=5.0` / `SHOULDER_DIFF=4.0` / `SPINE_ANGLE=10.0`，扣分率 0.7） |
| 数据存储 | IndexedDB，本地持久化，卸载即清除 |
| 提醒 | 前台定时提醒（默认 30 分钟），可在设置页调整；后台提醒受系统限制可能不准 |
| 语音播报 | 依赖 WebView 的 `speechSynthesis`；部分机型中文语音包缺失会静默失败 |
| AI 分析 | 设置页已隐藏入口，本期不支持 |

### 5.1 已知限制

- **后台运行**：安卓系统会冻结后台 WebView，锁屏/切后台后姿态检测与提醒会暂停。这是浏览器方案固有的限制，需要常驻后台得改用原生前台服务（后续迭代）。
- **性能**：中低端机型上 MediaPipe 可能只有 5~15 FPS。GPU delegate 初始化失败时会自动回退 CPU（见 `localPoseEngine.ts`）。
- **横竖屏**：主要按竖屏设计，布局已做响应式（底部 Tab 栏 + 单列卡片）。

---

## 六、常见问题

**Q1：`gradlew assembleDebug` 报 `JAVA_HOME is not set`**
→ 装 JDK 17 并设置 `JAVA_HOME`（方案 B）；或直接用 Android Studio（自带 JDK）。

**Q2：Gradle Sync 卡在下载**
→ 首次需下载 Gradle 8.2.1 + AGP 依赖，网络慢可配置国内镜像（修改 `android/build.gradle` 的 `repositories` 为阿里云 `https://maven.aliyun.com/repository/public`）。

**Q3：App 装上了但相机黑屏 / 打不开**
→ 检查运行时相机权限是否授予；确认 `MainActivity.java` 的 `onPermissionRequest` 覆写未被改动。

**Q4：提示「本地姿态模型加载失败」**
→ 说明 `dist/mediapipe/` 没被正确同步进 APK。重新执行 `npm run cap:sync`，并确认 `android/app/src/main/assets/public/mediapipe/models/pose_landmarker_full.task` 存在（约 9.4 MB）。

**Q5：改了前端代码，App 里没变化**
→ 必须重新 `npm run cap:sync` 再在 Android Studio 里 Rebuild，Capacitor 不会热更新。

**Q6：`cap sync` 报找不到 `dist/`**
→ 先跑 `npm run cap:web` 生成产物。

---

## 七、发布正式包 checklist

- [ ] `package.json` 版本号与 `android/app/build.gradle` 的 `versionName` 一致
- [ ] `versionCode` 已递增
- [ ] `npm run cap:sync` 成功（内含 `tsc` 类型检查，须无报错）
- [ ] `android/app/src/main/assets/public/mediapipe/models/pose_landmarker_full.task` 存在（约 9.4MB）
- [ ] `android/app/src/main/assets/public/mediapipe/wasm/` 下 4 个 wasm/js 文件齐全
- [ ] 用自有签名证书生成 `release` 包（`Build → Generate Signed Bundle / APK…`）
- [ ] 真机安装测试：相机、评分、提醒、设置四项主流程走一遍
