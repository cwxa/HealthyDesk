/**
 * 动作库守卫（ROADMAP-SCORING **S7**）—— 钉住「动作库是唯一数据源」这件事。
 *
 * 用法：node scripts/verify-exercises.mjs
 *
 * ## 为什么需要它
 *
 * S7 把 7 个动作从 `components/ExercisePanel.tsx` 搬进了 `src/data/exercises.ts`，
 * 并把引导动画从「按**下标** `switch`」改成「数据选参数、组件会画图」。
 * 这类重构的危险在于**它看起来什么都没发生**：
 *
 *   - 搬错一个 `duration` → 总时长从 82 秒变成别的值，界面照常跑；
 *   - 调换两条顺序 → 用户做的动作序列变了，没人会注意到；
 *   - 把某个 `measurable` 搬反 → 用户会被"没检测到动作"冤枉（S2 刚修掉的那类缺陷）；
 *   - 悄悄把动画参数改了一点 → 视觉变化，测试全绿；
 *   - 有人以后又把动作名写回组件里 / 又在下标上 `switch` → 数据化当场退化。
 *
 * 所以守卫做三件事：**逐项快照对拍**（重构不改行为的证据）、
 * **源码守卫**（防退化）、**结构断言**（数据自身要自洽）。
 *
 * ## 判据：真实源码，不是副本
 *
 * `EXERCISES` 由 esbuild **bundle 真实源码**后读取（与 `verify-scoring` /
 * `verify-exercise-quality` 同一套做法）。用正则去解析那个数组等于验副本 ——
 * 副本会与源码各错各的，测试还全绿（本项目明令禁止）。
 *
 * ## 剥注释用的是真解析器，不是正则
 *
 * 源码守卫要区分「注释里提到动作名」（正当）与「代码里写死动作名」（违规）。
 * 正则剥注释在本项目**已经栽过**：`/\s*#.*$/` 在 CRLF 行上静默不匹配
 * （`.` 不匹配 `\r`、非 multiline 的 `$` 只匹配串尾），本机检出 CRLF、CI 检出 LF
 * → 同一条守卫**本机红、CI 绿**（见 DEVELOPMENT.md 铁律 #40）。
 * 这里改用 TypeScript 自己的解析器 `removeComments`，**从构造上**绕开换行符差异，
 * 并额外用一段合成样本做**灵敏度自检**：代码里的字面量必须留下、注释里的必须消失。
 */
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const require = createRequire(join(ROOT, 'package.json'))

/** 动作库数据模块 —— 唯一允许出现动作名的地方。 */
const DATA_REL = 'src/data/exercises.ts'
/** 必须通过数据模块取动作的消费者（防止有人把数组搬回组件里）。 */
const CONSUMERS = [
  'src/components/ExercisePanel.tsx',
  'src/components/ExerciseGuide.tsx',
  'src/pages/NeckActivity.tsx',
]

let failed = false
let warned = 0
const fail = (msg) => {
  console.error(`✗ ${msg}`)
  failed = true
}
const ok = (msg) => console.log(`✓ ${msg}`)
const warn = (msg) => {
  console.warn(`⚠ ${msg}`)
  warned++
}

/**
 * 唯一的收尾出口。
 *
 * 🔴 **所有提前返回都必须走这里**。一条"打印了 ✗ 却 `exit 0`"的守卫就是**假绿**：
 * CI 会报通过，而它其实什么都没守住。本轮变异测试 M7 实测踩到这个坑 ——
 * `requireStripper()` 里调了 `fail()` 之后**直接 `return`**，把末尾的 `exit(1)`
 * 整个绕过去了（断言确实报了错，退出码却是 0）。
 */
function finish(count) {
  console.log('')
  if (failed) {
    console.error('✗ 动作库守卫未通过')
    process.exit(1)
  }
  console.log(
    `✓ 动作库成立：${count} 个动作数据化、顺序与总时长（${BEFORE_TOTAL_SEC}s）逐项不变、` +
      `引导参数等价、动作名只出现在数据文件里` +
      (warned ? `（⚠ ${warned} 条告警，见上）` : ''),
  )
}

