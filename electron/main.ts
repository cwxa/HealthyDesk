import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, Notification } from 'electron'
import path from 'path'
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

function startPythonBackend(): void {
  const backendDir = getAssetPath('backend')
  const mainPy = path.join(backendDir, 'main.py')

  pythonProcess = spawn('python', [mainPy], {
    cwd: backendDir,
    env: { ...process.env, NECKGUARDIAN_PORT: String(BACKEND_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  pythonProcess.stdout?.on('data', (data: Buffer) => {
    console.log(`[Python] ${data.toString().trim()}`)
  })

  pythonProcess.stderr?.on('data', (data: Buffer) => {
    console.error(`[Python ERR] ${data.toString().trim()}`)
  })

  pythonProcess.on('exit', (code) => {
    console.log(`Python process exited with code ${code}`)
    if (code !== 0 && mainWindow) {
      console.warn('Backend crashed, restarting in 3s...')
      setTimeout(() => startPythonBackend(), 3000)
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
  if (process.platform !== 'darwin') {
    // Don't quit if tray exists
  }
})

app.on('before-quit', () => {
  isQuiting = true
  // 注销全局快捷键
  const { globalShortcut } = require('electron')
  globalShortcut.unregisterAll()
  stopReminderPolling()
  if (pythonProcess) {
    pythonProcess.kill()
    pythonProcess = null
  }
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
