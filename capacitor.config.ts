import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 配置（移动端：Android + iOS）。
 *
 * 前端产物 `dist/` 被整体打进 Android 的 WebView / iOS 的 WKWebView 里，因此：
 * - `webDir: 'dist'` —— 指向 Vite 的构建输出目录
 * - `appId` 同时用作 Android 包名与 iOS Bundle Identifier
 *
 * 注意：桌面版 Electron 主进程入口在 `dist/main.js`（见 package.json 的 main），
 * 与 Capacitor 的 webDir 互不干扰（`CAP_BUILD=1` 时才不编译 Electron 入口）。
 */
const config: CapacitorConfig = {
  appId: 'com.neckguardian.app',
  appName: 'NeckGuardian',
  webDir: 'dist',
  // 两端统一，避免启动瞬间的白屏/黑屏闪烁
  backgroundColor: '#F5F7FA',
  android: {
    // 摄像头需要 getUserMedia；WebView 的权限请求由 MainActivity 覆写后放行
    allowMixedContent: false,
    backgroundColor: '#F5F7FA',
  },
  ios: {
    /**
     * ⚠️ 这里**故意不设** `iosScheme: 'https'`。
     *
     * iOS 上 `https` 被 WKWebView 保留给外部资源，Capacitor 无法用它托管本地资源
     * ——设成 https 会导致本地页面根本加载不出来。
     * 默认的 `capacitor://localhost` 已经**属于安全上下文**，
     * `getUserMedia` / Permissions API 都能正常工作，**不要动它**。
     *
     * ⚠️ 也**不要**给 iOS 的 hostname 加端口：iOS 15.5–16 上带端口的
     * 自定义 scheme 会让 `getUserMedia` 报 AbortError（WebKit 的已知问题，
     * `capacitor://localhost` 不带端口才正常）。
     */
    contentInset: 'never',
    backgroundColor: '#F5F7FA',
    // 键盘弹出时不要把整个 WKWebView 顶上去（页面自己处理 safe-area）
    scrollEnabled: true,
  },
  server: {
    androidScheme: 'https',
    // WebView 调试开关（Android 用 chrome://inspect，iOS 用 Safari 开发菜单）
    webContentsDebuggingEnabled: true,
  },
}

export default config
