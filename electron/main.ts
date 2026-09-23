import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  Notification,
  globalShortcut,
} from 'electron'
import path from 'path'
import fs from 'fs'
import { spawn, spawnSync, ChildProcess } from 'child_process'
import http from 'http'

const IS_MAC = process.platform === 'darwin'
const IS_WIN = process.platform === 'win32'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let pythonProcess: ChildProcess | null = null
let isQuiting = false
const BACKEND_PORT = 18920
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

/** 后端可执行文件名：Windows 带 `.exe`，macOS / Linux 无扩展名。 */
const BACKEND_BIN_NAME = IS_WIN ? 'neckguardian-backend.exe' : 'neckguardian-backend'

/**
 * 应用内静态资源目录。
 *
 * ⚠️ 指向的是 **`dist/`**，不是仓库根的 `public/`。
 * vite 会把 `public/` 的内容**原样复制**到 `dist/` 根下，而 electron-builder 只打包
 * `dist/**` 与 `backend/**`（`directories.buildResources: public` 仅用于构建期读取图标，
 * **不会**进入安装包）。
 *
 * 历史 bug：原实现写成 `getAssetPath('public', 'tray-icon.png')`，打包后解析到
 * `resources/public/tray-icon.png` —— 该目录压根不存在，`nativeImage` 得到空图，
 * 于是**托盘图标静默变成空白**（窗口图标也拿不到，只是被 exe 内嵌图标掩盖了）。
 */
function getDistAsset(...segments: string[]): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'app', 'dist')
    : path.join(__dirname, '..', 'dist')
  return path.join(base, ...segments)
}

/** 后端 Python 源码目录（仅开发环境的回退路径使用）。 */
function getBackendSourceDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'backend')
    : path.join(__dirname, '..', 'backend')
}

// 检查后端是否已在运行（避免重复启动）
function checkBackendRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`${BACKEND_URL}/api/health`, (res) => {
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * 定位自包含后端可执行文件。
 *
 * 打包后位于 `resources/neckguardian-backend/`；开发环境优先用本地
 * `build/neckguardian-backend/`（`npm run backend:build` 的产物）。
 *
 * ⚠️ 两个候选名字都试：跨平台调试时（例如在 macOS 上验证 Windows 包）
 * 文件名不一定与当前平台一致。
 */
function getBackendBinaryPath(): string | null {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'neckguardian-backend')
    : path.join(__dirname, '..', 'build', 'neckguardian-backend')

  for (const name of [BACKEND_BIN_NAME, 'neckguardian-backend.exe', 'neckguardian-backend']) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * 找到可用的 Python 解释器（仅开发环境回退用）。
 *
 * ⚠️ macOS 12+ 不再内置 `python`，只有 `python3`；Windows 上则通常只有 `python`。
 * 写死任一名字都会在一个平台上静默失效。
 */
let cachedPython: string | null = null
function resolvePythonCommand(): string {
  if (cachedPython) return cachedPython
  const candidates = IS_WIN ? ['python', 'python3'] : ['python3', 'python']
  for (const cmd of candidates) {
    try {
      const r = spawnSync(cmd, ['--version'], { stdio: 'ignore' })
      if (!r.error && r.status === 0) {
        cachedPython = cmd
        return cmd
      }
    } catch {
      // 试下一个
    }
  }
  cachedPython = candidates[0]
  return cachedPython
}

// 强制终止后端进程及其子进程树（PyInstaller exe 会 fork 子进程，
// Windows 上单纯 kill() 不保证回收整棵树）。
function killBackendProcess(): void {
  const proc = pythonProcess
  pythonProcess = null
  if (!proc || proc.killed || proc.pid === undefined) return

  if (IS_WIN) {
    try {
      // taskkill /T 递归终止子进程，/F 强制
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      proc.kill()
    }
    return
  }

  // POSIX：先 SIGTERM 优雅退出，2 秒后仍在则 SIGKILL
  // （PyInstaller 的 bootloader 会派生真正的服务进程，不递归会留下孤儿占用端口）
  const pid = proc.pid
  try {
    proc.kill('SIGTERM')
  } catch {
    return
  }
  const forceTimer = setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // 已退出
    }
  }, 2000)
  forceTimer.unref?.()
}

