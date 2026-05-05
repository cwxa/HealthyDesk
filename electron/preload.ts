import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('get-backend-url'),
  minimizeToTray: (): Promise<void> => ipcRenderer.invoke('minimize-to-tray'),
  quitApp: (): Promise<void> => ipcRenderer.invoke('quit-app'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  onBackendReady: (callback: (data: { port: number }) => void) => {
    ipcRenderer.on('backend-ready', (_event, data) => callback(data))
  },
  onStartExercise: (callback: () => void) => {
    ipcRenderer.on('start-exercise', () => callback())
  },
  onReminder: (callback: () => void) => {
    ipcRenderer.on('reminder-trigger', () => callback())
  },
})
