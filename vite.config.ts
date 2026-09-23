import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import { readFileSync } from 'node:fs'
import path from 'path'

/**
 * 双目标构建配置。
 *
 * `CAP_BUILD=1` 时按**移动端**构建：不打 Electron 主进程/preload，
 * 只产出纯网页资源（dist/），交给 Capacitor 打进 APK / iOS 工程。
 * 否则按桌面端构建（默认），额外编译 electron/main.ts 与 preload.ts。
 *
 * 两者的 web 产物（index.html + assets）完全一致，差异只在
 * 「是否额外产出 Electron 入口」以及构建脚本是否补 MediaPipe 资源。
 */
const isCapBuild = process.env.CAP_BUILD === '1'

/** 构建期注入版本号，使移动端无需原生通道也能显示"装的是哪一版"。 */
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BUILD_TARGET__: JSON.stringify(isCapBuild ? 'mobile' : 'desktop'),
  },
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
