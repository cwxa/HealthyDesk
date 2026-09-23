import { contextBridge, ipcRenderer } from 'electron'

/**
 * 暴露给渲染进程的桥。
 *
 * `platform` / `arch` 直接取自 preload 的 Node 上下文（preload 运行在 Node 里，
 * 不必为这两个静态值多开一条 IPC）。渲染层用它区分 Windows / macOS / Linux ——
 * 三者的托盘文案、快捷键提示、权限设置路径都不同，而运行时平台同为 `electron`。
 */
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  arch: process.arch,
  getBackendUrl: (): Promise<string> => ipcRenderer.invoke('get-backend-url'),
  minimizeToTray: (): Promise<void> => ipcRenderer.invoke('minimize-to-tray'),
  quitApp: (): Promise<void> => ipcRenderer.invoke('quit-app'),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),
  setAutoStart: (enabled: boolean): Promise<void> =>
    ipcRenderer.invoke('set-auto-start', enabled),
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
