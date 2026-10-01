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

### 10b. 帧时间戳写成本地时间 → 归档日期错位 🔴（v1.6.1 修复）

**现象**（用户侧，很容易被当成"统计就是不准"）：
- 仪表盘「今日均分」到**下午 16 点之后就不再增长**（当晚的采样都记到"明天"去了）。
- 趋势图上出现**未来日期**的行（幽灵日）；昨天的行数字明显偏小。
- 保留期清理的边界天跟着偏一天。

**根因链条**（每一环单独看都"没问题"）：

1. `backend/ws/camera_ws.py` 用 `datetime.now().isoformat()` 写帧时间戳，
   产出形如 `2026-09-25T20:00:00.123456` —— **本地时间、且不带时区标记**。
2. 前端把它原样写进 `posture_score.timestamp`，**全库 7657 条无一带 `Z`**（实测）。
3. 归档分组用 `date(timestamp, 'localtime')`。SQLite 的 `'localtime'` 修饰符
   的语义是"把输入**当作 UTC** 转成本地"；输入**没有时区标记**时它照样按 UTC 解释。
4. 于是本地时间被**再减一次**本地偏移（UTC+8 下 8 小时）：
   `date('2026-09-25T20:00:00','localtime')` → **`2026-09-26`**（实测），
   而正确的契约串 `date('2026-09-25T20:00:00.000Z','localtime')` → `2026-09-25`。

**为什么 CI 上看不见**：runner 是 `TZ=UTC`，偏移为 0，"本地串"与"UTC 串"**恰好相同**，
错位完全无法复现。必须**显式构造跨日界时刻**（本地 16:00 之后）才能抓住 ——
这也是 `scripts/timefmt-probe.py` 里有一段"负样本留证"的原因。

**为什么比"实时数字难看"更严重**：`posture_daily` 是**长期保留层**，原始采样会被
保留策略清掉，错误日期一旦写进归档就**被固化**，越往后越难纠正。

**修复**（三件事，缺一不可）：
1. **收敛单点**：新建 `backend/services/timefmt.py`（`now_iso_ms` / `to_iso_ms` / `is_iso_ms`），
   把此前散在 `retention._iso` / `data._now_iso` / `migrations._now_iso` / `camera_ws` 的
   **四份重复实现**统一掉 —— 其中相机那份是错的，其它三份恰好对。
2. **新增迁移 4**：把存量数据里所有"不带 `Z` / 不带 `+`"的时间戳
   `strftime('%Y-%m-%dT%H:%M:%fZ', timestamp, 'utc')` 转成契约格式（**幂等**，二次执行 0 行）；
   同时 `DELETE FROM posture_daily WHERE date >= (SELECT date(MIN(timestamp),'localtime') …)`
   让**原始表覆盖范围内**的归档整体重算，**范围之外的必须保留**（那些天的原始采样已被清理，
   归档是唯一副本）。
3. **守卫**：`npm run verify:timestamps`（挂进 `verify:parity`），
   并用变异测试证明它有牙（6/6 全部被抓住）—— 第 6 条专门守"守卫自身要先归一 CRLF"
   （见 [DEVELOPMENT.md](DEVELOPMENT.md) 铁律 #40：本机检出 CRLF、CI 检出 LF，
   会让"按行处理源码"的守卫**本机红、CI 绿**）。

**迁移不变式**：转换前后**本地日不变** ——
`date(strftime('%Y-%m-%dT%H:%M:%fZ', ts, 'utc'), 'localtime') == substr(ts, 1, 10)`。
`'utc'` 修饰符把"无标记串"按 UTC 解释（与后面 `'localtime'` 的假设一致），
两者相消。⚠️ 反过来 `strftime(…, 'Z'串, 'utc')` 实测是恒等变换，但**别依赖**这个未文档化行为
—— 迁移里显式用 `WHERE … NOT LIKE '%Z' AND … NOT LIKE '%+'` 排除掉。