function startPythonBackend(): void {
  const env = { ...process.env, NECKGUARDIAN_PORT: String(BACKEND_PORT) }

  // 优先使用自包含后端可执行文件（目标机无需安装 Python）
  const exePath = getBackendBinaryPath()
  if (exePath) {
    console.log('Starting bundled backend executable:', exePath)
    pythonProcess = spawn(exePath, [], {
      cwd: path.dirname(exePath),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } else {
    // 开发环境回退：直接运行 Python 源码
    const backendDir = getBackendSourceDir()
    const mainPy = path.join(backendDir, 'main.py')
    const python = resolvePythonCommand()
    console.log(`Starting backend via ${python}:`, mainPy)
    pythonProcess = spawn(python, [mainPy], {
      cwd: backendDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  }

  // 统一挂载日志与崩溃恢复（此前 exe 分支提前 return，导致打包环境
  // 崩溃后永不重启、日志被吞）。
  pythonProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[Backend] ${data.toString().trim()}`)
  })

  pythonProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[Backend ERR] ${data.toString().trim()}`)
  })

  pythonProcess.on('exit', (code) => {
    console.log(`Backend process exited with code ${code}`)
    // 正常退出（含应用退出时被主动 kill）不重启
    if (isQuiting) return
    if (mainWindow) {
      console.warn('Backend crashed, restarting in 3s...')
      setTimeout(() => {
        if (!isQuiting) startPythonBackend()
      }, 3000)
    }
  })

  pythonProcess.on('error', (err) => {
    console.error('Failed to spawn backend process:', err)
  })
}

function waitForBackend(retries = 30): Promise<boolean> {
  return new Promise((resolve) => {
    function check(remaining: number) {
      const req = http.get(`${BACKEND_URL}/api/health`, (res) => {
        if (res.statusCode === 200) resolve(true)
        else if (remaining > 0) setTimeout(() => check(remaining - 1), 1000)
        else resolve(false)
      })
      req.on('error', () => {
        if (remaining > 0) setTimeout(() => check(remaining - 1), 1000)
        else resolve(false)
      })
      req.setTimeout(3000, () => {
        req.destroy()
        if (remaining > 0) setTimeout(() => check(remaining - 1), 1000)
        else resolve(false)
      })
    }
    check(retries)
  })
}

let lastReminderTimestamp: string | null = null
let reminderPollInterval: NodeJS.Timeout | null = null

function pollReminderStatus(): void {
  if (!mainWindow) return
  const req = http.get(`${BACKEND_URL}/api/reminder/status`, (res) => {
    let data = ''
    res.on('data', (chunk: Buffer) => { data += chunk.toString() })
    res.on('end', () => {
      try {
        const status = JSON.parse(data)
        if (status.pending) {
          const triggered = status.last_triggered as string | null
          if (triggered && triggered !== lastReminderTimestamp) {
            console.log('[Electron] New reminder detected! Sending IPC message...')
            lastReminderTimestamp = triggered
            if (Notification.isSupported()) {
              const notification = new Notification({
                title: 'NeckGuardian 提醒',
                body: '该活动一下了！请你活动肩颈。',
              })
              notification.on('click', () => {
                if (mainWindow) {
                  mainWindow.show()
                  mainWindow.focus()
                }
              })
              notification.show()
            }
            mainWindow?.webContents.send('reminder-trigger')
          }
        }
      } catch (e) {
        console.error('[Electron] Failed to parse reminder status:', e)
      }
    })
  })
  req.on('error', (e) => {
    console.error('[Electron] Poll reminder status error:', e)
  })
  req.setTimeout(5000, () => req.destroy())
}

function startReminderPolling(): void {
  pollReminderStatus()
  reminderPollInterval = setInterval(pollReminderStatus, 10000)
}

function stopReminderPolling(): void {
  if (reminderPollInterval) {
    clearInterval(reminderPollInterval)
    reminderPollInterval = null
  }
}

/**
 * 托盘 / 菜单栏图标。
 *
 * - **macOS**：用 `*Template.png`（纯黑 + alpha），系统会按菜单栏明暗自动反色；
 *   彩色图在深色菜单栏下会看不清。尺寸必须控制在 16pt（提供 @2x 供 Retina），
 *   因此这里**不做 resize**（缩小会丢掉 @2x 的清晰度）。
 * - **Windows / Linux**：用彩色图并缩到 16px。
 */
function resolveTrayIcon(): Electron.NativeImage {
  const name = IS_MAC ? 'tray-iconTemplate.png' : 'tray-icon.png'
  const img = nativeImage.createFromPath(getDistAsset(name))
  if (img.isEmpty()) {
    console.warn(`[Electron] Tray icon not found: ${getDistAsset(name)}`)
    return nativeImage.createEmpty()
  }
  if (IS_MAC) {
    // 文件名已带 Template 会被自动识别，这里显式声明一次更稳
    img.setTemplateImage(true)
    return img
  }
  return img.resize({ width: 16, height: 16 })
}

/**
 * 窗口图标。
 *
 * macOS 不使用它 —— 应用图标由 `.app` bundle 里的 `.icns` 决定，
 * 给 BrowserWindow 传图标既无效也不符合平台惯例。
 */
function resolveWindowIcon(): Electron.NativeImage | undefined {
  if (IS_MAC) return undefined
  const candidates = IS_WIN
    ? [getDistAsset('icon.ico'), getDistAsset('icon.png')]
    : [getDistAsset('icons', '256x256.png'), getDistAsset('icon.png')]
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) return img
    } catch {
      // 试下一个
    }
  }
  return undefined
}

