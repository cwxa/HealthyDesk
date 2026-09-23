#!/usr/bin/env node
/**
 * 用应用自己的图标替换安卓启动图（splash）。
 *
 * 背景：Capacitor 生成安卓工程时会放一张**蓝色 Capacitor 徽标的占位启动图**。
 * 不替换的话，用户每次启动这个 App，第一眼看到的是 Capacitor 的 logo ——
 * 属于"一眼看出没做完"的东西，而且很容易被忽略（启动页只闪一下）。
 *
 * 做法：**按现有文件的尺寸原样重绘**，不去维护一张尺寸表。
 * `ios`/`android` 的启动图尺寸是按密度和横竖屏铺开的十几张，写死尺寸迟早会过期；
 * 直接读现有 PNG 的宽高再覆盖，既不会漏也不会错。
 *
 * 用法：node scripts/gen-android-splash.js
 */
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const root = path.resolve(__dirname, '..')
const resDir = path.join(root, 'android/app/src/main/res')
const iconSvgPath = path.join(root, 'public/icon.svg')

/** 与应用浅色主题一致的底色（与 iOS 启动图保持一致）。 */
const BACKGROUND = '#F5F7FA'
/** 图标占画面短边的比例。启动图上留白多一点更像原生的启动屏。 */
const LOGO_RATIO = 0.42

/** 递归找出所有 splash.png。 */
function findSplashes(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) findSplashes(p, acc)
    else if (entry.name === 'splash.png') acc.push(p)
  }
  return acc
}

async function main() {
  const files = findSplashes(resDir)
  if (files.length === 0) {
    console.error(
      `\n[android-splash] 找不到启动图。\n` +
        `  期望位置：${path.relative(root, resDir)}/**/splash.png\n` +
        `  若安卓工程还没生成，请先执行 npx cap add android。\n`,
    )
    process.exit(1)
  }
  if (!fs.existsSync(iconSvgPath)) {
    console.error(`\n[android-splash] 找不到源图标 ${path.relative(root, iconSvgPath)}\n`)
    process.exit(1)
  }

  console.log(`[android-splash] 找到 ${files.length} 张启动图，按原尺寸重绘…`)

  for (const file of files) {
    const meta = await sharp(file).metadata()
    if (!meta.width || !meta.height) {
      console.warn(`[android-splash] ⚠️ 跳过（读不到尺寸）：${path.relative(root, file)}`)
      continue
    }

    const { width, height } = meta
    const logoSize = Math.round(Math.min(width, height) * LOGO_RATIO)

    // 高密度渲染 SVG 再缩放，避免放大后发虚
    const logo = await sharp(iconSvgPath, { density: 768 })
      .resize(logoSize, logoSize)
      .png()
      .toBuffer()

    // 启动图必须铺满，因此压平到不透明底色（与 iOS 的处理一致）
    const out = await sharp({
      create: { width, height, channels: 3, background: BACKGROUND },
    })
      .composite([{ input: logo, gravity: 'center' }])
      .flatten({ background: BACKGROUND })
      .removeAlpha()
      .png()
      .toBuffer()

    fs.writeFileSync(file, out)
    console.log(
      `[android-splash] ✓ ${path.relative(resDir, file).padEnd(34)} ${width}×${height}`,
    )
  }

  console.log('[android-splash] 完成')
}

main().catch((e) => {
  console.error('[android-splash] 失败:', e)
  process.exit(1)
})
