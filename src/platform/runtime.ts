import { Capacitor } from '@capacitor/core'

/**
 * 运行环境判定。
 *
 * NeckGuardian 现在同时运行在三种环境中：
 * - `electron`：桌面版，带本地 Python 后端（HTTP + WebSocket）
 * - `android` / `ios`：移动端（Capacitor 套壳），无后端，推理与存储全在本地
 * - `web`：纯浏览器调试
 *
 * 平台差异被收敛到 `platform.ts` / `localBackend.ts` 等处，
 * 业务组件只需调用统一接口，不必到处判断环境。
 */
export type RuntimePlatform = 'electron' | 'android' | 'ios' | 'web'

export function getPlatform(): RuntimePlatform {
  if (typeof window !== 'undefined' && window.electronAPI) return 'electron'
  // 开发辅助：在桌面浏览器里打开 `?platform=android` 即可强制走移动端分支，
  // 用来调手机端 UI 而不必每次都装 APK。安卓包内 URL 不带该参数，正式环境无影响。
  if (typeof window !== 'undefined') {
    const forced = new URLSearchParams(window.location.search).get('platform')
    if (forced === 'android' || forced === 'ios' || forced === 'web') return forced
  }
  const native = Capacitor.getPlatform() // 'android' | 'ios' | 'web'
  if (native === 'android' || native === 'ios') return native
  return 'web'
}

/** 是否运行在移动端（安卓/iOS）。 */
export function isMobile(): boolean {
  const p = getPlatform()
  return p === 'android' || p === 'ios'
}

/**
 * 是否存在可用的本地后端服务。
 *
 * 桌面版由 Electron 主进程拉起 Python 后端，因此为 true；
 * 移动端/纯浏览器没有后端，姿态推理与数据存储改由前端本地实现。
 */
export function hasLocalBackend(): boolean {
  return getPlatform() === 'electron'
}
