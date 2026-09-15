import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 配置（安卓端）。
 *
 * 前端产物 `dist/` 被整体打进 APK 的 WebView 里，因此：
 * - `webDir: 'dist'` —— 指向 Vite 的构建输出目录
 * - `appId` 用于安卓包名，`appName` 是桌面上显示的应用名
 *
 * 注意：桌面版 Electron 主进程入口在 `dist/main.js`（见 package.json 的 main），
 * 与 Capacitor 的 webDir 互不干扰。
 */
const config: CapacitorConfig = {
  appId: 'com.neckguardian.app',
  appName: 'NeckGuardian',
  webDir: 'dist',
  android: {
    // 摄像头需要 getUserMedia；WebView 的权限请求由 MainActivity 覆写后放行
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
    // WebView 调试开关（Chrome chrome://inspect 可调试 WebView 内页面）
    webContentsDebuggingEnabled: true,
  },
}

export default config
