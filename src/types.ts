export interface Landmark {
  x: number
  y: number
}

export interface Landmarks {
  nose: Landmark
  left_ear: Landmark
  right_ear: Landmark
  left_shoulder: Landmark
  right_shoulder: Landmark
  left_hip?: Landmark
  right_hip?: Landmark
}

export interface PoseResult {
  type: 'pose' | 'no_pose' | 'ready' | 'error'
  timestamp: string
  score?: number
  head_angle?: number
  shoulder_diff?: number
  spine_angle?: number
  visibility?: number
  issues?: string[]
  landmarks?: Landmarks
  message?: string
}

export interface WeeklyReport {
  posture_avg: number
  weekly_activities: number
  total_exercise_sec: number
  total_minutes: number
  total_breaks: number
  completion_rate: number
  trend: { day: string; avg_score: number }[]
}

export interface ActivityRecord {
  id: number
  timestamp: string
  activity_type: string
  exercise_count: number
  duration_sec: number
  avg_score: number
}

export interface Settings {
  reminder_interval: string
  ai_enabled: string
  auto_start: string
  voice_enabled: string
}

export interface ElectronAPI {
  getBackendUrl: () => Promise<string>
  minimizeToTray: () => Promise<void>
  quitApp: () => Promise<void>
  getAppVersion: () => Promise<string>
  onBackendReady: (callback: (data: { port: number }) => void) => void
  onStartExercise: (callback: () => void) => void
  onReminder: (callback: () => void) => void
  setAutoStart: (enabled: boolean) => Promise<void>
  /**
   * 宿主信息（由 preload 从主进程取出）。
   *
   * 桌面端要在 UI 上区分 Windows / macOS / Linux（托盘文案、快捷键提示、
   * 以及"去哪儿开摄像头权限"的路径都不同），而运行时平台同为 `electron`，
   * 光靠 `Capacitor.getPlatform()` 拿不到，必须由主进程告知。
   *
   * 可选：旧版 preload 未暴露时，runtime.ts 会退回 User-Agent 嗅探。
   */
  platform?: string
  arch?: string
  isPackaged?: boolean
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
  /**
   * 构建期注入的常量（见 vite.config.ts 的 `define`）。
   * 移动端没有可用的原生版本查询接口，靠这个显示版本号。
   */
  const __APP_VERSION__: string
  const __BUILD_TARGET__: 'desktop' | 'mobile'
}
