#!/usr/bin/env node
/**
 * 统一设置/递增版本号（**单一入口**）。
 *
 * 版本号散落在五个地方，漏改一处就会出现"设置页显示的版本和安装包对不上"
 * 或"安卓装了覆盖不上"这类现象，而且都很难一眼看出来：
 *
 *   1. package.json                      —— electron-builder / 前端构建期注入（__APP_VERSION__）
 *   2. backend/config.py  APP_VERSION    —— 后端 /api/health 与 /api/settings 的版本
 *   3. src/pages/Settings.tsx 兜底字符串  —— 拿不到原生版本时设置页显示的版本
 *   4. android/app/build.gradle          —— versionName + versionCode（安卓强制要求递增）
 *   5. ios/App/App.xcodeproj             —— MARKETING_VERSION + CURRENT_PROJECT_VERSION
 *
 * 用法：
 *   node scripts/set-version.js 1.4.0              # 改版本号；版本变了则自动 +1 versionCode
 *   node scripts/set-version.js 1.4.0 --code=10    # 显式指定 versionCode
 *   node scripts/set-version.js --dry-run 1.4.0    # 只看会改什么，不落盘
 *   node scripts/set-version.js --check            # 只校验五处是否一致（CI 用，不一致则 exit 1）
 *
 * 脚本只做精确文本替换并**回读校验**，不做 AST 改写 —— 这五个文件的这一段
 * 都是稳定的一行，正则比引入解析器更可控。
 */
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')

/** 五处版本号的权威读取（--check 与 --dry-run 共用）。 */
const VERSION_SOURCES = [
  {
    file: 'package.json',
    label: 'package.json version',
    read: () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).version,
  },
  {
    file: 'backend/config.py',
    label: 'APP_VERSION',
    read: () => {
      const m = /APP_VERSION\s*=\s*"([^"]+)"/.exec(
        fs.readFileSync(path.join(root, 'backend/config.py'), 'utf-8'),
      )
      return m ? m[1] : null
    },
  },
  {
    file: 'src/pages/Settings.tsx',
    label: 'appVersion 兜底',
    read: () => {
      const m = /appVersion \|\| '([\d.]+)'/.exec(
        fs.readFileSync(path.join(root, 'src/pages/Settings.tsx'), 'utf-8'),
      )
      return m ? m[1] : null
    },
  },
  {
    file: 'android/app/build.gradle',
    label: 'versionName',
    read: () => {
      const m = /versionName\s+"([^"]+)"/.exec(
        fs.readFileSync(path.join(root, 'android/app/build.gradle'), 'utf-8'),
      )
      return m ? m[1] : null
    },
  },
]

function parseArgs(argv) {
  const args = { positional: [], code: null, dryRun: false, check: false }
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--check') args.check = true
    else {
      const m = /^--code=(\d+)$/.exec(a)
      if (m) args.code = parseInt(m[1], 10)
      else args.positional.push(a)
    }
  }
  return args
}

/** iOS 的版本在 pbxproj 里（可能尚未接入），单独读，缺失不算错。 */
function readIosVersion() {
  const rel = 'ios/App/App.xcodeproj/project.pbxproj'
  const abs = path.join(root, rel)
  if (!fs.existsSync(abs)) return { file: rel, label: 'MARKETING_VERSION', read: () => null }
  return {
    file: rel,
    label: 'MARKETING_VERSION',
    read: () => {
      const m = /MARKETING_VERSION = ([\d.]+);/.exec(fs.readFileSync(abs, 'utf-8'))
      return m ? m[1] : null
    },
  }
}

/**
 * 校验五处版本号是否完全一致。
 * 版本号一旦对不上，表现是"设置页显示的版本和安装包不同"或"安卓覆盖安装失败"，
 * 都属于事后极难定位的那类问题，所以在 CI 里直接拦住。
 */
