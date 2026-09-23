#!/usr/bin/env node
/**
 * 生成 Apple 平台（macOS + iOS）专用图标。
 *
 * 为什么需要单独一个脚本：
 * - **`.icns`**：macOS 应用图标格式。`iconutil` 只有 macOS 才有，本机（Windows）
 *   生成不了；而 electron-builder 在 Windows 上也没有可靠的 png→icns 转换路径。
 *   这里直接按 Apple 的 ICNS 容器格式打包 —— 本质就是「文件头 + 若干
 *   (OSType, 长度, PNG 数据) 块」，现代 macOS（10.7+）的块内容就是 PNG 本身，
 *   不需要任何 Apple 专有工具。
 * - **菜单栏 template 图**：macOS 菜单栏图标必须是**纯黑 + alpha**的"模板图"，
 *   系统才会按菜单栏明暗自动反色。彩色图标在深色菜单栏下会糊成一团。
 *   尺寸也必须控制在 16pt（另配 @2x 供 Retina），不能像 Win/Linux 那样用 64px。
 * - **iOS AppIcon**：Xcode 的 asset catalog 要求 1024×1024 且**不能有 alpha 通道**
 *   （透明图标会被 App Store 校验直接拒掉）。所以这里要把它压到不透明背景上。
 *
 * 产物：
 *   public/icon.icns                         macOS 应用图标（electron-builder 的 mac.icon）
 *   public/tray-iconTemplate.png             菜单栏图标 @1x (16×16)
 *   public/tray-iconTemplate@2x.png          菜单栏图标 @2x (32×32)
 *   ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png
 *                                            iOS 应用图标 (1024×1024，不透明)
 */
const fs = require('fs')
const path = require('path')
const sharp = require('sharp')

const root = path.resolve(__dirname, '..')
const publicDir = path.join(root, 'public')
const iconSvgPath = path.join(publicDir, 'icon.svg')

/** iOS 图标需要的不透明底色（与应用浅色主题一致）。 */
const IOS_ICON_BACKGROUND = '#F5F7FA'

/**
 * 菜单栏图标源（单色）。
 *
 * 勾线/实心块一律用纯黑 `#000`——模板图靠 alpha 通道成形，颜色由系统决定，
 * 这里写白或绿都会在反色时出错。留一点内边距，避免贴菜单栏边缘。
 */
const TRAY_TEMPLATE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <circle cx="8" cy="5.1" r="3.3" fill="#000"/>
  <rect x="6.7" y="8.4" width="2.6" height="3.1" rx="1.1" fill="#000"/>
  <path d="M 2.7 13.5 Q 8 11.7 13.3 13.5" stroke="#000" stroke-width="1.5"
        fill="none" stroke-linecap="round"/>