// ─────────────────────────────────────────────────────────────
// 改造前的逐项记录（快照）
// ─────────────────────────────────────────────────────────────

/**
 * 🔴 **改造前就存在的值** —— 逐项必须一字不变。
 *
 * 来源（不是凭记忆写的）：`git show v1.6.1:src/components/ExercisePanel.tsx`
 * 里那个硬编码数组。`duration` 之和必须仍是 **82 秒**（12×6 + 10）。
 */
const BEFORE = [
  { name: '颈部左侧屈', hint: '头向左肩倾斜，感受右侧颈部拉伸', duration: 12, icon: '↩', color: '#4CAF50', kind: 'hold', min_cycles: 0, measurable: true },
  { name: '颈部右侧屈', hint: '头向右肩倾斜，感受左侧颈部拉伸', duration: 12, icon: '↪', color: '#66BB6A', kind: 'hold', min_cycles: 0, measurable: true },
  { name: '颈部左转', hint: '缓慢向左转头，保持双肩放松', duration: 12, icon: '⬅', color: '#2196F3', kind: 'hold', min_cycles: 0, measurable: false },
  { name: '颈部右转', hint: '缓慢向右转头，保持双肩放松', duration: 12, icon: '➡', color: '#42A5F5', kind: 'hold', min_cycles: 0, measurable: false },
  { name: '肩部环绕', hint: '双肩向后画圈，幅度尽量大', duration: 12, icon: '⭕', color: '#FF9800', kind: 'cyclic', min_cycles: 3, measurable: true },
  { name: '扩胸运动', hint: '双手后伸，挺胸抬头', duration: 12, icon: '🤲', color: '#9C27B0', kind: 'cyclic', min_cycles: 3, measurable: false },
  { name: '头部后缩', hint: '收下巴向后平移，像做双下巴', duration: 10, icon: '⬇', color: '#00BCD4', kind: 'hold', min_cycles: 0, measurable: false },
]
const BEFORE_TOTAL_SEC = 82

/**
 * 🔴 **id 与位置的绑定**（id 本身是 S7 新增的，但它是列表 key 与埋点的**稳定契约**：
 * 换个位置就等于换了埋点口径，调换两个 id 更是直接把统计串到另一个动作上）。
 * 所以钉住"第 i 个位置的 id 是什么"，而不只是"这 7 个 id 都存在"。
 */
const IDS = [
  'neck-flex-left',
  'neck-flex-right',
  'neck-rotate-left',
  'neck-rotate-right',
  'shoulder-circles',
  'chest-opener',
  'chin-tuck',
]

/**
 * 🔴 **改造前引导动画的参数** —— 数据化之后必须逐参数等价。
 *
 * 来源：`git show v1.6.1:src/components/ExerciseGuide.tsx` 的 `getHeadMotion`
 * 与 `DirectionArrow` 两个 `switch(index)`。
 *
 * `xScalar` / `yScalar` 不是"顺手记的小抄"，而是**动画语义**：
 * 旧代码里 `x: baseX`（标量）表示不动、`x: [baseX, …]`（数组）表示来回动。
 * 现在的实现用「关键帧长度为 1 → 输出标量」复现这条区分，所以必须断言
 * `(x.length === 1) === xScalar`，否则"不动"会变成"原地抖一下"。
 */
