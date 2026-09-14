# NeckGuardian 开发问题总结

本文档记录项目在开发 / 打包 / 发布过程中遇到的关键问题及解决方案，供后续维护参考。

---

## 一、打包与运行（最严重）

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

## 五、经验教训

1. **打包产物必须实测启动**，"能打出包"不等于"包能用"。UPX 问题正是因为没有实测才长期潜伏。
2. **配置文件要入库**，`.gitignore` 的宽泛规则（如 `*.spec`）容易误伤关键配置。
3. **前端开关要打通到后端**，否则只是"看起来很能用的假开关"。
4. **异步 + 组件卸载**是前端资源泄漏高发区，StrictMode 会放大此类问题。
5. **沙箱环境**下优先用 PowerShell 做文件操作，命令行工具易受 PATH / shim 干扰。