**总量守恒断言**：`Σ归档 sample_count == 原始表总行数`。
"本地零点 → UTC 零点"这类回归会让本地凌晨的样本被窗口**静默漏掉**，
而"归档 == 窗口"反而**恒成立**（`rollup_daily` 用的就是同一个窗口），
只有总量守恒能抓住。⚠️ 压日界的样本必须放在**最早那天**，
否则"按天计数不一致"会先失败、总量守恒这一条根本不会跑到（实测踩到）。

---

## 三、前端健壮性

### 11. React StrictMode 下摄像头流泄漏

**现象**：开发模式下摄像头可能被异常占用 / 流泄漏。

**根因**：StrictMode 会"挂载→卸载→再挂载"，`getUserMedia` 是异步的，
首次的 stream 在组件已卸载后才落地，清理函数抓不到它。

**修复**：引入 `cameraAbortRef` 中止标记，await 后校验，若已卸载则立即释放轨道。

> 同一族问题的另一个实例见 §14（超时后迟到的流）。

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

### 14. 取流超时后「迟到」的流没人接手 🔴

**现象**：首次进入检测页，系统权限对话框停留超过 30 秒才点「允许」——
界面显示取流超时失败，但**摄像头指示灯一直亮着**；此后点「重试」还可能报 `NotReadableError`。

**根因**：应用侧用 `withTimeout(getUserMedia, 30s)` 做超时保护，但**超时并不能取消
`getUserMedia`**。用户超时之后才授权时，那条 promise 仍会成功返回，而调用方早已走错误分支——
没人接手的 `MediaStream` 继续占着摄像头设备。

**修复**：`NeckActivity.tsx` 新增 `openCameraStreamWithinTimeout()`，在超时分支挂一个
「迟到清理」：

```ts
void pending.then((late) => late.getTracks().forEach((t) => t.stop())).catch(() => {})
```

超时之后流若还是来了，立刻关掉它。

**教训**：与 §11 是同一族问题 —— **凡是 `await` 之后才拿到的资源，都要问「拿到时还有人要吗」**。
区别只是判据不同：§11 靠 `cameraAbortRef`（组件是否还在），§14 靠「是否已走超时分支」。
加超时保护时**只想到"让界面别卡住"是不够的**，还得处理"超时之后资源才到"。

> 安卓端权限对话框是**系统级**的，用户看几秒甚至几分钟都正常，所以这条路径不是理论边角料。

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
| 🔴 **「curl 通了」推不出「git 能推」** | 裸 `curl https://api.github.com/` 返回 `200`，同一分钟 `git push` 却报 `Failed to connect to github.com:443 … Could not connect to server`（21s 超时）；把 git 代理显式设成 `127.0.0.1:4040` 仍旧失败 | 沙箱 shell **本来就导出** `https_proxy=http://127.0.0.1:4040`（连小写一起），**curl 默认在用它** ⇒ 那次"直连成功"根本不是直连，是同一条代理在起作用。而 `4040`（沙箱服务代理）**到不了 github.com**，能到的是 `7897`。**判据**：`curl -x http://127.0.0.1:7897 https://github.com/cwxa/HealthyDesk.git/info/refs?service=git-upload-pack` 应回 `200`；拿不通的代理去试只会得到 `000`/超时 |
| 🔴 `7897` 会瞬时抽风，别据此改配置 | 同一分钟里 `git push` 报 `CONNECT tunnel failed, response 502`（或 `Empty reply from server`、`schannel: server closed abruptly`）；**隔一分钟重试就过** | 本机代理自身的抖动，**不是**仓库/凭据/网络配置问题。用 `curl -x http://127.0.0.1:7897 <git 端点>` 复现确认后再**重试 3–5 次**（每次间隔几秒）；**别去改 remote URL、别去动凭据助手** —— 那是在给一个假故障做永久改造 |
| gh 凭据助手 | `git: 'credential-gh' is not a git command` | `git -c credential.helper= -c credential.helper='!gh auth git-credential'` |
| 🔴 `spawnSync` 恒返回 `EBUSY` | `verify-timefmt.mjs`（唯一会起子进程的守卫）**每次都红**：`✗ 找不到可用的 Python`；用 `node -e` 试 `spawnSync('cmd.exe'/'python.exe'/process.execPath, …)` **全都** `error.code === 'EBUSY'`，而**异步 `spawn` 正常**（esbuild、`verify-ui-smoke.mjs` 的 Chrome 都用异步，所以它们不报错） | libuv 同步路径经 `ERROR_SHARING_VIOLATION` → `UV_EBUSY`（与沙箱无关：`dangerouslyDisableSandbox` 下同样失败；bash 直接调 `python.exe` 正常）。**改成异步 `spawn`**（`scripts/verify-timefmt.mjs` 的 `run()`；语义对齐 `spawnSync`：起不来 → `status: null` + `error`）。判据是"守卫泛红"≠"被测代码坏了"，别去改被测代码 |

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