function checkSync() {
  const sources = [...VERSION_SOURCES, readIosVersion()]
  const rows = sources.map((s) => ({ ...s, value: s.read() }))
  const present = rows.filter((r) => r.value !== null)

  console.log('版本号一致性检查：')
  for (const r of rows) {
    console.log(`  ${r.value === null ? '—' : r.value === present[0].value ? '✓' : '✗'}  ${r.file}  (${r.label}) = ${r.value ?? '(未找到)'}`)
  }

  if (present.length === 0) {
    console.error('\n✗ 五处都读不到版本号，脚本可能已与项目结构脱节。')
    return 1
  }

  const distinct = [...new Set(present.map((r) => r.value))]
  if (distinct.length > 1) {
    console.error(
      `\n✗ 版本号不一致：${distinct.join(' / ')}\n` +
        `  执行 node scripts/set-version.js <版本> 统一。\n`,
    )
    return 1
  }

  const missing = rows.filter((r) => r.value === null).map((r) => r.file)
  if (missing.length) {
    console.warn(`\n⚠️ 以下位置未找到版本号（生成产物未提交或结构有变）：${missing.join(', ')}`)
  }

  console.log(`\n✓ 五处版本号一致：${distinct[0]}`)
  return 0
}

const VERSION_RE = /^\d+\.\d+\.\d+$/

/** 记录每处该怎么改，统一在执行前打印一遍。 */
const edits = []

function plan(file, description, before, after, apply) {
  edits.push({ file, description, before, after, apply })
}

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf-8')
}

