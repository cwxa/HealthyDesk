import { Capacitor } from '@capacitor/core'

/**
 * 运行环境判定 + 能力矩阵。
 *
 * NeckGuardian 目前运行在四种"运行时平台"上，但它们共享同一份 React 代码，
 * 差异全部收敛到本文件的**能力矩阵**里，业务组件只问能力、不问平台。
 *
 * | platform   | 形态    | 推理位置          | 数据存储        | 产物            |
 * |------------|---------|-------------------|-----------------|-----------------|
 * | `electron` | desktop | Python 后端(ws)   | 后端 SQLite     | Windows / macOS |
 * | `android`  | mobile  | WebView 内 wasm   | 本机 IndexedDB  | APK             |
 * | `ios`      | mobile  | WebView 内 wasm   | 本机 IndexedDB  | IPA             |
 * | `web`      | desktop | WebView 内 wasm   | 本机 IndexedDB  | 浏览器调试      |
 *
 * 桌面端还要区分宿主操作系统（`HostOS`）——托盘文案、快捷键提示、
 * 后端可执行文件扩展名等都与操作系统有关，而**与运行时平台无关**。
 */

export type RuntimePlatform = 'electron' | 'android' | 'ios' | 'web'
export type FormFactor = 'desktop' | 'mobile'
export type HostOS = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'unknown'

/**
 * 平台能力矩阵。
 *
 * ⚠️ 新增平台相关分支时，**先看这里有没有对应能力**，不要在上层组件里写
 * `platform === 'android'` 这类判断——那正是"多平台支持"退化成"到处打补丁"的原因。
 */
export interface PlatformCapabilities {
  /** 姿态推理跑在当前进程内（WebView 里的 MediaPipe wasm），无需后端。 */
  localInference: boolean
  /** 存在本机 HTTP/WebSocket 后端（Electron 拉起的 Python 进程）。 */
  localBackend: boolean
  /** 有系统托盘 / macOS 菜单栏图标可常驻。 */
  systemTray: boolean
  /** 支持开机自启。 */
  autoStart: boolean
  /**
   * 有**原生**权限诊断通道（能读到系统级相机授权状态，而非只能拿到
   * WebView 抛出的 `NotAllowedError`）。安卓走 `addJavascriptInterface` 桥。
   */
  nativeDiagnostics: boolean
  /** 支持系统级通知（而非只在应用内弹窗）。 */
  systemNotification: boolean
  /** 支持语音播报。 */
  speech: boolean
}

export interface PlatformInfo {
  platform: RuntimePlatform
  formFactor: FormFactor
  /** 宿主操作系统。移动端与 `platform` 相同；桌面端为 windows/macos/linux。 */
  os: HostOS
  capabilities: PlatformCapabilities
}

const CAPABILITIES: Record<RuntimePlatform, PlatformCapabilities> = {
  electron: {
    localInference: false,
    localBackend: true,
    systemTray: true,
    autoStart: true,
    nativeDiagnostics: false,
    systemNotification: true,
    speech: true,
  },
  android: {
    localInference: true,
    localBackend: false,
    systemTray: false,
    autoStart: false,
    nativeDiagnostics: true,
    systemNotification: false,
    speech: true,
  },
  ios: {
    localInference: true,
    localBackend: false,
    systemTray: false,
    autoStart: false,
    // iOS 没有等价的 JS 桥；权限状态由 web 侧 `navigator.permissions` 推断，
    // 不是原生直读，因此这里为 false（见 nativeDiag.ts 的 iOS provider）。
    nativeDiagnostics: false,
    systemNotification: false,
    speech: true,
  },
  web: {
    localInference: true,
    localBackend: false,
    systemTray: false,
    autoStart: false,
    nativeDiagnostics: false,
    systemNotification: false,
    speech: true,
  },
}

/** `process.platform` → HostOS。 */
function mapNodePlatform(p: string | undefined): HostOS {
  switch (p) {
    case 'win32':
      return 'windows'
    case 'darwin':
      return 'macos'
    case 'linux':
      return 'linux'
    case 'android':
      return 'android'
    default:
      return 'unknown'
  }
}

/** 旧版 preload 未暴露 platform 时的兜底嗅探。 */
function sniffOSFromUA(): HostOS {
  if (typeof navigator === 'undefined') return 'unknown'
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios'
  if (/Android/.test(ua)) return 'android'
  if (/Mac OS X|Macintosh/.test(ua)) return 'macos'
  if (/Windows/.test(ua)) return 'windows'
  if (/Linux/.test(ua)) return 'linux'
  return 'unknown'
}

interface ForcedOverride {
  platform?: RuntimePlatform
  os?: HostOS
}

