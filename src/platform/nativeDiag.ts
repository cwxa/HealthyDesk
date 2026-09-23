import { getPlatform, getPlatformInfo, supports, type RuntimePlatform } from './runtime'

/**
 * 摄像头权限诊断通道（**按平台分发 provider**）。
 *
 * 为什么需要它：WebView 里 `getUserMedia` 失败时只给一个 `NotAllowedError`，
 * 无法区分「用户这次点了拒绝」「用户选了不再询问」「系统隐私开关拦截」。
 * 有权限状态才能给出准确的排查提示（这是 v1.3.2 排查「允许了权限却连不上摄像头」
 * 时留下的工具，别再退回到只看 `err.name`）。
 *
 * 各平台的实现方式不同：
 * - **Android**：`MainActivity` 通过 `addJavascriptInterface` 暴露**只读**的
 *   `NeckGuardianNative.diagnostics()`，直接读到系统级授权状态（`nativeDiagnostics=true`）。
 * - **iOS / Web**：没有等价的原生注入，改用 `navigator.permissions.query({name:'camera'})`
 *   推断（`source='web-permissions'`）。能力矩阵里 `nativeDiagnostics=false`，
 *   表示这是"推断"而非"直读"，界面文案上也应更保守。
 * - **桌面端**：不需要——Electron 里没有 WebView 权限层，`getUserMedia` 直接走
 *   系统权限，失败原因本身就是准确的。
 *
 * 新增平台时只需在 `collectDiag()` 里加一个分支，不必动调用方。
 */

export type CameraPermissionState = 'granted' | 'denied' | 'blocked' | 'unknown'

/** 诊断数据的来源，便于在界面/日志里区分"直读"与"推断"。 */
export type DiagSource = 'android-bridge' | 'web-permissions' | 'none'

export interface NativeDiag {
  cameraPermission: CameraPermissionState
  granted: boolean
  source: DiagSource
  platform: RuntimePlatform
  /** 安装包的 versionName（确认用户装的是哪一版） */
  version?: string
  versionCode?: number
  /** 仅安卓：系统 API level */
  sdk?: number
  manufacturer?: string
  model?: string
}

interface AndroidBridgeDiag {
  cameraPermission?: CameraPermissionState
  granted?: boolean
  version?: string
  versionCode?: number
  sdk?: number
  manufacturer?: string
  model?: string
}

/** 读取安卓注入的只读诊断信息；未注入时返回 null。 */
function readAndroidBridge(): AndroidBridgeDiag | null {
  try {
    const api = (window as unknown as { NeckGuardianNative?: { diagnostics?: () => string } })
      .NeckGuardianNative
    if (!api || typeof api.diagnostics !== 'function') return null
    const raw = api.diagnostics()
    if (typeof raw !== 'string' || raw.length === 0) return null
    return JSON.parse(raw) as AndroidBridgeDiag
  } catch {
    return null
  }
}

/**
 * 用 Permissions API 推断摄像头权限。
 *
 * ⚠️ Safari / iOS 对不认识的名字会**抛 TypeError**（而不是返回 'prompt'），
 * 所以必须整体包在 try 里；同时 `PermissionName` 的 TS 联合类型里没有 'camera'。
 */
async function queryCameraPermissionViaWeb(): Promise<CameraPermissionState> {
  try {
    const perms = navigator.permissions
    if (!perms?.query) return 'unknown'
    const status = await perms.query({ name: 'camera' as PermissionName })
    switch (status.state) {
      case 'granted':
        return 'granted'
      case 'denied':
        // Permissions API 无法区分「本次拒绝」与「不再询问」，一律按需要去设置的
        // 更保守的一档处理，避免给出"再点一次就好"的错误建议。
        return 'blocked'
      default:
        return 'unknown'
    }
  } catch {
    return 'unknown'
  }
}

/**
 * 收集当前平台的诊断信息。
 *
 * `nativeDiag()` 是同步版本：只读已经存在于内存里的信息（安卓桥）。
 * iOS / Web 的权限状态需要异步查询，用 `nativeDiagAsync()`。
 */
function buildDiag(partial: {
  cameraPermission: CameraPermissionState
  granted: boolean
  source: DiagSource
  version?: string
  versionCode?: number
  sdk?: number
  manufacturer?: string
  model?: string
}): NativeDiag {
  return {
    platform: getPlatform(),
    version: partial.version ?? appVersionFallback(),
    ...partial,
  }
}