const BEFORE_GUIDE = [
  { name: '颈部左侧屈', cycleSec: 2, x: [0, -1, 0], y: [0], xScalar: false, yScalar: true, arrow: { kind: 'straight', dir: 'left' } },
  { name: '颈部右侧屈', cycleSec: 2, x: [0, 1, 0], y: [0], xScalar: false, yScalar: true, arrow: { kind: 'straight', dir: 'right' } },
  { name: '颈部左转', cycleSec: 2.2, x: [0], y: [0], rotate: [-18, 18, -18], xScalar: true, yScalar: true, arrow: { kind: 'arc', from: 30, to: 150, dir: 'ccw' } },
  { name: '颈部右转', cycleSec: 2.2, x: [0], y: [0], rotate: [18, -18, 18], xScalar: true, yScalar: true, arrow: { kind: 'arc', from: 150, to: 30, dir: 'cw' } },
  { name: '肩部环绕', cycleSec: 2.5, x: [0, 0.5, -0.5, 0], y: [0, -0.3, -0.3, 0], xScalar: false, yScalar: false, arrow: { kind: 'ring' } },
  { name: '扩胸运动', cycleSec: 2.4, x: [0], y: [0, -0.5, 0], rotate: [0, -8, 0], xScalar: true, yScalar: false, arrow: { kind: 'straight', dir: 'up' } },
  { name: '头部后缩', cycleSec: 1.8, x: [0], y: [0, 0.4, 0], xScalar: true, yScalar: false, arrow: { kind: 'straight', dir: 'down' } },
]

/**
 * 新增的 `target` 映射 —— **没有"改造前"可对**，所以它是"新决定"，不是"不许变"。
 * 钉住它是为了防止有人为了凑覆盖率偷偷改映射（改映射要连着改这张表并在提交信息里说明）。
 */
const TARGETS = ['head', 'head', 'head', 'head', 'shoulder', 'shoulder', 'spine']

/** 文档里写的"每维度 ≥2"目标（低于它要显式告警，见文件尾）。 */
const TARGET_MIN = 2

// ─────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────

const count = (haystack, needle) => haystack.split(needle).length - 1

/** 递归收集 `src/**` 下的 .ts / .tsx。 */
function collectSources(dir = join(ROOT, 'src'), acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) collectSources(full, acc)
    else if (name.endsWith('.ts') || name.endsWith('.tsx')) acc.push(full)
  }
  return acc
}

/** 用真实 TS 解析器剥注释（比正则可靠：不受 CRLF/LF 差异影响）。 */
function stripComments(source) {
  let ts
  try {
    ts = require('typescript')
  } catch {
    return null
  }
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.Preserve, removeComments: true },
    fileName: 'strip.tsx',
  }).outputText
}

/** 把前端真实源码 bundle 出来，拿 `src/data/exercises.ts` 的导出。 */
async function loadData() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    console.error(`✗ 找不到 esbuild（vite 的依赖）。请先 npm install。`)
    process.exit(1)
  }
  const built = await esbuild.build({
    stdin: {
      contents: `import * as ex from './exercises'\nexport const __ex = ex\n`,
      resolveDir: join(ROOT, 'src', 'data'),
      loader: 'ts',
      sourcefile: 'exercises-entry.ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
  })
  const out = join(tmpdir(), `neckguardian-exercises-${process.pid}.mjs`)
  writeFileSync(out, built.outputFiles[0].text)
  const mod = await import(pathToFileURL(out).href)
  try {
    unlinkSync(out)
  } catch {
    /* 删除失败不影响校验结果 */
  }
  return mod.__ex
}

/**
 * 找一个「用真解析器剥注释」可用的环境。
 * 🔴 剥不掉就**显式失败**：正则剥注释在本项目栽过，静默退回正则等于把已知的坑再踩一遍。
 */
function requireStripper() {
  const sample = stripComments('// 注释里的 肩部环绕\nconst a = \'颈部左侧屈\'\n/* 块注释里的 头部后缩 */\n')
  if (sample === null) {
    fail('找不到 typescript —— 源码守卫必须用真解析器剥注释（不能用正则，见铁律 #40）。请先 npm install。')
    return null
  }
  if (count(sample, '肩部环绕') !== 0 || count(sample, '头部后缩') !== 0) {
    fail('剥注释没生效：注释里的动作名仍留在结果里（源码守卫会误报）')
    return null
  }
  if (count(sample, '颈部左侧屈') !== 1) {
    fail('剥注释把**代码里**的字面量也删掉了 —— 源码守卫会漏报')
    return null
  }
  return true
}

// ─────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────