function createTray(): void {
  tray = new Tray(resolveTrayIcon())
  tray.setToolTip('NeckGuardian - 肩颈健康助手')

  const menuTemplate: Electron.MenuItemConstructorOptions[] = [
    {
      label: '显示主窗口',
      click: () => {
        if (mainWindow) {
          mainWindow.show()
          mainWindow.focus()
        }
      },
    },
    {
      label: '开始活动',
      click: () => {
        if (mainWindow) {
          mainWindow.webContents.send('start-exercise')
          mainWindow.show()
          mainWindow.focus()
        }
      },
    },
    { type: 'separator' },
    {
      label: IS_MAC ? '退出 NeckGuardian' : '退出',
      click: () => {
        app.exit()
      },
    },
  ]

  tray.setContextMenu(Menu.buildFromTemplate(menuTemplate))

  // Windows/Linux 是"双击打开"；macOS 上左键单击即弹菜单（由 setContextMenu 提供），
  // 双击事件在菜单栏图标上不会触发，因此只在非 macOS 注册。
  if (!IS_MAC) {
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
  }
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    title: 'NeckGuardian - 肩颈健康助手',
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    maximizable: true,
    resizable: true,
    fullscreenable: true,
    icon: resolveWindowIcon(),
    // macOS 上用系统原生标题栏 + 交通灯按钮；其余平台默认即可
    ...(IS_MAC ? { titleBarStyle: 'default' as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 启用页面缩放（Ctrl/⌘ + 滚轮）
  mainWindow.webContents.setVisualZoomLevelLimits(1, 3)
  mainWindow.webContents.on('zoom-changed', (event, direction) => {
    const currentZoom = mainWindow?.webContents.getZoomFactor() || 1
    if (direction === 'in') {
      mainWindow?.webContents.setZoomFactor(Math.min(currentZoom + 0.1, 3))
    } else {
      mainWindow?.webContents.setZoomFactor(Math.max(currentZoom - 0.1, 0.5))
    }
  })

  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, 'index.html'))
  }

  // 等页面加载完成再显示窗口，避免白屏闪烁
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
    // 开发模式下自动打开 DevTools
    if (!app.isPackaged) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** 注册全局缩放快捷键（Ctrl/⌘ + / - / 0）。 */