</svg>
`

/**
 * ICNS 块的 OSType → 边长。
 * 现代 macOS 的块内容直接是 PNG（10.7+），因此不需要 RGB/JPEG 那套老格式。
 */
const ICNS_CHUNKS = [
  { type: 'icp4', size: 16 },
  { type: 'icp5', size: 32 },
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 }, // 512@2x，Retina 下真正生效的那张
]

/** 把若干 PNG 块打成 ICNS 容器。 */
function packIcns(chunks) {
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')

  const body = Buffer.concat(
    chunks.map(({ type, png }) => {
      const chunkHeader = Buffer.alloc(8)
      chunkHeader.write(type, 0, 'ascii')
      // 长度字段含自身的 8 字节头
      chunkHeader.writeUInt32BE(png.length + 8, 4)
      return Buffer.concat([chunkHeader, png])
    }),
  )

  header.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([header, body])
}

/** 反解 ICNS，用于自检（本机没有 macOS，只能靠结构校验保证不是坏文件）。 */
function parseIcns(buf) {
  if (buf.toString('ascii', 0, 4) !== 'icns') throw new Error('缺少 icns magic')
  const declared = buf.readUInt32BE(4)
  if (declared !== buf.length) {
    throw new Error(`总长度字段 ${declared} 与实际 ${buf.length} 不符`)
  }
  const out = []
  let off = 8
  while (off < buf.length) {
    const type = buf.toString('ascii', off, off + 4)
    const len = buf.readUInt32BE(off + 4)
    if (len < 8 || off + len > buf.length) throw new Error(`块 ${type} 长度非法: ${len}`)
    out.push({ type, png: buf.subarray(off + 8, off + len) })
    off += len
  }
  return out
}

async function generate() {
  console.log('[apple-icons] 开始生成 macOS 图标…')

  // ---- 1. icon.icns ----
  const chunks = []
  for (const { type, size } of ICNS_CHUNKS) {
    const png = await sharp(iconSvgPath, { density: 384 }).resize(size, size).png().toBuffer()
    chunks.push({ type, png })
  }

  const icns = packIcns(chunks)
  const icnsPath = path.join(publicDir, 'icon.icns')
  fs.writeFileSync(icnsPath, icns)

  // 自检：重新解析并确认每块都是能解码的 PNG，且尺寸符合预期
  const parsed = parseIcns(fs.readFileSync(icnsPath))
  if (parsed.length !== ICNS_CHUNKS.length) {
    throw new Error(`回读块数不符：${parsed.length} != ${ICNS_CHUNKS.length}`)
  }
  for (let i = 0; i < parsed.length; i++) {
    const meta = await sharp(parsed[i].png).metadata()
    const expected = ICNS_CHUNKS[i].size
    if (meta.format !== 'png' || meta.width !== expected || meta.height !== expected) {
      throw new Error(
        `块 ${parsed[i].type} 校验失败：期望 ${expected}×${expected} PNG，` +
          `实际 ${meta.format} ${meta.width}×${meta.height}`,
      )
    }
  }
  console.log(
    `[apple-icons] ✓ icon.icns  ${(icns.length / 1024).toFixed(1)} KB ` +
      `(块：${ICNS_CHUNKS.map((c) => c.type).join(', ')})`,
  )

  // ---- 2. 菜单栏 template 图（@1x / @2x） ----
  for (const [suffix, size] of [
    ['', 16],
    ['@2x', 32],
  ]) {
    const out = path.join(publicDir, `tray-iconTemplate${suffix}.png`)
    const png = await sharp(Buffer.from(TRAY_TEMPLATE_SVG), { density: 384 })
      .resize(size, size)
      .png()
      .toBuffer()
    fs.writeFileSync(out, png)
    console.log(`[apple-icons] ✓ ${path.basename(out)}  ${size}×${size}`)
  }

  // ---- 3. iOS AppIcon（1024×1024，必须不透明） ----
  const iosIconPath = path.join(
    root,
    'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png',
  )
  if (fs.existsSync(path.dirname(iosIconPath))) {
    // ⚠️ flatten 到不透明底色 + 强制去掉 alpha 通道：
    //    App Store 校验明确拒绝"含 alpha 通道"的图标，只去掉视觉透明是不够的
    //    （通道存在就会被拒），所以两个都要做。
    const foreground = await sharp(iconSvgPath, { density: 768 })
      .resize(760, 760)   // 四周留白，避免图形贴边
      .png()
      .toBuffer()

    const png = await sharp({
      create: {
        width: 1024,
        height: 1024,
        channels: 3,                       // 3 通道 = 无 alpha
        background: IOS_ICON_BACKGROUND,
      },
    })
      .composite([{ input: foreground, gravity: 'center' }])
      .flatten({ background: IOS_ICON_BACKGROUND })
      .removeAlpha()
      .png()
      .toBuffer()

    fs.writeFileSync(iosIconPath, png)

    // 自检：确认真的是 1024×1024 且没有 alpha 通道
    const meta = await sharp(iosIconPath).metadata()
    if (meta.width !== 1024 || meta.height !== 1024) {
      throw new Error(`iOS 图标尺寸不对：${meta.width}×${meta.height}`)
    }
    if (meta.hasAlpha) {
      throw new Error('iOS 图标仍带 alpha 通道 —— App Store 校验会拒绝')
    }
    console.log(
      `[apple-icons] ✓ ios AppIcon  1024×1024 无 alpha  (${(png.length / 1024).toFixed(0)} KB)`,
    )
  } else {
    console.log('[apple-icons] – 跳过 iOS 图标（ios/ 工程尚未生成）')
  }

  // ---- 4. iOS 启动图（LaunchScreen） ----
  // ⚠️ Capacitor 模板自带的是**蓝色 Capacitor 占位图**，用户一打开就看到 ——
  //    属于"一眼看出是半成品"的东西。这里替换成应用自己的图标 + 主题底色。
  const splashDir = path.join(root, 'ios/App/App/Assets.xcassets/Splash.imageset')
  if (fs.existsSync(splashDir)) {
    // LaunchScreen 会把这张图按 aspect-fit 铺满整屏，所以做成"背景色 + 居中图标"
    const logo = await sharp(iconSvgPath, { density: 768 }).resize(900, 900).png().toBuffer()
    const splash = await sharp({
      create: {
        width: 2732,
        height: 2732,
        channels: 3,
        background: IOS_ICON_BACKGROUND,
      },
    })
      .composite([{ input: logo, gravity: 'center' }])
      .flatten({ background: IOS_ICON_BACKGROUND })
      .removeAlpha()
      .png()
      .toBuffer()

    // Contents.json 里 1x/2x/3x 引用了三个文件名，全部要写
    for (const name of [
      'splash-2732x2732.png',
      'splash-2732x2732-1.png',
      'splash-2732x2732-2.png',
    ]) {
      fs.writeFileSync(path.join(splashDir, name), splash)
    }
    console.log(
      `[apple-icons] ✓ ios LaunchScreen  2732×2732 ×3  (${(splash.length / 1024).toFixed(0)} KB)`,
    )
  } else {
    console.log('[apple-icons] – 跳过 iOS 启动图（ios/ 工程尚未生成）')
  }

  console.log('[apple-icons] 完成')
}

generate().catch((e) => {
  console.error('[apple-icons] 失败:', e)
  process.exit(1)
})