/** 没有原生通道时用构建期注入的版本号兜底，保证界面总能显示"装的是哪一版"。 */
function appVersionFallback(): string | undefined {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined
  } catch {
    return undefined
  }
}

/** 同步读取诊断信息；当前平台没有同步通道时返回 null。 */
export function nativeDiag(): NativeDiag | null {
  const platform = getPlatform()

  if (platform === 'android') {
    const raw = readAndroidBridge()
    if (!raw) return null
    const state = raw.cameraPermission ?? 'unknown'
    return buildDiag({
      cameraPermission: state,
      granted: raw.granted ?? state === 'granted',
      source: 'android-bridge',
      version: raw.version,
      versionCode: raw.versionCode,
      sdk: raw.sdk,
      manufacturer: raw.manufacturer,
      model: raw.model,
    })
  }

  // 其余平台没有同步通道：至少把版本号带出来（构建期注入，无需原生）
  if (platform === 'ios' || platform === 'web') {
    return buildDiag({
      cameraPermission: 'unknown',
      granted: false,
      source: 'none',
    })
  }

  return null
}

/**
 * 异步读取诊断信息（推荐）。
 *
 * iOS / Web 会额外查一次 Permissions API，拿到真实的摄像头授权状态；
 * 安卓则直接复用同步桥的结果。
 */
export async function nativeDiagAsync(): Promise<NativeDiag | null> {
  const platform = getPlatform()

  if (platform === 'android') return nativeDiag()

  if (platform === 'ios' || platform === 'web') {
    const state = await queryCameraPermissionViaWeb()
    return buildDiag({
      cameraPermission: state,
      granted: state === 'granted',
      source: state === 'unknown' ? 'none' : 'web-permissions',
    })
  }

  return null
}

/** 权限状态的用户可读描述（按宿主系统给出对应的"去哪儿开权限"路径）。 */
export function describePermission(state: CameraPermissionState): string {
  const os = getPlatformInfo().os
  switch (state) {
    case 'granted':
      return '系统权限：已授权'
    case 'denied':
      return '系统权限：本次被拒绝'
    case 'blocked':
      if (os === 'ios') {
        return '系统权限：已被拒绝，需到「设置 → 隐私与安全性 → 相机」中允许 NeckGuardian'
      }
      if (os === 'macos') {
        return '系统权限：已被拒绝，需到「系统设置 → 隐私与安全性 → 相机」中允许 NeckGuardian'
      }
      return '系统权限：已勾选不再询问，需到「设置 → 应用 → NeckGuardian → 权限」手动开启相机'
    default:
      return '系统权限：尚未申请'
  }
}

/**
 * 订阅"权限可能已变化"，返回取消订阅函数。
 *
 * - **Android**：原生侧在用户点完系统对话框后回调 `window.__ngCameraPermissionChanged`。
 * - **iOS / Web**：没有原生回调。但在手机上用户去「设置」开完权限再切回来是**最常见**的
 *   修复路径，因此这里监听 `visibilitychange` / `focus` 并重新查询，
 *   状态由非 granted 变为 granted 时回调——用户切回来即自动重试，不必手动点重试按钮。
 */
export function onNativePermissionChange(cb: (state: CameraPermissionState) => void): () => void {
  const platform = getPlatform()

  if (platform === 'android' && supports('nativeDiagnostics')) {
    const w = window as unknown as { __ngCameraPermissionChanged?: (s: string) => void }
    w.__ngCameraPermissionChanged = (s: string) => cb(s as CameraPermissionState)
    return () => {
      delete w.__ngCameraPermissionChanged
    }
  }

  if (platform !== 'ios' && platform !== 'web') {
    return () => {}
  }

  let last: CameraPermissionState = 'unknown'
  let disposed = false

  const probe = async () => {
    if (disposed) return
    const state = await queryCameraPermissionViaWeb()
    if (disposed) return
    if (state !== last) {
      last = state
      cb(state)
    }
  }

  const onVisible = () => {
    if (!document.hidden) void probe()
  }

  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)
  void probe()

  return () => {
    disposed = true
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onVisible)
  }
}
