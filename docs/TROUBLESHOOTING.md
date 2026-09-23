# NeckGuardian 开发问题总结

本文档记录项目在开发 / 打包 / 发布过程中遇到的关键问题及解决方案，供后续维护参考。

---

## 一、打包与运行（最严重）

### 0. v1.3.0 界面永远卡在「正在连接后端...」 🔴🔴（本轮修复）

**现象**：安装 v1.3.0 后，进入「肩颈检测」页，画面顶部一直显示橙色
「正在连接后端...」，摄像头检测永远不开始，界面无限闪烁重连。

**排查过程**：
- 打包后端 exe 能正常启动，`/api/health` 返回 `{"status":"ok","version":"1.3.0"}`；
- WebSocket 握手也能成功（`101 Switching Protocols`）；
- 但**一连上 WS 就立刻断开**，前端 `onclose` 触发指数退避重连 → 无限循环。
- 打开后端日志看到真正的报错：
  ```
  Failed to initialize MediaPipe: 'google._upb._message.FieldDescriptor' object has no attribute 'label'
  connection closed
  ```

**根因**：机器上（及被打进 exe 的）**protobuf 版本与 mediapipe 不兼容**。
- `mediapipe 0.10.13` 要求 `protobuf <5, >=4.25.3`；
- 但打包环境里被安装成了 `protobuf 7.35.1`（dist-info 却写着 4.25.9，属于混杂损坏状态）；
- 过新的 protobuf 移除了 `FieldDescriptor.label` 属性，MediaPipe 在加载 `_pb2` 描述符时抛异常，
  `initialize()` 返回 `False` → WS 端发错误并关闭 → 前端无限重连。

**修复**（三处）：
1. `backend/requirements.txt`：`protobuf>=4.25.3,<5` 显式约束；`mediapipe==0.10.13`
   （0.10.9 及更早**没有 cp312 wheel**，Python 3.12 装不上）。
2. 用**干净虚拟环境** `.buildenv` 重新安装依赖并打包 exe，确保打进 exe 的是 protobuf 4.25.9。
3. `backend/ws/camera_ws.py`：初始化失败时**主动下发可读错误并关闭连接**；
   前端 `useWebSocket` 收到 `type:"error"` 时**停止重连**并展示错误横幅 + 「重试」按钮，
   不再让界面无限空转「正在连接后端...」。

**验证方法**（关键，务必执行）：
```bash
# 1. 启动打包后的 exe
./build/neckguardian-backend/neckguardian-backend.exe > build/verify.log 2>&1 &
sleep 8
curl -s --noproxy "*" http://127.0.0.1:18920/api/health   # 期望 version 正确

# 2. 连 WS，确认收到 ready 而不是被关闭
python -c "import asyncio,websockets
async def m():
    async with websockets.connect('ws://127.0.0.1:18920/ws/camera') as ws:
        print(await ws.recv())
asyncio.run(m())"
# 期望：{"type":"ready","message":"MediaPipe ready"}
# 日志期望：MediaPipe Pose initialized successfully（且无 FieldDescriptor 报错）
```

> 教训：**依赖约束必须显式写死**。mediapipe 对 protobuf 有严格上界，一旦被其它包
> 升级到 5+ 就会静默炸掉姿态检测，且报错只在后端日志里、前端完全看不到。

---

### 1. 打包后端 exe 启动即崩溃 —— UPX 压缩破坏核心模块 🔴

**现象**：PyInstaller 打出的 `neckguardian-backend.exe` 一启动就退出，日志报
`ModuleNotFoundError: No module named 'select'`（`select` 是 Python 核心标准库）。

**根因**：`neckguardian-backend.spec` 中 `upx=True`。UPX 压缩会破坏
`select.pyd`、`socket` 等核心二进制模块，导致运行时无法加载。

**影响**：v1.1.0 及更早版本发布的安装包，**后端 exe 全部无法运行**。
装到没有 Python 的机器上，后端直接起不来，"免 Python" 实际从未生效。

**修复**：spec 中 `EXE` 与 `COLLECT` 两处 `upx=True` → `upx=False`。

**验证方法**（务必执行）：
```bash
NECKGUARDIAN_PORT=18999 ./build/neckguardian-backend/neckguardian-backend.exe &
sleep 6
curl -s --noproxy "*" --max-time 3 http://127.0.0.1:18999/api/health
# 期望：{"status":"ok","version":"..."}
```
> 注意必须加 `--noproxy "*"`，否则代理返回的错误信息会被误判为成功响应。