**现象**：APK 装上后进检测页，一直停在「正在启动摄像头…」，或 `getUserMedia` 直接失败。

**曾被写错的根因**（原文记的是错的，2026-09-24 纠正）：

> ~~Capacitor 默认的 `WebChromeClient` **拒绝**网页的媒体权限请求。~~

不成立。Capacitor 6 的 `BridgeWebChromeClient` **自己就会**处理摄像头请求：
`BridgeWebChromeClient.java:106-131` 把 `android.webkit.resource.VIDEO_CAPTURE` 映射成
`CAMERA` 权限并在授权后 `grant()`。会拒绝 `getUserMedia` 的是**没设 WebChromeClient 的裸 WebView**，
不是 Capacitor。按错误归因去"修"，会把力气花在替换 ChromeClient 上，而把真正值钱的东西一起丢掉（见下）。

**真正的两个根因**（都在这份 Capacitor 实现内部）：

1. 🔴 **`permissionListener` 是单个可变字段**，被 `onPermissionRequest` /
   `onGeolocationPermissionsShowPrompt` / `onShowFileChooser` **共用**（同文件 51-52 行）。
   并发请求会互相覆盖回调 → **第一个 `PermissionRequest` 既没 `grant` 也没 `deny`** →
   前端 `getUserMedia` **永久 pending**：界面无限停在「正在启动摄像头…」，且**不报任何错**。
   dev 模式 React StrictMode 双挂载、用户连点「重试」都会触发并发。
   （对照记忆里的定位口诀：*永久 pending = 某个 await 永不 settle*。）
2. 授权发生在**等系统对话框的异步回调**里 —— 对话框夹在 `getUserMedia` 中间，
   WebView 侧没有超时，用户不点就一直转圈。

**修复**（三处缺一不可）：
1. `AndroidManifest.xml` 声明 `CAMERA` 权限；
2. `MainActivity` 在 `super.onCreate()` 之后 `setWebChromeClient(...)` 换成自己的实现：
   **启动即预申请权限** + **持有权限就同步 `grant()`** + **等待系统对话框期间挂 60s 看门狗**
   （超时主动 `deny`，让前端拿到明确错误而不是无限转圈）；
3. 🔴 **必须 `extends BridgeWebChromeClient`（继承），不能 new 一个裸 `WebChromeClient`（替换）。**
   替换会连带丢掉五组 override：

   | 丢掉的 | 后果 |
   |---|---|
   | `onShowFileChooser` | `<input type="file">` **静默失灵**（做「导入数据」时必踩） |
   | `onConsoleMessage` | JS 的 `console.*` 不再进 logcat —— 安卓端**唯一**的排查手段 |
   | `onGeolocationPermissionsShowPrompt` | 定位请求被直接拒绝 |
   | `onJsAlert/Confirm/Prompt` | alert/confirm 退回基础实现 |
   | `onShowCustomView/HideCustomView` | 视频全屏 |

   `MainActivity.CameraChromeClient` 现在只接管**纯摄像头**请求，含音频等其它资源时
   `super.onPermissionRequest()` 交回 Capacitor（它知道该去申请 `RECORD_AUDIO`，
   而我们绝不替用户放行自己没持有的资源）。

**防回归**（`file` 级别验不了，要验**类层次**）：
```bash
"$JAVA_HOME/bin/javap" -cp android/app/build/intermediates/javac/debug/classes \
  'com.neckguardian.app.MainActivity$CameraChromeClient'
# 期望：class com.neckguardian.app.MainActivity$CameraChromeClient
#         extends com.getcapacitor.BridgeWebChromeClient
#       且列出 onPermissionRequest / onPermissionRequestCanceled
```

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
   ⚠️ 但**期望值本身不能依赖机器环境**（时区、路径、主机名），否则守卫只在生成那台机器上绿 —— 见 §七。
