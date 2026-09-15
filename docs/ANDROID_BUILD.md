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

**工具链已装好，无需再装任何东西。** 为节省 C 盘空间，全部装在 **E 盘**：

| 组件 | 版本 | 路径 |
|------|------|------|
| JDK | Temurin 17.0.20.1 | `E:\AndroidDev\jdk\jdk-17.0.20.1+1` |
| Android SDK | cmdline-tools 12.0 + platform-tools + platforms;android-34 + build-tools;34.0.0 | `E:\AndroidDev\sdk` |
| Gradle | 8.2.1（免 wrapper 下载） | `E:\AndroidDev\gradle-8.2.1` |
| Gradle 缓存 | — | `E:\AndroidDev\gradle-home` |
| 下载的安装包 | — | `E:\AndroidDev\downloads`（可删，约 470MB） |

`android/local.properties` 已写好 `sdk.dir=E:/AndroidDev/sdk`（该文件不入库）。

于是**本机可以直接出 APK**，不必安装 Android Studio：

```bash
npm run cap:build          # debug 包（一键：前端构建 + sync + gradle）
```

详见 §3.3。

### 2.2 想自己装工具链 / 换台机器

**方案 A：Android Studio（图形化，最省事）**
1. 下载并安装 [Android Studio](https://developer.android.com/studio)
2. 首次启动时，安装向导会自动装好 **JDK 17**、**Android SDK**、**Gradle**
3. 在 SDK Manager 里确认已装 **Android SDK Platform 34**（compileSdk 34）

**方案 B：纯命令行（本机就是这套，装在 E 盘）**
```bash
# 1) JDK 17（Adoptium zip，免安装、免管理员权限）
curl -L -o jdk17.zip "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jdk/hotspot/normal/eclipse"
tar -xf jdk17.zip -C E:/AndroidDev/jdk

# 2) Android 命令行工具
curl -L -o cmdline-tools.zip "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip"
tar -xf cmdline-tools.zip -C E:/AndroidDev/sdk/cmdline-tools
# 注意：必须把解压出的 cmdline-tools/ 重命名为 latest/，sdkmanager 才认识
mv E:/AndroidDev/sdk/cmdline-tools/cmdline-tools E:/AndroidDev/sdk/cmdline-tools/latest

# 3) 接受许可 + 装组件（国内建议挂代理）
export JAVA_HOME="E:/AndroidDev/jdk/jdk-17.0.20.1+1"
SDKM="E:/AndroidDev/sdk/cmdline-tools/latest/bin/sdkmanager.bat"
printf 'y\ny\ny\ny\ny\ny\ny\ny\ny\ny\n' | "$SDKM" --sdk_root="E:/AndroidDev/sdk" \
  --proxy=http --proxy_host=127.0.0.1 --proxy_port=7897 --licenses
"$SDKM" --sdk_root="E:/AndroidDev/sdk" --proxy=http --proxy_host=127.0.0.1 --proxy_port=7897 \
  "platform-tools" "platforms;android-34" "build-tools;34.0.0"

# 4) Gradle 8.2.1（直接下载，绕开 wrapper 的代理问题）
curl -L -o gradle.zip "https://services.gradle.org/distributions/gradle-8.2.1-bin.zip"
tar -xf gradle.zip -C E:/AndroidDev
```

SDK 的三个包约 **420MB**，Gradle 约 **130MB**，JDK 约 **190MB**。

> 国内网络建议在 `E:\AndroidDev\gradle-home\gradle.properties` 里配代理，否则 AGP/AndroidX 依赖会拉不动：
> ```properties
> systemProp.http.proxyHost=127.0.0.1
> systemProp.http.proxyPort=7897
> systemProp.https.proxyHost=127.0.0.1
> systemProp.https.proxyPort=7897
> ```

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

### 3.2 命令行出包（推荐，本机已可用）

**一条命令搞定**：

```bash
npm run cap:build
# = node scripts/android-build.js
#   1) node scripts/cap-build.js   → 类型检查 + 前端构建 + 暂存 MediaPipe 资源
#   2) cap sync android            → 拷进 android/app/src/main/assets/public/
#   3) gradle assembleDebug        → 产出 APK
```

产物：`android/app/build/outputs/apk/debug/app-debug.apk`（当前约 **18.3 MB**）。

其它用法：

```bash
npm run cap:build -- --skip-web     # 只跑 gradle（前端没改动时最快，约 50 秒）
npm run cap:build:release           # 出 release 包（需先配好签名，见 §3.4）
```

`scripts/android-build.js` 会自动定位工具链：

| 环境变量 | 默认值 |
|----------|--------|
| `JAVA_HOME` | `E:\AndroidDev\jdk\<版本目录>` |
| `ANDROID_HOME` | `E:\AndroidDev\sdk` |
| `GRADLE_USER_HOME` | `E:\AndroidDev\gradle-home` |
| `NECKGUARDIAN_DEV_ROOT` | `E:/AndroidDev`（改它可整体搬家） |

若这些环境变量已由 Android Studio 配好，脚本会优先用它们，并自动改用工程自带的 `gradlew`。

> 首次构建约 **2 分钟**（要下载 AGP + AndroidX 依赖）；之后走缓存约 **50 秒**。

### 3.3 用 Android Studio 出包（图形化）

```bash
npm run android
# = npm run cap:sync && cap open android
```

这会自动同步前端产物，并用 Android Studio 打开 `android/` 工程。然后：

1. 等待 Gradle Sync 完成
2. **调试包**：菜单 `Build → Build Bundle(s) / APK(s) → Build APK(s)`
3. **正式包**：`Build → Generate Signed Bundle / APK…`，按向导创建/选择签名证书，选 `release`

### 3.4 release 包签名

发布给别人的包必须用**你自己的**密钥签名，且**此后每次升级都要用同一把密钥**，否则用户无法覆盖安装。

> ✅ **本机已完成配置**（2026-09-15）。密钥、口令、Gradle 挂接都已就位，直接跑 `npm run cap:build:release` 即可。

#### 现状

| 项 | 位置 / 值 |
|---|---|
| keystore | `E:/AndroidDev/keystore/neckguardian-release.jks`（PKCS12，RSA 2048，有效期 10000 天） |
| 别名 alias | `neckguardian` |
| 口令 | `E:/AndroidDev/keystore/STORE_PASSWORD.txt` |
| 证书主体 | `CN=NeckGuardian, OU=Mobile, O=NeckGuardian, L=Shenzhen, ST=Guangdong, C=CN` |
| Gradle 读取 | `android/keystore.properties`（已被 `android/.gitignore` 忽略） |

🔴 **keystore 与口令务必离线备份**（网盘 / U 盘 / 密码管理器）。丢了就**永远无法给已安装的用户推送更新**——
安卓只认签名一致的包，换密钥等于换了个 App，用户必须先卸载（数据全丢）才能装新版。

#### 从零重做（换机器时）

```bash
JAVA_HOME="E:/AndroidDev/jdk/jdk-17.0.20.1+1"

# 1) 生成密钥（只做一次）
"$JAVA_HOME/bin/keytool.exe" -genkeypair -v \
  -keystore E:/AndroidDev/keystore/neckguardian-release.jks \
  -alias neckguardian -keyalg RSA -keysize 2048 -validity 10000 \
  -storetype PKCS12 -storepass "<口令>" -keypass "<口令>" \
  -dname "CN=NeckGuardian, OU=Mobile, O=NeckGuardian, L=Shenzhen, ST=Guangdong, C=CN"

# 2) 登记到 android/keystore.properties（不要入库）
#    storeFile=E:/AndroidDev/keystore/neckguardian-release.jks
#    storePassword=<口令>
#    keyAlias=neckguardian
#    keyPassword=<口令>
```

3) `android/app/build.gradle` 已在文件顶部读取该 properties 并挂接：