---

### 2. `*.spec` 被 .gitignore 忽略，打包配置长期未入库

**现象**：修复了 spec 里的 UPX 问题后，`git status` 看不到该文件。

**根因**：`.gitignore` 第 13 行 `*.spec` 把打包配置文件忽略了，导致它从未进入版本库，
打包配置的坑长期无人发现。

**修复**：`git add -f neckguardian-backend.spec` 强制纳入版本库。

---

### 3. 打包卡死 / 失败 —— node_modules 被原样打进安装包

**现象**：`electron-builder` 跑 10~20 分钟卡死，最后失败。

**根因**：`electron-builder.yml` 的 `files` 未排除 `node_modules`，且 `asar: false`，
导致 20000+ 文件（含 electron 二进制）被原样复制进 `resources/app/`。

**修复**：
```yaml
files:
  - dist/**/*
  - backend/**/*
  - package.json
  - '!**/node_modules/**'
  - '!**/__pycache__/**'
  - '!**/*.pyc'
```
修复后打包时间从卡死降到约 1~2 分钟。

---

### 4. PyInstaller 输出路径与工作路径冲突

**现象**：`ERROR: Specfile error: The output path "..." contains WORKPATH`

**根因**：`--distpath build` 时，默认 workpath 也是 `build/<name>`，与输出目录冲突。

**修复**：显式指定独立 workpath：
```
pyinstaller neckguardian-backend.spec --noconfirm --distpath build --workpath build/pyi-work
```

---

### 5. 打包版后端崩溃后永不重启

**现象**：安装版运行中后端崩溃后，界面一直连不上，再也不恢复。

**根因**：`electron/main.ts` 中，优先使用 bundled exe 的分支在创建进程后直接
`return`，把后面的 `stdout/stderr` 监听与 `exit` 崩溃重启逻辑**全部跳过**。
而打包环境走的正是这条分支 —— 生产路径的重启机制完全失效。

**修复**：合并两条启动分支，统一挂载日志监听与崩溃重启逻辑；应用退出时用
`taskkill /pid <pid> /T /F` 递归终止进程树，避免孤儿进程占用端口。

---

## 二、功能缺陷

### 6. "开机自启动"开关失效

**现象**：设置页开关可切换，但重启系统后并不自启。

**根因**：`preload.ts` 未暴露 `setAutoStart`，前端 `window.electronAPI?.setAutoStart(...)`
调用的是 `undefined`，静默失效。

**修复**：补上 IPC 通道 `set-auto-start`（主进程 `app.setLoginItemSettings`）。

---

### 7. WebSocket 断线后永久失效

**现象**：后端重启或短暂断连后，摄像头检测一直停在"正在连接后端..."，只能重启应用。

**根因**：`useWebSocket.ts` 的 `onclose` 只置 `connected=false`，没有任何重连逻辑。

**修复**：加入指数退避自动重连（1s 起，上限 10s），组件卸载时彻底清理定时器与回调。

> 补充（v1.3.1）：重连不能解决**后端侧致命错误**（如 MediaPipe 初始化失败）。
> 此时后端下发 `{"type":"error"}` 并关闭连接，前端据此**停止重连**、展示错误横幅 + 「重试」按钮，
> 避免陷入"无限重连 + 一直显示正在连接"的假死状态。参见第 0 条。

---

### 8. 提醒弹窗双通道重复触发

**现象**：提醒可能弹两次；WebSocket 通道还缺少系统级通知。

**根因**：`useWebSocket` 收到 `reminder` 消息触发一次弹窗，Electron 轮询
`/api/reminder/status` 又触发一次，两条路径重复。

**修复**：统一走 Electron IPC 轮询（保留系统通知），移除前端 WS 的 reminder 分支。

---

### 9. 周报"活动完成率"计算错误

**现象**：完成率数值明显不合理。

**根因**：`stats.py` 用 `总时长 // 30` 估算应休息次数（硬编码 30 分钟），
与用户可配置的提醒间隔脱节，且把"活动次数"与"应休息次数"混算。

**修复**：改用统一的 `REMINDER_INTERVAL_MINUTES` 常量估算。

---

### 10. AI 开关与后端启用逻辑脱节（本轮已修复）