async function main() {
  const data = await loadData()
  const list = data.EXERCISES
  const names = (v) => (Array.isArray(v) ? JSON.stringify(v) : String(v))
  const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  // ── A. 结构完整性 ──────────────────────────────────────────
  if (!Array.isArray(list) || list.length === 0) {
    fail(`${DATA_REL} 没有导出非空的 EXERCISES —— 数据模块被搬走了？`)
    return finish(0)
  }
  if (list.length !== BEFORE.length) {
    fail(`动作数量 ${list.length} ≠ 改造前的 ${BEFORE.length} —— S7 是搬家，加/删动作属于 S8`)
  }

  const ids = new Set()
  const displayNames = new Set()
  const seenTargets = { head: 0, shoulder: 0, spine: 0 }
  for (const [i, e] of list.entries()) {
    const at = `第 ${i + 1} 个动作（${e?.name ?? '无名'}）`
    if (typeof e.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(e.id)) {
      fail(`${at} 的 id 不是英文 slug：${names(e.id)} —— 别拿中文名当标识（列表 key 与埋点都用它）`)
    } else if (ids.has(e.id)) {
      fail(`${at} 的 id 重复：${e.id}`)
    } else {
      ids.add(e.id)
    }
    if (typeof e.name !== 'string' || e.name === '') fail(`${at} 缺少 name`)
    else if (displayNames.has(e.name)) fail(`${at} 的显示名重复：${e.name}`)
    else displayNames.add(e.name)

    if (!(e.target in seenTargets)) fail(`${at} 的 target 非法：${names(e.target)}（应为 head/shoulder/spine）`)
    else seenTargets[e.target]++

    if (!['low', 'medium'].includes(e.intensity)) fail(`${at} 的 intensity 非法：${names(e.intensity)}`)

    // 时长区间必须是**真的约束**（不是装饰）：标称时长要落在区间内
    const [lo, hi] = e.durationRange ?? []
    if (typeof lo !== 'number' || typeof hi !== 'number' || lo > hi) {
      fail(`${at} 的 durationRange 非法：${names(e.durationRange)}`)
    } else if (!Number.isInteger(e.duration) || e.duration <= 0) {
      fail(`${at} 的 duration 不是正整数：${names(e.duration)}`)
    } else if (e.duration < lo || e.duration > hi) {
      fail(`${at} 的标称时长 ${e.duration}s 不在区间 [${lo}, ${hi}] 内`)
    }

    if (!['hold', 'cyclic'].includes(e.kind)) fail(`${at} 的 kind 非法：${names(e.kind)}`)
    if (!Number.isInteger(e.min_cycles) || e.min_cycles < 0) fail(`${at} 的 min_cycles 非法：${names(e.min_cycles)}`)
    if (e.kind === 'hold' && e.min_cycles !== 0) fail(`${at} 是保持类，min_cycles 必须是 0（现为 ${e.min_cycles}）`)
    if (e.kind === 'cyclic' && e.min_cycles < 1) fail(`${at} 是往复类，min_cycles 必须 ≥ 1（现为 ${e.min_cycles}）`)
    if (typeof e.measurable !== 'boolean') fail(`${at} 的 measurable 不是布尔：${names(e.measurable)}`)

    if (!e.hint) fail(`${at} 缺少 hint（界面那一行要领）`)
    if (!Array.isArray(e.keyPoints) || e.keyPoints.length === 0) fail(`${at} 缺少 keyPoints（S8 要领展开要用）`)
    if (!Array.isArray(e.contraindications)) fail(`${at} 缺少 contraindications（S9 安全约束要用）`)

    const m = e.guide?.motion
    if (!m || !(m.cycleSec > 0)) fail(`${at} 的 guide.motion.cycleSec 非法：${names(m?.cycleSec)}`)
    else {
      // x / y 是**互相独立的轴**：一个可以是单帧（不动）、另一个是多帧（来回）。
      // 所以不能要求两轴等长 —— 只有"两轴都在动"时才必须帧数一致
      //（framer-motion 逐帧插值，帧数不齐会让轨迹错位）。
      if (!Array.isArray(m.x) || !Array.isArray(m.y) || m.x.length === 0 || m.y.length === 0) {
        fail(`${at} 的 guide.motion 关键帧不合法（x/y 必须都是非空数组）：x=${names(m.x)} y=${names(m.y)}`)
      } else if (m.x.length > 1 && m.y.length > 1 && m.x.length !== m.y.length) {
        fail(`${at} 的 guide.motion 两轴都在动却帧数不一致：x=${m.x.length} 帧 y=${m.y.length} 帧`)
      }
      if (m.rotate !== undefined && (!Array.isArray(m.rotate) || m.rotate.length < 2)) {
        fail(`${at} 的 guide.motion.rotate 必须 ≥ 2 帧或干脆不给：${names(m.rotate)}`)
      }
    }
    const a = e.guide?.arrow
    if (!a || !['straight', 'arc', 'ring'].includes(a.kind)) {
      fail(`${at} 的 guide.arrow 非法：${names(a?.kind)}`)
    } else if (a.kind === 'straight' && !['left', 'right', 'up', 'down'].includes(a.dir)) {
      fail(`${at} 的 straight 箭头方向非法：${names(a.dir)}`)
    } else if (a.kind === 'arc' && (!['cw', 'ccw'].includes(a.dir) || a.from === a.to)) {
      fail(`${at} 的 arc 箭头参数非法：from=${names(a.from)} to=${names(a.to)} dir=${names(a.dir)}`)
    }
  }
  ok(`A. 结构完整性：${list.length} 个动作，id/显示名唯一，维度与引导参数自洽，标称时长均落在 durationRange 内`)

  // ── B. 逐项对拍：改造前就存在的值 ──────────────────────────
  let beforeMismatch = 0
  for (const [i, want] of BEFORE.entries()) {
    const got = list[i]
    if (!got) continue
    // `hint` 也必须在快照里：它是**用户可见的一行要领**，数据模块承诺"与改造前逐字一致"。
    for (const key of ['name', 'hint', 'duration', 'icon', 'color', 'kind', 'min_cycles', 'measurable']) {
      if (got[key] !== want[key]) {
        fail(`B. 第 ${i + 1} 个动作的 ${key} 变了：改造前 ${names(want[key])} → 现在 ${names(got[key])}（S7 不该改行为）`)
        beforeMismatch++
      }
    }
  }
  const orderGot = list.map((e) => e.name)
  const orderWant = BEFORE.map((e) => e.name)
  if (!deepEqual(orderGot, orderWant)) {
    fail(`B. 动作顺序变了：\n    改造前 ${JSON.stringify(orderWant)}\n    现在   ${JSON.stringify(orderGot)}`)
    beforeMismatch++
  }
  // id 与位置必须一一对应（调换 id 不会改变名字顺序，只有这条能抓住）
  const idsGot = list.map((e) => e.id)
  if (!deepEqual(idsGot, IDS)) {
    fail(`B. id 与位置的绑定变了：\n    快照 ${JSON.stringify(IDS)}\n    现在 ${JSON.stringify(idsGot)}`)
    beforeMismatch++
  }
  const total = list.reduce((s, e) => s + e.duration, 0)
  if (total !== BEFORE_TOTAL_SEC) {
    fail(`B. 总时长变了：改造前 ${BEFORE_TOTAL_SEC}s → 现在 ${total}s（数据模块导出的 TOTAL_DURATION_SEC=${names(data.TOTAL_DURATION_SEC)}）`)
    beforeMismatch++
  }
  if (data.TOTAL_DURATION_SEC !== BEFORE_TOTAL_SEC) {
    fail(`B. 导出的 TOTAL_DURATION_SEC=${names(data.TOTAL_DURATION_SEC)} ≠ ${BEFORE_TOTAL_SEC}`)
    beforeMismatch++
  }
  if (data.EXERCISE_COUNT !== list.length) {
    fail(`B. EXERCISE_COUNT=${names(data.EXERCISE_COUNT)} 与实际条数 ${list.length} 不符`)
    beforeMismatch++
  }
  if (beforeMismatch === 0) {
    ok(`B. 逐项对拍：${list.length} 个动作的名称/要领/时长/图标/配色/判定类型/可判定性**逐项不变**，顺序与 id 绑定不变，总时长仍为 ${BEFORE_TOTAL_SEC}s`)
  }

  // ── C. 引导动画参数对拍（含"标量 vs 关键帧"语义）──────────
  let guideMismatch = 0
  for (const [i, want] of BEFORE_GUIDE.entries()) {
    const e = list[i]
    if (!e) continue
    const m = e.guide?.motion ?? {}
    const at = `C. 第 ${i + 1} 个动作（${e.name ?? '?'}）`
    if (m.cycleSec !== want.cycleSec) {
      fail(`${at} 的动画周期变了：${names(want.cycleSec)} → ${names(m.cycleSec)}`)
      guideMismatch++
    }
    if (!deepEqual(m.x, want.x) || !deepEqual(m.y, want.y)) {
      fail(`${at} 的关键帧变了：x ${names(want.x)}→${names(m.x)}，y ${names(want.y)}→${names(m.y)}`)
      guideMismatch++
    }
    if (!deepEqual(m.rotate, want.rotate)) {
      fail(`${at} 的旋转关键帧变了：${names(want.rotate)} → ${names(m.rotate)}（不给 = 旧代码 initial 里没有 rotate）`)
      guideMismatch++
    }
    // 🔴 标量 vs 关键帧：长度为 1 的关键帧必须输出**标量**，否则"不动"会变成"原地抖"
    if ((m.x?.length === 1) !== want.xScalar) {
      fail(`${at} 的 x 关键帧与改造前的动画语义不符：改造前 x ${want.xScalar ? '不动（标量）' : '来回动（数组）'}，现为 ${m.x?.length} 帧`)
      guideMismatch++
    }
    if ((m.y?.length === 1) !== want.yScalar) {
      fail(`${at} 的 y 关键帧与改造前的动画语义不符：改造前 y ${want.yScalar ? '不动（标量）' : '来回动（数组）'}，现为 ${m.y?.length} 帧`)
      guideMismatch++
    }
    if (!deepEqual(e.guide?.arrow, want.arrow)) {
      fail(`${at} 的方向图元变了：${names(want.arrow)} → ${names(e.guide?.arrow)}`)
      guideMismatch++
    }
  }
  if (guideMismatch === 0) {
    ok(`C. 引导参数对拍：周期 / x·y 关键帧 / 旋转 / 方向图元 + 标量语义**逐参数等价**（${BEFORE_GUIDE.length} 条）`)
  }

  // ── D. `target` 映射（新增字段，钉住防偷改）───────────────
  const targetsGot = list.map((e) => e.target)
  if (!deepEqual(targetsGot, TARGETS)) {
    fail(`D. target 映射变了：\n    快照 ${JSON.stringify(TARGETS)}\n    现在 ${JSON.stringify(targetsGot)}`)
  } else {
    ok(`D. 问题维度映射与快照一致（head ${seenTargets.head} / shoulder ${seenTargets.shoulder} / spine ${seenTargets.spine}）`)
  }
  for (const [dim, n] of Object.entries(seenTargets)) {
    if (n < 1) fail(`D. 维度 ${dim} 没有任何动作覆盖`)
    else if (n < TARGET_MIN) warn(`维度 ${dim} 只有 ${n} 个动作，低于 S7 文档写的「每维度 ≥ ${TARGET_MIN}」（已知缺口，留给 S8 扩库）`)
  }

  if (!requireStripper()) return finish(list.length)

  // ── E. 源码守卫：动作名只能存在于数据文件里 ────────────────
  const sources = collectSources()
  // 防止"扫了个寂寞"：文件数明显偏少说明遍历坏了，守卫会静默变成空转
  if (sources.length < 40) {
    fail(`只扫到 ${sources.length} 个源文件（预期 ≥ 40）—— 文件遍历可能坏了，源码守卫会空转`)
    return finish(list.length)
  }
  const literals = [...new Set(list.flatMap((e) => [e.name, e.shortName]))]
  let literalHits = 0
  for (const full of sources) {
    const rel = relative(ROOT, full).replace(/\\/g, '/')
    if (rel === DATA_REL) continue
    const code = stripComments(readFileSync(full, 'utf8'))
    for (const lit of literals) {
      const n = count(code, lit)
      if (n > 0) {
        fail(`E. ${rel} 里出现了动作名「${lit}」（${n} 处）—— 动作名只能存在于 ${DATA_REL}`)
        literalHits++
      }
    }
  }
  if (literalHits === 0) {
    ok(`E. 源码守卫：${sources.length} 个源文件里，动作名（含短名 ${literals.length} 个）只出现在 ${DATA_REL}`)
  }

  // ── F. 源码守卫：总时长单点定义 + 引导不再按下标分支 ────────
  let structHits = 0
  for (const full of sources) {
    const rel = relative(ROOT, full).replace(/\\/g, '/')
    const code = stripComments(readFileSync(full, 'utf8'))
    if (rel !== DATA_REL && /\+\s*e\.duration\b/.test(code)) {
      fail(`F. ${rel} 里又自己算了一遍总时长（\`s + e.duration\`）—— 必须用 ${DATA_REL} 的 TOTAL_DURATION_SEC`)
      structHits++
    }
  }
  const dataCode = stripComments(readFileSync(join(ROOT, DATA_REL), 'utf8'))
  if (!/EXERCISES\.reduce\(/.test(dataCode)) {
    fail(`F. ${DATA_REL} 里找不到总时长的计算（EXERCISES.reduce）—— 单点定义被搬走了？`)
    structHits++
  }
  const guideRel = 'src/components/ExerciseGuide.tsx'
  const guideCode = stripComments(readFileSync(join(ROOT, guideRel), 'utf8'))
  // 数据化的判据：不再出现**按下标**的 `case 0:` 这类分支
  if (/\bcase\s+\d+\s*:/.test(guideCode)) {
    fail(`F. ${guideRel} 里又有按下标的分支（\`case 0:\`…）—— 引导必须由 guide 参数驱动`)
    structHits++
  }
  if (/\bexerciseIndex\b/.test(guideCode)) {
    fail(`F. ${guideRel} 又按动作下标取参数（exerciseIndex）—— 应传整个 exercise`)
    structHits++
  }
  if (!/guide\.motion/.test(guideCode) || !/guide\.arrow/.test(guideCode)) {
    fail(`F. ${guideRel} 没有消费 guide.motion / guide.arrow —— 引导参数没接上`)
    structHits++
  }
  if (structHits === 0) {
    ok(`F. 源码守卫：总时长只在 ${DATA_REL} 算一次；${guideRel} 无按下标分支、且消费 guide 参数`)
  }

  // ── G. 消费者必须走数据模块 ──────────────────────────────
  // ⚠️ 这一段读**原始文本**而不是剥注释后的文本：TS 转译会把 `import type {…}`
  //    整条**消除**（类型在运行时不存在），于是 ExerciseGuide（只用类型导出）
  //    在剥注释后的结果里根本看不到 `data/exercises` —— 实测踩到，会让断言误报。
  //    判据是"import 语句指向数据模块"，与注释无关，所以读原文是对的。
  let consumerHits = 0
  for (const rel of CONSUMERS) {
    const raw = readFileSync(join(ROOT, rel), 'utf8')
    if (!/from\s+['"][^'"]*data\/exercises['"]/.test(raw)) {
      fail(`G. ${rel} 没有从 data/exercises 取动作 —— 消费者必须走数据模块`)
      consumerHits++
    }
  }
  if (consumerHits === 0) {
    ok(`G. 消费者（${CONSUMERS.length} 个）全部从 ${DATA_REL} 取动作`)
  }

  finish(list.length)
}

main()