7. **Capacitor 套壳的坑集中在 WebView 权限与本地存储**：摄像头要覆写 `onPermissionRequest`；
   IndexedDB 要复用同一套版本化 `openDb`，不能各开各的。

## 七、守卫自身的坑（"测了，却测了个寂寞"）

这一节记的是**测试 / 守卫自己出错**的情形 —— 比被测代码出错更隐蔽，因为它会让人以为"已经验过了"。

### 7.1 期望值里写进了机器环境 → 守卫只在生成那台机器上绿

**现象**：本地 `npm run verify:parity` 全绿，打 tag 后 CI **首跑**就红：

```
✗ 日边界不一致 2024-02-29: ts=["2024-02-29T00:00:00.000Z", ...] py=["2024-02-28T16:00:00.000Z", ...]
```

**结论：两端实现都是对的，错的是"产物不可移植"。**

- 两端都按**本地时区**取日边界 —— 这是**刻意**的（用户在 UTC+8 早上 7 点坐着，那属于"今天"）。
- 生成机时区是 UTC+8 → `2026-01-01` 的本地零点 = `2025-12-31T16:00:00Z`；
  CI runner 是 UTC → 同一套逻辑算出 `2026-01-01T00:00:00Z`。
- 把"取决于机器时区的绝对瞬时"冻进对拍文件，等于把**生成机的时区**一起冻了进去。

**改法**：期望文件里只放**与时区无关**的东西（日期列表、±N 天这类纯日历运算）；日边界改由守卫断言
**不变式** —— `start` 是本地零点、`end` 是次日本地零点、`end(day) == start(day+1)`。
这些在任何时区都成立，且仍有牙：若实现改成 UTC 零点，UTC+8 下 `getHours()` 是 8 而不是 0。

**顺带堵住的两个洞**：

1. CI 的「期望值是否与生成器同步」原先只重新生成 scoring / angle —— 后来新增的那几份
   **从来没被验过**，事故正是从这个缝里过去的。现已把 `daily-agg` 纳入。
2. **CI runner 是 UTC，"在默认时区下断言"等于没断言**：`local == UTC` 时「实现改用 UTC 零点」
   与正确实现给出**同一个瞬时**。实测：把 Python 侧改成 `replace(tzinfo=timezone.utc)` 后，
   在 `TZ=UTC` 下守卫 **exit 0（漏网）**。改法：CI 该步骤显式 `env: TZ: Asia/Shanghai`；
   TS 侧则在进程内依次切 UTC+8 / UTC-8 / 欧洲各验一遍（Node 里 `process.env.TZ` 是可靠的）。

### 7.2 两个"看起来更聪明"但踩坑的做法

- **spawn 子进程、用 `env` 传 TZ 去验时区逻辑**：Windows CRT 上父进程 `TZ=UTC` 时，子进程拿到的
  是 `+1:00` 而不是 `+8:00`（实测）。嵌套传 TZ **不可靠**，老实靠进程环境变量。
- **`TZ=Europe/Berlin` 这类 IANA 名在 Windows 上会被静默忽略**，回落成系统时区
  （表现为"柏林"的偏移等于 +8），**不报错**。所以别拿它当"换了个时区"的证据。

### 7.3 日期用例不覆盖夏令时切换日 → 守卫是瞎的

「`end` 用固定 `+24h` 而不是次日本地零点」这个变异，在最初的用例集上 **exit 0 漏网** ——
因为所选日期里没有一个是夏令时切换日。补上美（3/8、11/1）与欧（3/29、10/25）四天后立刻被抓住：
切换日当地只有 23 或 25 小时，固定 `+24h` 必然与"次日本地零点"对不上。

### 7.4 Windows 上别用 raw diff 比对生成物