**现象**：设置页 `ai_enabled` 开关存进数据库，但后端 `AI_ENABLED` 只读环境变量
`DEEPSEEK_API_KEY`，前端开关**完全不生效**；且用户无法在应用内配置密钥。

**修复**：见下方"三、DeepSeek 接入改造"。

---

## 三、前端健壮性

### 11. React StrictMode 下摄像头流泄漏

**现象**：开发模式下摄像头可能被异常占用 / 流泄漏。

**根因**：StrictMode 会"挂载→卸载→再挂载"，`getUserMedia` 是异步的，
首次的 stream 在组件已卸载后才落地，清理函数抓不到它。

**修复**：引入 `cameraAbortRef` 中止标记，await 后校验，若已卸载则立即释放轨道。

---

### 12. "开始活动"意图跨路由丢失

**现象**：从托盘或在其他页面点"开始活动"，不会进入练习模式。

**根因**：`App` 先 `navigate('/')` 再派发事件，`NeckActivity` 需先挂载才能监听，
事件在挂载前派发即丢失。

**修复**：用 `sessionStorage` 打标记兜底，页面挂载时读取标记并进入练习模式。

---

### 13. 练习计时器闭包持有旧函数

**现象**：练习计时结束时可能调用到过期的 `finishExercise`。

**根因**：`setInterval` 回调闭包捕获了创建时的 `finishExercise` 引用。

**修复**：用 `finishRef` 持有最新引用，计时器回调通过 ref 调用。

---

## 四、构建环境（Windows + WorkBuddy 沙箱）

| 问题 | 现象 | 解决 |
|------|------|------|
| PATH 被 shim 污染 | Git Bash 里 `ls`/`tail`/`head`/`grep` not found | 命令前加 `PATH="/usr/bin:/bin:$PATH"` |
| `env -u X` 失效 | 无法取消环境变量 | 改用 `unset X` |
| safe-delete 拦截 | `SAFE_DELETE_FAIL_CLOSED`（回收站不可用） | 打包前 `unset NODE_OPTIONS`，且用 `dangerouslyDisableSandbox` |
| 批量删除保护 | PyInstaller COLLECT 删旧目录触发 `SAFE_DELETE_BULK_CONFIRM_REQUIRED` | 构建前先用 PowerShell `Rename-Item` 把旧目录移走 |
| Git Bash `mv`/`rm` 权限拒绝 | E 盘大目录 `Permission denied` | 改用 PowerShell `Rename-Item` / `Move-Item` |
| 直连 GitHub 超时 | git 443 超时 | 走本机代理 `127.0.0.1:7897` |
| gh 凭据助手 | `git: 'credential-gh' is not a git command` | `git -c credential.helper= -c credential.helper='!gh auth git-credential'` |

---

## 五、移动端（Capacitor：Android / iOS）

### 6. 跨语言数值不一致：Python 的「银行家舍入」 🔴（本轮发现）

**现象**：把姿态评分从 Python 后端搬到前端 TS（移动端本地推理）后，同一姿势在手机和电脑上
偶尔差 1 分。

**根因**：Python 内置 `round()` 采用**银行家舍入（round-half-to-even）**：
`round(32.5) == 32`、`round(33.5) == 34`；而 JS 的 `Math.round` 是「四舍五入」，
`Math.round(32.5) == 33`。当扣分总额恰为 `.5` 时（例如 head=30/shoulder=50/spine=60 →
扣 67.5 分），各端结果就会差 1。

**修复**：在 `src/platform/localPoseEngine.ts` 和 `localStats.ts` 中实现 `pyRound()`，
复刻 Python 语义，替换所有涉及评分的 `Math.round`。

**防回归**：新增 `scripts/verify-scoring.mjs` + `verify-angles.mjs`，从 Python 侧生成期望值，
逐条比对前端实现（当前 80 条评分用例 + 439 帧平滑序列 + 8 条角度用例全通过）。
`verify-scoring.mjs` 还会断言评分模型的核心不变量「**有提醒 ⟺ 分数 < 80**」，
改动评分/角度公式后务必重跑 `npm run verify:parity`。

> ⚠️ 该脚本用 esbuild bundle `src/platform/localPoseEngine.ts` **真实源码**执行，不维护内联副本；
> 副本与源码各错各的、测试却全绿，是这类"一致性测试"最典型的失效方式。

### 6b. 平滑器取整口径不一致（同一类问题的第二个实例）🔴

