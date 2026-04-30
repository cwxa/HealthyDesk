import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } from 'electron'
import path from 'path'
import { spawn, ChildProcess } from 'child_process'
import http from 'http'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let pythonProcess: ChildProcess | null = null
const BACKEND_PORT = 18920
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

function getAssetPath(...segments: string[]): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments)
  }
  return path.join(__dirname, '..', ...segments)
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
      setTimeout(() => startPythonBackend(), 3000)
    }
  })
}

function waitForBackend(retries = 30): Promise<boolean> {
  return new Promise((resolve) => {
    function check(remaining: number) {
      http.get(`${BACKEND_URL}/api/health`, (res) => {
        if (res.statusCode === 200) resolve(true)
        else if (remaining > 0) setTimeout(() => check(remaining - 1), 1000)
        else resolve(false)
      }).on('error', () => {
        if (remaining > 0) setTimeout(() => check(remaining - 1), 1000)
        else resolve(false)
      })
    }
    check(retries)
  })
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
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: true,
    title: 'NeckGuardian - 肩颈健康助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173')
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.on('close', (event) => {
    if (tray) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  startPythonBackend()
  createWindow()
  createTray()

  const backendReady = await waitForBackend()
  if (backendReady && mainWindow) {
    mainWindow.webContents.send('backend-ready', { port: BACKEND_PORT })
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Don't quit if tray exists
  }
})

app.on('before-quit', () => {
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

ipcMain.handle('get-app-version', () => app.getVersion())