```gradle
def keystorePropsFile = rootProject.file('keystore.properties')
def keystoreProps = new Properties()
if (keystorePropsFile.exists()) keystoreProps.load(new FileInputStream(keystorePropsFile))

android {
    signingConfigs { release { /* storeFile / storePassword / keyAlias / keyPassword */ } }
    buildTypes     { release { signingConfig signingConfigs.release } }
}
```

**设计要点**：`keystore.properties` 缺失时（如新克隆仓库的人）自动降级 ——
`release` 仍能构建出未签名包，`assembleDebug` 完全不受影响，不会因为缺密钥直接构建失败。

#### 出包与验签

```bash
npm run cap:build:release
# 产物：android/app/build/outputs/apk/release/app-release.apk

# 验签：确认不是 "Android Debug"，且 CN 是自己填的主体
"E:/AndroidDev/sdk/build-tools/34.0.0/apksigner.bat" verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk | head -6
```

> ⚠️ debug 包与 release 包**签名不同，不能互相覆盖安装**。手机上装了 debug 版的话，
> 装 release 版之前必须先卸载（应用内数据会清空）。

### 3.5 直接装到手机调试

手机开启「开发者选项 → USB 调试」，连上电脑：

```bash
ADB="E:/AndroidDev/sdk/platform-tools/adb.exe"
"$ADB" devices                          # 确认设备已识别
"$ADB" install -r android/app/build/outputs/apk/debug/app-debug.apk
```

或者把 APK 传到手机上，用文件管理器点击安装（需允许「安装未知来源应用」）。

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