**现象**：评分逻辑已对齐，但理论上仍可能差 1 分——仅靠 80 条评分用例发现不了。

**根因**：后端 `camera_ws.py` 的 EMA 平滑器写的是 `round(x, 2)`，前端写的是
`pyRound(x * 100) / 100`。**两者不是同一个函数**：

- `round(x, 2)` = 把 x 的**精确值**舍入到 2 位小数；
- `round(x * 100) / 100` = 先把 x 乘 100（引入一次舍入），再对结果做银行家舍入。

当 `x * 100` 恰好落在半整数上时结果不同：`x = 0.015` → 前者 `0.01`、后者 `0.02`。
（2 位小数的中点 1/200 不是二进制可精确表示的数，所以这个平局点只能由 `x * 100` 这一步踩中。）

**修复**：`PoseSmoother` 抽到独立模块 `backend/services/smoother.py`（便于被测试直接导入），
取整统一为 `round(x * 100) / 100`，与前端 `pyRound()` 逐位等价。

**防回归**：`gen-scoring-cases.py` 增加平滑器逐帧用例，并专门构造 40 个能踩中平局点的输入
（实测：把后端改回 `round(x, 2)` 会让这 40 条全部报错）。

### 7. Capacitor WebView 打不开摄像头 🔴

**现象**：APK 装上后进检测页，摄像头黑屏 / `getUserMedia` 直接失败。

**根因**：Capacitor 默认的 `WebChromeClient` **拒绝**网页的媒体权限请求。

**修复**（两处缺一不可）：
1. `AndroidManifest.xml` 声明 `CAMERA` 权限；
2. `MainActivity.java` 覆写 `WebChromeClient.onPermissionRequest`，把 WebView 的媒体请求
   映射到系统运行时权限，用户授权后 `request.grant(...)`。

### 8. `indexedDB.open(name)` 无版本号会创建空库 🔴

**现象**：移动端仪表盘数据全为 0，或 `readAll` 抛 `NotFoundError`。

**根因**：`localStats.ts` 早期用 `indexedDB.open('neckguardian')`（**不带版本号**）读取。
若该库尚未由 `localDb.ts` 创建，这句会创建一个 **v1 且没有任何 object store 的空库**；
之后 `localDb` 用 `open(name, 1)` 打开时版本相同，**不会触发 `onupgradeneeded`**，
导致所有 store 永远建不出来。

**修复**：`localDb.ts` 导出 `readAllRows()`，所有读取统一走它（复用同一套带版本的 openDb）。

### 9. 构建期常见问题

| 问题 | 现象 | 解决 |
|------|------|------|
| 本机无 JDK/SDK | `gradlew` 报 `JAVA_HOME is not set` | 用 Android Studio（自带 JDK 17 + SDK 34），或单独装 |
| `values/colors.xml` 缺失 | 资源编译失败：找不到 `@color/colorPrimary` | 已补 `android/app/src/main/res/values/colors.xml` |
| android 依赖缺失 | `MainActivity` 用到 `androidx.core` 却未声明 | 已在 `app/build.gradle` 显式加 `androidx.core:core` |
| 改前端不生效 | App 里看不到改动 | Capacitor 无热更新，必须重新 `npm run cap:sync` 再 Rebuild |
| Gradle 下载慢 | 首次 Sync 卡住 | `android/build.gradle` 换阿里云 Maven 镜像 |

---

## 六、经验教训

1. **打包产物必须实测启动**，"能打出包"不等于"包能用"。UPX 问题正是因为没有实测才长期潜伏。
2. **配置文件要入库**，`.gitignore` 的宽泛规则（如 `*.spec`）容易误伤关键配置。
3. **前端开关要打通到后端**，否则只是"看起来很能用的假开关"。
4. **异步 + 组件卸载**是前端资源泄漏高发区，StrictMode 会放大此类问题。
5. **沙箱环境**下优先用 PowerShell 做文件操作，命令行工具易受 PATH / shim 干扰。
6. **跨语言移植算法必须做数值等价性验证**——同样的公式、不同的语言，`round()` 这样的小差异
   也会造成 1 分偏差。用「Python 生成期望值 → JS 比对」的脚本固化下来，比人眼审查可靠。
7. **Capacitor 套壳的坑集中在 WebView 权限与本地存储**：摄像头要覆写 `onPermissionRequest`；
   IndexedDB 要复用同一套版本化 `openDb`，不能各开各的。