/** 用正则替换并断言真的替换到了（替换不到就报错，避免静默没改）。 */
function replaceOnce(content, regex, replacement, label) {
  if (!regex.test(content)) throw new Error(`${label}：未匹配到目标内容`)
  return content.replace(regex, replacement)
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.check) {
    process.exitCode = checkSync()
    return
  }

  const next = args.positional[0]
  if (!next || !VERSION_RE.test(next)) {
    console.error('用法：node scripts/set-version.js <x.y.z> [--code=N] [--dry-run]')
    console.error('      node scripts/set-version.js --check')
    process.exit(1)
  }

  // ---- 读取当前状态 ----
  const pkgRaw = read('package.json')
  const current = JSON.parse(pkgRaw).version

  const gradleRaw = read('android/app/build.gradle')
  const codeMatch = /versionCode\s+(\d+)/.exec(gradleRaw)
  if (!codeMatch) throw new Error('android/app/build.gradle：找不到 versionCode')
  const currentCode = parseInt(codeMatch[1], 10)

  // 版本变了才递增 versionCode（保证脚本可重复执行而不"每次都加一"）
  const versionChanged = current !== next
  const nextCode = args.code ?? (versionChanged ? currentCode + 1 : currentCode)

  console.log(`版本：${current} → ${next}`)
  console.log(`安卓 versionCode：${currentCode} → ${nextCode}${versionChanged ? '（版本变更自动递增）' : '（版本未变，保持不变）'}`)
  console.log('')

  // ---- 1. package.json ----
  plan('package.json', 'version', `"version": "${current}"`, `"version": "${next}"`, () =>
    replaceOnce(pkgRaw, /"version":\s*"[^"]+"/, `"version": "${next}"`, 'package.json'),
  )

  // ---- 2. backend/config.py ----
  const cfgRaw = read('backend/config.py')
  const cfgMatch = /APP_VERSION\s*=\s*"([^"]+)"/.exec(cfgRaw)
  if (!cfgMatch) throw new Error('backend/config.py：找不到 APP_VERSION')
  plan('backend/config.py', 'APP_VERSION', cfgMatch[1], next, () =>
    replaceOnce(cfgRaw, /APP_VERSION\s*=\s*"[^"]+"/, `APP_VERSION = "${next}"`, 'backend/config.py'),
  )

  // ---- 3. src/pages/Settings.tsx（兜底字符串） ----
  const settingsRaw = read('src/pages/Settings.tsx')
  const stMatch = /appVersion \|\| '([\d.]+)'/.exec(settingsRaw)
  if (!stMatch) throw new Error("src/pages/Settings.tsx：找不到 appVersion 兜底字符串")
  if (stMatch[1] !== current) {
    console.warn(
      `⚠️ Settings.tsx 兜底版本(${stMatch[1]}) 与 package.json(${current}) 本就不一致，按 package.json 为准修正`,
    )
  }
  plan('src/pages/Settings.tsx', 'appVersion 兜底', stMatch[1], next, () =>
    replaceOnce(settingsRaw, /appVersion \|\| '[\d.]+'/, `appVersion || '${next}'`, 'Settings.tsx'),
  )

  // ---- 4. android/app/build.gradle ----
  plan(
    'android/app/build.gradle',
    'versionName / versionCode',
    `${codeMatch[1]} / ${/versionName\s+"([^"]+)"/.exec(gradleRaw)?.[1]}`,
    `${nextCode} / ${next}`,
    () => {
      let out = replaceOnce(gradleRaw, /versionCode\s+\d+/, `versionCode ${nextCode}`, 'build.gradle versionCode')
      out = replaceOnce(out, /versionName\s+"[^"]+"/, `versionName "${next}"`, 'build.gradle versionName')
      return out
    },
  )

  // ---- 5. ios/App/App.xcodeproj/project.pbxproj ----
  const pbxRel = 'ios/App/App.xcodeproj/project.pbxproj'
  let pbxRaw = null
  try {
    pbxRaw = read(pbxRel)
  } catch {
    console.warn(`⚠️ 未找到 ${pbxRel}（iOS 尚未接入？），跳过`)
  }
  if (pbxRaw) {
    const mvCount = (pbxRaw.match(/MARKETING_VERSION = [\d.]+;/g) || []).length
    const cvMatch = /CURRENT_PROJECT_VERSION = (\d+);/.exec(pbxRaw)
    plan(
      pbxRel,
      `MARKETING_VERSION ×${mvCount} / CURRENT_PROJECT_VERSION`,
      `${cvMatch ? cvMatch[1] : '?'}`,
      `${next} / ${nextCode}`,
      () => {
        let out = pbxRaw.replace(/MARKETING_VERSION = [\d.]+;/g, `MARKETING_VERSION = ${next};`)
        out = out.replace(/CURRENT_PROJECT_VERSION = \d+;/g, `CURRENT_PROJECT_VERSION = ${nextCode};`)
        return out
      },
    )
  }

  // ---- 打印计划 ----
  for (const e of edits) {
    console.log(`  ${e.file}`)
    console.log(`    ${e.description}: ${e.before} → ${e.after}`)
  }

  if (args.dryRun) {
    console.log('\n[dry-run] 未写入任何文件')
    return
  }

  // ---- 落盘 ----
  for (const e of edits) {
    const abs = path.join(root, e.file)
    fs.writeFileSync(abs, e.apply())
  }

  // ---- 回读校验（确认五处真的都写进去了） ----
  const problems = []
  const expect = [
    ['package.json', () => JSON.parse(read('package.json')).version === next],
    ['backend/config.py', () => read('backend/config.py').includes(`APP_VERSION = "${next}"`)],
    ['src/pages/Settings.tsx', () => read('src/pages/Settings.tsx').includes(`appVersion || '${next}'`)],
    [
      'android/app/build.gradle',
      () => {
        const g = read('android/app/build.gradle')
        return g.includes(`versionCode ${nextCode}`) && g.includes(`versionName "${next}"`)
      },
    ],
  ]
  if (pbxRaw) {
    expect.push([
      pbxRel,
      () => {
        const p = read(pbxRel)
        return p.includes(`MARKETING_VERSION = ${next};`) && p.includes(`CURRENT_PROJECT_VERSION = ${nextCode};`)
      },
    ])
  }

  for (const [file, ok] of expect) {
    if (!ok()) problems.push(file)
  }

  if (problems.length) {
    console.error(`\n✗ 回读校验失败，以下文件未按预期更新：\n  ${problems.join('\n  ')}`)
    process.exit(1)
  }

  console.log(`\n✓ 版本号已统一为 ${next}（versionCode/build ${nextCode}），共 ${edits.length} 处`)
}

try {
  main()
} catch (e) {
  console.error(`✗ ${e.message}`)
  process.exit(1)
}
