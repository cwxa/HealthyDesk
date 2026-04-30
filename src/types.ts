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
  type: 'pose' | 'no_pose'
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

export interface WSMessage {
  type: string
  [key: string]: unknown
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
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}
