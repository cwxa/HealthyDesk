import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification } from 'electron'
import path from 'path'
import fs from 'fs'
import { spawn, ChildProcess } from 'child_process'
import http from 'http'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let pythonProcess: ChildProcess | null = null
let isQuiting = false
const BACKEND_PORT = 18920
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

function getAssetPath(...segments: string[]): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments)
  }
  return path.join(__dirname, '..', ...segments)
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

function getBackendExePath(): string | null {
  // 打包后的安装包会把 PyInstaller 后端放到 resources/neckguardian-backend
  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, 'neckguardian-backend', 'neckguardian-backend.exe')
    return fs.existsSync(p) ? p : null
  }
  // 开发环境：若本地已用 PyInstaller 构建过 exe，则优先使用
  const local = path.join(__dirname, '..', 'build', 'neckguardian-backend', 'neckguardian-backend.exe')
  return fs.existsSync(local) ? local : null
}

// 强制终止后端进程及其子进程树（PyInstaller exe 会 fork 子进程，
// Windows 上单纯 kill() 不保证回收整棵树）。
function killBackendProcess(): void {
  const proc = pythonProcess
  pythonProcess = null
  if (!proc || proc.killed || proc.pid === undefined) return

  if (process.platform === 'win32') {
    try {
      // taskkill /T 递归终止子进程，/F 强制
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      proc.kill()
    }
  } else {
    proc.kill('SIGTERM')
  }
}

function startPythonBackend(): void {
  const env = { ...process.env, NECKGUARDIAN_PORT: String(BACKEND_PORT) }

  // 优先使用自包含后端可执行文件（目标机无需安装 Python）
  const exePath = getBackendExePath()
  if (exePath) {
    console.log('Starting bundled backend executable:', exePath)
    pythonProcess = spawn(exePath, [], {
      cwd: path.dirname(exePath),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } else {
    // 开发环境回退：直接运行 Python 源码
    const backendDir = getAssetPath('backend')
    const mainPy = path.join(backendDir, 'main.py')
    console.log('Starting backend via python:', mainPy)
    pythonProcess = spawn('python', [mainPy], {
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
        console.log('[Electron] Polled reminder status:', JSON.stringify(status))
        if (status.pending) {
          const triggered = status.last_triggered as string | null
          console.log('[Electron] Pending reminder detected. Last triggered:', triggered, 'Current lastTimestamp:', lastReminderTimestamp)
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

function createTray(): void {
  const iconPath = getAssetPath('public', 'tray-icon.png')
  let trayIcon: Electron.NativeImage
  try {
    trayIcon = nativeImage.createFromPath(iconPath)
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createEmpty()
    }
  } catch {
    trayIcon = nativeImage.createEmpty()
  }

  tray = new Tray(trayIcon.resize({ width: 16, height: 16 }))
  tray.setToolTip('NeckGuardian - 肩颈健康助手')

  const contextMenu = Menu.buildFromTemplate([
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
      label: '退出',
      click: () => {
        app.exit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

function createWindow(): void {
  // 获取窗口图标路径
  const windowIconPath = getAssetPath('public', 'icon.ico')
  let windowIcon: Electron.NativeImage | undefined
  try {
    windowIcon = nativeImage.createFromPath(windowIconPath)
    if (windowIcon.isEmpty()) {
      windowIcon = undefined
    }
  } catch {
    windowIcon = undefined
  }

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
    icon: windowIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // 启用页面缩放（Ctrl+滚轮）
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

app.whenReady().then(async () => {
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

  // 注册全局快捷键 Ctrl++ / Ctrl+- / Ctrl+0 缩放
  const { globalShortcut } = require('electron')
  globalShortcut.register('CommandOrControl+Plus', () => {
    if (mainWindow) {
      const currentZoom = mainWindow.webContents.getZoomFactor()
      mainWindow.webContents.setZoomFactor(Math.min(currentZoom + 0.1, 3))
    }
  })
  globalShortcut.register('CommandOrControl+-', () => {
    if (mainWindow) {
      const currentZoom = mainWindow.webContents.getZoomFactor()
      mainWindow.webContents.setZoomFactor(Math.max(currentZoom - 0.1, 0.5))
    }
  })
  globalShortcut.register('CommandOrControl+0', () => {
    if (mainWindow) {
      mainWindow.webContents.setZoomFactor(1)
    }
  })

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

app.on('window-all-closed', () => {
  // 保持托盘常驻：关闭窗口不退出应用（用户从托盘菜单或侧栏按钮显式退出）。
  // 非 macOS 且托盘不可用时，仍保留此行为以免后台无双击入口。
})

app.on('before-quit', () => {
  isQuiting = true
  // 注销全局快捷键
  const { globalShortcut } = require('electron')
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
    path: process.execPath,
  })
})
