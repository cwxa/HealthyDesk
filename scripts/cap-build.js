#!/usr/bin/env node
/**
 * 移动端前端构建：设置 CAP_BUILD=1 后调用 vite build，随后把 MediaPipe 运行资源
 * 拷进 dist/mediapipe/。不依赖 cross-env，避免额外依赖。
 *
 * 为什么资源要在构建后拷贝，而不是放在 public/ 里？
 * ------------------------------------------------------------------
 * vite 会把 publicDir(public/) 的**全部**内容复制进 dist/，而桌面端
 * electron-builder.yml 又打包了整个 dist/**。若把 MediaPipe 资源放进 public/，
 * 桌面安装包会白白多出 ~28MB 只给安卓用的文件。
 * 因此这里改为：桌面构建完全不包含它们，移动端构建结束后再按需补进 dist/。
 *
 * 资源来源：
 *   - wasm：直接取 npm 依赖 @mediapipe/tasks-vision 自带的 wasm 目录（不重复入库）
 *   - 模型：mediapipe-assets/models/pose_landmarker_full.task（入库，保证离线可构建）
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const isWin = process.platform === 'win32'
const npx = isWin ? 'npx.cmd' : 'npx'

const WASM_SRC = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const MODEL_SRC = path.join(root, 'mediapipe-assets', 'models', 'pose_landmarker_full.task')
const DEST = path.join(root, 'dist', 'mediapipe')

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    shell: isWin,
    env: { ...process.env, CAP_BUILD: '1' },
  })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

/** 把 MediaPipe 运行资源补齐到 dist/mediapipe/。 */
function stageMediapipeAssets() {
  if (!fs.existsSync(WASM_SRC)) {
    console.error(
      `\n[cap-build] 找不到 ${path.relative(root, WASM_SRC)}\n` +
        `           请先执行 npm install（@mediapipe/tasks-vision 未安装）。\n`
    )
    process.exit(1)
  }
  if (!fs.existsSync(MODEL_SRC)) {
    console.error(
      `\n[cap-build] 找不到姿态模型 ${path.relative(root, MODEL_SRC)}\n` +
        `           该文件随仓库提供，请确认未被误删。\n`
    )
    process.exit(1)
  }

  const wasmDest = path.join(DEST, 'wasm')
  const modelDest = path.join(DEST, 'models')
  fs.mkdirSync(wasmDest, { recursive: true })
  fs.mkdirSync(modelDest, { recursive: true })

  // wasm：vision_wasm_internal.* 与 vision_wasm_nosimd_internal.*（SIMD / 非 SIMD 各一份）
  for (const f of fs.readdirSync(WASM_SRC)) {
    fs.copyFileSync(path.join(WASM_SRC, f), path.join(wasmDest, f))
  }
  fs.copyFileSync(MODEL_SRC, path.join(modelDest, path.basename(MODEL_SRC)))

  let total = 0
  for (const dir of [wasmDest, modelDest]) {
    for (const f of fs.readdirSync(dir)) {
      total += fs.statSync(path.join(dir, f)).size
    }
  }
  console.log(
    `[cap-build] MediaPipe 资源就绪 -> dist/mediapipe/  (${(total / 1048576).toFixed(1)} MB)`
  )
}

run(npx, ['tsc', '--noEmit'])
run(npx, ['vite', 'build'])
stageMediapipeAssets()
console.log('\n移动端前端构建完成 -> dist/')
