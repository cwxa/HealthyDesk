import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import path from 'path'

/**
 * 双目标构建配置。
 *
 * `CAP_BUILD=1` 时按**移动端**构建：不打 Electron 主进程/preload，
 * 只产出纯网页资源（dist/），交给 Capacitor 打进 APK。
 * 否则按桌面端构建（默认），额外编译 electron/main.ts 与 preload.ts。
 */
const isCapBuild = process.env.CAP_BUILD === '1'

export default defineConfig({
  plugins: [
    react(),
    ...(isCapBuild
      ? []
      : [
          electron([
            {
              entry: 'electron/main.ts',
              vite: {
                build: {
                  outDir: 'dist',
                  rollupOptions: { output: { entryFileNames: '[name].js' } },
                },
              },
            },
            {
              entry: 'electron/preload.ts',
              vite: {
                build: {
                  outDir: 'dist',
                  rollupOptions: { output: { entryFileNames: '[name].js' } },
                },
              },
            },
          ]),
        ]),
  ],
  base: './',
  build: {
    outDir: 'dist',
    // MediaPipe 的 wasm 体积较大，提高告警阈值避免噪音
    chunkSizeWarningLimit: 1500,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
})