function registerZoomShortcuts(): void {
  const bind = (accelerator: string, apply: (win: BrowserWindow) => void) => {
    const ok = globalShortcut.register(accelerator, () => {
      if (mainWindow) apply(mainWindow)
    })
    // ⚠️ 注册可能被系统或其他应用占用而静默失败（macOS 上尤其常见），必须报出来
    if (!ok) console.warn(`[Electron] 全局快捷键注册失败（可能已被占用）：${accelerator}`)
  }

  bind('CommandOrControl+Plus', (win) =>
    win.webContents.setZoomFactor(Math.min(win.webContents.getZoomFactor() + 0.1, 3)),
  )
  bind('CommandOrControl+-', (win) =>
    win.webContents.setZoomFactor(Math.max(win.webContents.getZoomFactor() - 0.1, 0.5)),
  )
  bind('CommandOrControl+0', (win) => win.webContents.setZoomFactor(1))
}

// 单实例锁：防止多个 Electron 进程同时运行
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  console.log('Another instance is already running, quitting...')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// Windows 上设置 AppUserModelID，否则系统通知不会正确归属到本应用
// （打包后的快捷方式由 electron-builder 写入同样的 ID）。
if (IS_WIN) app.setAppUserModelId('com.neckguardian.app')

app.whenReady().then(async () => {
  if (IS_MAC) {
    app.setAboutPanelOptions({
      applicationName: 'NeckGuardian',
      applicationVersion: app.getVersion(),
      copyright: 'Copyright © 2024',
    })
  }

  // 先检测后端是否已由 start.bat 启动
  const backendAlreadyRunning = await checkBackendRunning()
  if (backendAlreadyRunning) {
    console.log('Backend already running on port', BACKEND_PORT)
  } else {
    console.log('Starting Python backend...')
    startPythonBackend()
  }

  createWindow()
  createTray()
  registerZoomShortcuts()

  const backendReady = await waitForBackend()
  if (backendReady) {
    startReminderPolling()
    if (mainWindow) {
      mainWindow.webContents.send('backend-ready', { port: BACKEND_PORT })
    }
  } else {
    console.error('Backend failed to start within timeout')
  }
})

/**
 * macOS：点击 Dock 图标时重新打开窗口（窗口被关闭但应用仍在运行的场景）。
 * 其他平台不做处理 —— 窗口重开走托盘菜单。
 */
app.on('activate', () => {
  if (!mainWindow) {
    createWindow()
  } else {
    mainWindow.show()
    mainWindow.focus()
  }
})

app.on('window-all-closed', () => {
  // 保持托盘/菜单栏常驻：关闭窗口不退出应用（三个平台行为一致），
  // 由托盘菜单「退出」或侧栏按钮显式退出。
  // macOS 上应用会留在 Dock，用户点击 Dock 图标可重新打开窗口（见 'activate'）。
})

app.on('before-quit', () => {
  isQuiting = true
  globalShortcut.unregisterAll()
  stopReminderPolling()
  killBackendProcess()
})

// 进程被信号中断（如任务管理器结束、开发热重载）时同样清理后端，
// 避免孤儿进程占用端口 18920。
;(['SIGINT', 'SIGTERM'] as const).forEach((sig) => {
  process.on(sig, () => {
    isQuiting = true
    killBackendProcess()
    app.quit()
  })
})

ipcMain.handle('get-backend-url', () => BACKEND_URL)

ipcMain.handle('minimize-to-tray', () => {
  if (mainWindow) {
    // macOS 隐藏窗口后应用仍在 Dock；其他平台收到托盘。
    // 两者都由同一个动作触发，语义对用户一致：窗口收了，应用还在跑。
    mainWindow.hide()
  }
})

ipcMain.handle('quit-app', () => {
  isQuiting = true
  app.exit()
})

ipcMain.handle('get-app-version', () => app.getVersion())

ipcMain.handle('set-auto-start', (_event, enabled: boolean) => {
  // 仅打包后生效；开发环境调用会写入 Electron 默认 exe，故跳过。
  if (!app.isPackaged) return
  app.setLoginItemSettings({
    openAtLogin: !!enabled,
    // macOS 必须指向 .app 包本身；Windows 指向 exe
    path: process.execPath,
  })
})