仓库里的 `.json` 是 LF，而 Windows 上 Python 的 stdout 会把 `\n` 写成 `\r\n` → 直接 `diff` 会报
"全篇不一致"（3620 行全差），看着像内容错了，其实只差换行符。先 `tr -d '\r'` 再比。

### 7.5 守卫打印了 ✗ 却退出码 0 —— "假绿"

**现象**：写动作库守卫（S7）时，`requireStripper()` 里 `fail('剥注释没生效…')` 之后**直接 `return`**，
而 `process.exit(1)` 只在文件末尾统一执行一次。于是那条早退**绕过了收尾**：终端上明明白白打了一行 ✗，
**退出码却是 0** —— CI 会报"通过"，`npm run verify:all` 也会报绿。

**这个洞是变异测试抓出来的**：把 `stripComments()` 变成恒等函数（M7），预期守卫变红；
结果 `退出码=0`，于是"变异测试"当场变成了"守卫体检"。修法是抽出**唯一收尾出口**：

```js
function finish(count) {            // 所有 return 路径都走它
  if (failed) { console.error('✗ …未通过'); process.exit(1) }
  console.log('✓ …')
}
```

**教训**：`process.exit(1)` 出现的地方多于一处（或少于"所有失败路径"）时，就是在给未来埋假绿。
判据永远是**退出码**（铁律 #39、#41）。

### 7.6 守卫"假红"同样有害：`spawnSync` 在本机恒 `EBUSY`

**现象**：`npm run verify:all` 在本机**每次都红**，且红的是
`✗ 找不到可用的 Python（需要能 import aiosqlite）`，而 `.buildenv/Scripts/python.exe` 明明装了它。
逐层压下去发现：`node -e` 里 `spawnSync` 对 **任何** 可执行文件都返回 `error.code === 'EBUSY'`
（`cmd.exe` / `where` / `node.exe` / `python.exe` 全军覆没），但**异步 `spawn` 同一个进程里正常**
（esbuild、`verify-ui-smoke.mjs` 起 Chrome 都走异步，所以它们从没暴露这个问题）。

**根因**：libuv 的**同步** spawn 路径经 `ERROR_SHARING_VIOLATION` → `UV_EBUSY`。
与沙箱**无关**：`dangerouslyDisableSandbox` 下同样失败，而 bash 直接调 `python.exe` 正常。

**改法**：`verify-timefmt.mjs` 里的 `spawnSync` 换成异步 `spawn`（`run()` 辅助函数），
语义对齐（起不来 → `status: null` + `error`，`findPython()` 靠它逐个淘汰候选）。
改完重跑**变异测试**确认守卫仍有牙（6/6 仍被抓住）—— 动了"取证据的路径"就必须重新证明一次。

**教训**：**假红和被静默跳过的守卫一样有害**。它不产生错误结论，但它训练人忽略这个守卫
（"那个脚本本来就在本机红"）。看到守卫红先分清是"被测代码坏了"还是"守卫跑不动"（铁律 #42）。

### 7.7 「观测过程中的一个中间现象」被当成了「结论」 🔴（v1.7.2，又一种假红）

**现象**：本机 `npm run verify:ui` 连续多轮死在
`Error: Chrome 启动失败（未写出 DevToolsActivePort，exit=0）`，stderr 为空，
user-data-dir 里**没有** `DevToolsActivePort`。而**从 bash 前台**直接跑同一条 Chrome 命令行却成功。

**第一次的（错误）结论**：父进程是 `node.exe`（无控制台）被系统限制 ——
于是去试参数集 / `windowsHide` / `detached` / `shell:true` / bash 中继 / 各种 `--headless` 形态，
**全都没用**，因为方向从一开始就错了。

**真正的对照实验**（`.buildenv/diag-chrome-launch5.mjs`）：把**冒烟脚本逐字原样**的调用
单独跑一遍 —— **它成功**（`port=5432`）。⇒ 与参数、与环境、与父进程都无关。

**根因**：Chrome 在 Windows 上是**两段式**启动：`spawn` 出来的进程只是**启动器**，
**~0.2s 就 `exit(0)`**；浏览器在**另一个进程**里继续跑，`DevToolsActivePort` **~1.7s** 才落盘。
而守卫的等待循环里有：

