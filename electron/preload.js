const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),
  minimizeToTray: () => ipcRenderer.invoke('minimize-to-tray'),
  quitApp: () => ipcRenderer.invoke('quit-app'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  setAutoStart: (enabled) => ipcRenderer.invoke('set-auto-start', enabled),
  onBackendReady: (callback) => {
    ipcRenderer.on('backend-ready', (_event, data) => callback(data))
  },
  onStartExercise: (callback) => {
    ipcRenderer.on('start-exercise', () => callback())
  },
  onReminder: (callback) => {
    ipcRenderer.on('reminder-trigger', () => callback())
  },
})
