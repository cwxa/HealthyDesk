/**
 * 安卓原生侧诊断通道。
 *
 * `MainActivity` 通过 `addJavascriptInterface` 暴露了一个**只读**的
 * `NeckGuardianNative.diagnostics()`，返回安卓侧真实的相机权限状态等信息。
 *
 * 之所以需要它：WebView 里 `getUserMedia` 失败时只给一个 `NotAllowedError`，
 * 无法区分「用户拒绝了」「用户选了不再询问」「系统隐私开关拦截」，
 * 有原生状态才能给出准确的排查提示。其他平台（桌面/浏览器）返回 null。
 */

export type CameraPermissionState = 'granted' | 'denied' | 'blocked' | 'unknown'

export interface NativeDiag {
  cameraPermission: CameraPermissionState
  granted: boolean
  /** 安装包的 versionName（确认用户装的是哪一版） */
  version?: string
  versionCode?: number
  sdk?: number
  manufacturer?: string
  model?: string
}

/** 读取原生诊断信息；非安卓环境或接口不可用时返回 null。 */
export function nativeDiag(): NativeDiag | null {
  try {
    const api = (window as unknown as { NeckGuardianNative?: { diagnostics?: () => string } })
      .NeckGuardianNative
    if (!api || typeof api.diagnostics !== 'function') return null
    const raw = api.diagnostics()
    if (typeof raw !== 'string' || raw.length === 0) return null
    return JSON.parse(raw) as NativeDiag
  } catch {
    return null
  }
}

/** 权限状态的用户可读描述。 */
export function describePermission(state: CameraPermissionState): string {
  switch (state) {
    case 'granted':
      return '系统权限：已授权'
    case 'denied':
      return '系统权限：本次被拒绝'
    case 'blocked':
      return '系统权限：已勾选不再询问，需到「设置 → 应用 → NeckGuardian → 权限」手动开启相机'
    default:
      return '系统权限：尚未申请'
  }
}

/**
 * 订阅原生权限变化（用户在系统对话框点了允许时自动回调）。
 * 返回取消订阅函数。
 */
export function onNativePermissionChange(cb: (state: CameraPermissionState) => void): () => void {
  const w = window as unknown as {
    __ngCameraPermissionChanged?: (s: string) => void
  }
  w.__ngCameraPermissionChanged = (s: string) => cb(s as CameraPermissionState)
  return () => {
    delete w.__ngCameraPermissionChanged
  }
}