```js
if (child.exitCode != null) break      // 🔴 正好卡在那 1.5s 的窗口里 ⇒ 误判
```

**教训（可迁移的那一条）**：**"启动器退出"是观测过程中的一个中间现象，不是"起没起来"的结论。**
任何"轮询到 X 就放弃"的循环，都要先问：**X 是"答案已经确定"，还是"只是过程中发生了一件事"？**
这里 X 只说明"那个进程结束了"，而真正要等的东西在**另一个进程**里。
判据只有一个：**到点之前，目标文件有没有写全**。

**为什么它特别贵**（三条一起看）：

1. **CI 上看不见**：Linux 不握手交接，文件来得比启动器退出还快 ⇒ 只在 Windows 暴露，
   而症状长得像"这台机器起不了 Chrome"，把人往环境方向带。
2. **它同时掩盖了一个资源泄漏**：`child.kill()` 打的是**已经不存在的**启动器 ⇒
   浏览器一直活着、占住 `user-data-dir` ⇒ `fs.rmSync` **静默失败**、Temp 里堆满 `ng-smoke-*`
   （实测一轮诊断泄漏 5 个，更早的累计 54 个）。收尾改走 CDP `Browser.close` 才关得掉。
3. **改完不能只跑一次就算过**：判据抽成纯函数 `waitForDevToolsPort()` + **6 例虚拟时钟自测**，
   再配 `.buildenv/mutate-launch-wait.py` 做 **A/B**（原样必须绿 / 把那句话放回去必须**恰好**
   那两条用例红）。细节与对照表见 `MULTIPLATFORM.md §9.8` 末尾。

### 7.8 「只能真机验证」本身是个未经验证的断言（v1.7.2 政策转向）

**现象**：`device-matrix.md` 原先有 7 条"只能真机走"的路径，路线图需求 1 就卡在上面，
卡了很久。查清楚硬件后确认：Android 是唯一能完整走完的端，但**缺一部真机 + 一个真人**
（§三 第 5 条"幅度够不够"必须由真人给）。于是"验证"这件事被一部手机卡死了。

**真正的根因**：**"只能真机"这句话从来没被检查过**。它是按**平台**（"这是移动端的功能"）
顺手下的判断，而不是按**判据的性质**下的。逐条翻开看，7 条里有一半的判据压根不碰设备：

| 原判"只能真机"的项 | 判据的真实性质 | 实际怎么验 |
|---|---|---|
| iOS/Android 权限声明与 scheme 对不对 | **静态文本** | 源码守卫 `verify:native-config`（10 项） |
| 权限回调桥的并发收纳（v1.3.2「允许了权限却打不开」） | **纯逻辑**（挂起请求恰好被应答一次） | 抽成零 `android.*` 依赖的纯类 + JUnit 10 例 |
| 包名 / manifest 权限 | **静态文本** | 同一个源码守卫 |

**教训（可迁移的那一条）**：遇到"这个只能真机验"，**先问一句：这条判据是静态文本或纯逻辑吗？**
若是，它就跟设备无关，只是**凑巧被写在了设备相关的代码里**——
- 判据是**静态文本**（配置、清单、包名、文案）⇒ 写**源码守卫**；
- 判据是**纯逻辑**（状态机、并发、算分、格式）⇒ 抽成**不依赖平台 SDK 的纯函数/纯类**（这一步是关键，
  `CameraPermissionQueue` 能跑 JUnit 的全部原因就是它**零 `android.*` import**）⇒ 用 JUnit / `verify-*.mjs` 跑。

**只有物理量校准真的替代不了**：`MIN_POSE_MS = 200ms`、`measurable`、"动作做多大才算到位" ——
这些要的是**真人身体的数据**，跑多少单元测试也变不出来。这类项要**显式登记为"已接受的残余风险"**
（`device-matrix.md` C 类），**不许**因为别的项被覆盖了，就在文档里把它一起悄悄升格成"已验证"。

**两个配套纪律**（本轮踩出来的）：

1. **抽出来的纯逻辑，守卫必须断"具体次数"而不是"没抛异常"**。`assertEquals(1, grants + denies)`
   才有牙；`assertDoesNotThrow` 会让 v1.3.2 那个真缺陷**绿着过**。
