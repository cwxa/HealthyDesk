const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const { spawn } = require('child_process')
const http = require('http')

let mainWindow = null
let tray = null
let pythonProcess = null
const BACKEND_PORT = 18920
const BACKEND_URL = `http://127.0.0.1:${BACKEND_PORT}`

function getAssetPath(...segments) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, ...segments)
  }
  return path.join(__dirname, '..', ...segments)
}

function isBackendRunning() {
  return new Promise((resolve) => {
    http.get(`${BACKEND_URL}/api/health`, (res) => {
      resolve(res.statusCode === 200)
    }).on('error', () => resolve(false))
  })
}

function startPythonBackend() {
  isBackendRunning().then(running => {
    if (running) {
      console.log('Backend already running on port', BACKEND_PORT)
      return
    }
    const backendDir = getAssetPath('backend')
    const mainPy = path.join(backendDir, 'main.py')

    pythonProcess = spawn('python', [mainPy], {
      cwd: backendDir,
      env: { ...process.env, NECKGUARDIAN_PORT: String(BACKEND_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    pythonProcess.stdout.on('data', (data) => {
      console.log(`[Python] ${data.toString().trim()}`)
    })

    pythonProcess.stderr.on('data', (data) => {
      console.error(`[Python ERR] ${data.toString().trim()}`)
    })

    pythonProcess.on('exit', (code) => {
      console.log(`Python process exited with code ${code}`)
      if (code !== 0 && mainWindow && !mainWindow.isDestroyed()) {
        setTimeout(() => startPythonBackend(), 5000)
      }
    })
  })
}

function waitForBackend(retries = 30) {
  return new Promise((resolve) => {
    function check(remaining) {
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

function createTray() {
  const iconPath = getAssetPath('public', 'tray-icon.png')
  let trayIcon
  try {
    trayIcon = nativeImage.createFromPath(iconPath)
    if (trayIcon.isEmpty()) {
      trayIcon = nativeImage.createEmpty()
    }
  } catch (_) {
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1024,
    height: 768,
    minWidth: 1024,
    maxWidth: 1024,
    minHeight: 768,
    maxHeight: 768,
    resizable: false,
    title: 'NeckGuardian - 肩颈健康助手',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  const distIndex = path.join(__dirname, '..', 'dist', 'index.html')
  const fs = require('fs')
  if (fs.existsSync(distIndex)) {
    mainWindow.loadFile(distIndex)
  } else {
    mainWindow.loadURL('http://localhost:5173')
  }

  mainWindow.on('close', (event) => {
    if (tray) {
      event.preventDefault()
      mainWindow.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  startPythonBackend()
  createWindow()
  createTray()

  const backendReady = await waitForBackend()
  if (backendReady && mainWindow) {
    mainWindow.webContents.send('backend-ready', { port: BACKEND_PORT })
  }
})

app.on('window-all-closed', () => {
  // Keep running in tray on all platforms
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

ipcMain.handle('quit-app', () => {
  if (tray) {
    tray.destroy()
    tray = null
  }
  app.exit()
})

ipcMain.handle('get-app-version', () => app.getVersion())