/**
 * 解析 URL 覆盖参数（**仅供开发/预览**）。
 *
 * 用来在桌面浏览器里直接看任意平台的界面，不必真的装 APK / 编 iOS：
 *   `/?platform=android#/`   → 手机端布局 + 本地推理分支
 *   `/?platform=ios#/`       → 同上（iOS 布局与安卓一致）
 *   `/?platform=macos#/`     → 桌面端布局，但按 macOS 处理（托盘/快捷键文案）
 *   `/?platform=electron&os=windows#/`
 *
 * ⚠️ 用的是 HashRouter，**参数必须写在 `#` 之前**，否则会被路由吃掉。
 */
function readForcedOverride(): ForcedOverride {
  if (typeof window === 'undefined') return {}
  let params: URLSearchParams
  try {
    params = new URLSearchParams(window.location.search)
  } catch {
    return {}
  }
  const out: ForcedOverride = {}

  const p = params.get('platform')
  if (p === 'electron' || p === 'android' || p === 'ios' || p === 'web') {
    out.platform = p
  } else if (p === 'windows' || p === 'macos' || p === 'linux') {
    // 便利写法：直接写桌面操作系统，等价于 platform=electron & os=<p>
    out.platform = 'electron'
    out.os = p
  }

  const os = params.get('os')
  if (os === 'windows' || os === 'macos' || os === 'linux' || os === 'android' || os === 'ios') {
    out.os = os
  }

  return out
}

function resolvePlatformInfo(): PlatformInfo {
  const forced = readForcedOverride()

  let platform: RuntimePlatform
  if (forced.platform) {
    platform = forced.platform
  } else if (typeof window !== 'undefined' && window.electronAPI) {
    platform = 'electron'
  } else {
    const native = Capacitor.getPlatform() // 'android' | 'ios' | 'web'
    platform = native === 'android' || native === 'ios' ? native : 'web'
  }

  let os: HostOS
  if (forced.os) {
    os = forced.os
  } else if (platform === 'electron') {
    os = mapNodePlatform(
      typeof window !== 'undefined' ? window.electronAPI?.platform : undefined,
    )
    if (os === 'unknown') os = sniffOSFromUA()
  } else if (platform === 'web') {
    // 纯浏览器调试：宿主系统对业务逻辑没有影响，保持 unknown（不猜）。
    os = 'unknown'
  } else {
    os = platform
  }

  return {
    platform,
    formFactor: platform === 'android' || platform === 'ios' ? 'mobile' : 'desktop',
    os,
    capabilities: CAPABILITIES[platform],
  }
}

let cached: PlatformInfo | null = null

/**
 * 读取平台信息（带缓存）。
 *
 * 缓存的理由：`isMobile()` 在每次渲染都会被调用，而解析里含 URL 解析与 UA 嗅探。
 * 平台在一次会话内不会变，缓存是安全的。
 */
export function getPlatformInfo(): PlatformInfo {
  if (!cached) cached = resolvePlatformInfo()
  return cached
}

/** 仅测试用：清掉缓存，让下次调用重新解析。 */
export function __resetPlatformCache(): void {
  cached = null
}

/** 运行时平台。 */
export function getPlatform(): RuntimePlatform {
  return getPlatformInfo().platform
}

/** 宿主操作系统（桌面端才有意义）。 */
export function getHostOS(): HostOS {
  return getPlatformInfo().os
}

/** 形态：桌面 / 移动。 */
export function getFormFactor(): FormFactor {
  return getPlatformInfo().formFactor
}

/** 是否运行在移动端（安卓 / iOS）。 */
export function isMobile(): boolean {
  return getPlatformInfo().formFactor === 'mobile'
}

/** 是否运行在桌面端（Electron，含 Windows / macOS / Linux）。 */
export function isDesktop(): boolean {
  return getPlatformInfo().formFactor === 'desktop'
}

/**
 * 是否存在可用的本地后端服务。
 *
 * 桌面版由 Electron 主进程拉起 Python 后端，因此为 true；
 * 移动端/纯浏览器没有后端，姿态推理与数据存储改由前端本地实现。
 */
export function hasLocalBackend(): boolean {
  return getPlatformInfo().capabilities.localBackend
}

/** 查询某项平台能力。 */
export function supports<K extends keyof PlatformCapabilities>(cap: K): boolean {
  return getPlatformInfo().capabilities[cap]
}

/** 平台的中文展示名，用于设置页/关于页。 */
export function platformLabel(): string {
  const { platform, os } = getPlatformInfo()
  switch (platform) {
    case 'electron':
      return os === 'macos' ? '桌面版 (macOS)' : os === 'linux' ? '桌面版 (Linux)' : '桌面版 (Windows)'
    case 'android':
      return '安卓版'
    case 'ios':
      return 'iOS 版'
    default:
      return '网页版'
  }
}