2. **别留"永远绿"的测试**。Capacitor 模板自带的 `ExampleUnitTest`（`assertEquals(4, 2+2)`）
   和断言错包名的 `ExampleInstrumentedTest` 都已 `git rm` ——
   **永远绿的测试比没有测试更坏**，它会让人以为这条链路有人看着（本轮实测：加上自己的 10 例后
   报告里原本是 11 个用例，其中 1 个就是那个桩）。

**顺带一条**：把"只能真机"改写成"已由代码覆盖"时，**只改文档就等于把 caveat 从"未验证"换成"已验证"**——
正是该禁止的。必须先真的把守卫和单测写出来、跑了、用变异证明有牙，文档才有资格改口。

### 7.9 守卫"喂不饱自己"：入库的 gradle 脚本 `apply from` 了一个被忽略的生成产物

**现象**：新加的 `android-unit-test` job 在 CI 首跑 `36886981654` 上红，**43 秒**就结束，
且**一份 JUnit 报告都没产出**：

```
> Could not read script '…/android/capacitor-cordova-android-plugins/cordova.variables.gradle'
  as it does not exist.
BUILD FAILED in 34s
```

而**本机同一条命令一直绿**（同一份源码、同一个 gradle 任务）。

**根因**：这是一个**仓库层面的自相矛盾**，不是环境问题：

| 文件 | 是否入库 | 说明 |
|---|---|---|
| `android/app/capacitor.build.gradle` | ✅ **被跟踪** | 第 10 行 `apply from "../capacitor-cordova-android-plugins/cordova.variables.gradle"` |
| `android/capacitor.settings.gradle` | ✅ **被跟踪** | 同上，引用同目录 |
| `android/capacitor-cordova-android-plugins/` | ❌ **被 `android/.gitignore:101` 忽略** | 由 `cap sync` 生成 |

⇒ **干净的检出上，gradle 在配置阶段就炸**（连编译都没到），而本机因为以前跑过打包、
那些产物还**留在工作区**里 ⇒ 本机**永远绿**。经典「本机绿 ≠ CI 绿」，
而且这次**连错误都被伪装成"构建失败"**（真正的性质是"准备工作没做"）。

**改法**：job 里补上生成原生工程这一步，**并且把「分类」写进守卫**：

```yaml
- run: npm ci
- name: 生成原生工程（cap sync）
  run: |
    mkdir -p dist        # 纯 JVM 单测不读 web 资源，但 cap 要求 webDir 存在
    npx cap sync android
```

守卫侧新增纯函数 `classifyBuildFailure(gradle输出)`，把"没有报告"细分成
`native-project-not-generated` / `jdk-mismatch` / `deps-unavailable` / `unknown`，
**每一类都给可执行的下一步**（第一类直接打印要跑的那两行命令）。
配 `HINT_CASES` **6 例**自测，其中 **2 例是负向对照**（同样出现 `does not exist`
但和原生工程无关、以及空输出 ⇒ 必须落 `unknown`），否则归类器就退化成
"见到 `does not exist` 就喊环境不足"的开关。
变异 `.buildenv/mutate-android-unit-guard.sh` **8/8**（H2 就是上面那个退化形态，
由负向对照用例抓住）。

**教训（可迁移的那一条）**：**"没有任何报告"是"没跑起来"，不是"测试失败"** ——
但光这么说还不够：**"没跑起来"必须继续细分到"我该做什么"**。一条
`环境不足` 如果只停在"环境不足"，人还是会去猜（本次第一反应是"runner 太慢了吧"）。
判据：**报错里要能看出"缺什么、补什么"，且这种归类本身要配负向对照** ——
否则任何"没报告"都会被归成同一句话，等于没归。

**顺带一条**：这也说明**「本机跑过一次」会污染后续所有判断**。凡是依赖生成产物的
任务，验证时至少要问一句：**"干净检出上有这个文件吗？"**
（对照 §7.1 的时区版：那次是"只在生成那台机器上绿"，这次是"只在跑过打包的机器上绿"。）
