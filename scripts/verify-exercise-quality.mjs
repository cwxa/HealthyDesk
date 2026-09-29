/**
 * 动作完成度判定等价性验证 + 离线样本回放。
 *
 * 用法：
 *   1. 先由 Python 生成期望值：
 *        python scripts/gen-exercise-quality-cases.py > scripts/exercise-quality-expected.json
 *   2. node scripts/verify-exercise-quality.mjs
 *      node scripts/verify-exercise-quality.mjs --replay   # 只回放样本，打印结论
 *
 * 为什么需要这条守卫：活动完成度判定同时存在于桌面端（`backend/services/exercise_quality.py`）
 * 与移动端（`src/platform/exerciseQuality.ts`）。**两端给出不同结论**是这一层最贵的 bug ——
 * 手机上说你完成了、电脑上说你没做，用户不知道该信谁；而 S10 还要拿这个结论当活动成绩。
 *
 * 校验十层：
 *   a) 常量：阈值 / 结论 / 引导文案 / **动作分权重** / **明细文本格式版本** 两端逐项相等
 *      （改一端不改另一端会红），外加**幅度口径的映射表**（metric → 帧字段 / 阈值）逐键相等
 *      —— 那个映射一端改了另一端没改，症状是"同一个动作在手机与电脑上看的是不同部位"。
 *   b) 样本文件一致性：载荷里的 frames/spec 必须与 scripts/samples/*.json 逐字段相同
 *      （防止"改了文件忘了重新生成"这种静默漂移）
 *   c) 判定用例（33 条，含边界、数据中断、滞回计数、取整平局点、metric 口径）六个字段逐条相等
 *   d) 语义硬断言：三段样本三种结论、负样本必须失败、中断不计入、滞回不重复计数、
 *      hint 与 grade 一一对应、onset 与 S1 同源
 *   e) 取整灵敏度自检（守卫的守卫）
 *   f) **动作分**：同一批用例（33）+ 3 段样本 + 14 条边界合成用例，两端逐条相等。
 *      动作分与判定**同源**（同一份 verdict、同一个 spec），所以两条链上的任何一处漂移都红。
 *   g) **动作分的核心不变量**：`分数 >= 达标分` ⟺ `判定为「完成」`，在**真实判定**铺出的
 *      网格（幅度 × 保持帧数、幅度 × 循环数）上成立 —— 证的是"端到端同向"，
 *      不是"公式自洽"；另断言分数对幅度单调不减、恒为 0–100 的整数。
 *   h) **逐动作明细的规范文本**：8 条用例上 `serializeActionScores()` 与 Python 写出的
 *      字符串**逐字节**相等。这一列在导出/导入里是不透明文本（不作重新序列化），
 *      所以"两端字节一样"是导出文件可互换的唯一保证 —— 解析后比较会放过键序、空白、
 *      Unicode 转义这三类真实差异（而它们正是两门语言最容易各错各的地方）。
 *   i) **明细解析端**：Python 写出的文本必须能被 TS 的 `parseActionScores()` 还原（跨语言往返），
 *      且各类坏值（老记录的 NULL、手改过的文件、将来版本的文本）一律返回 `null`
 *      —— 不许丢掉坏项留下半份，那会被读成"本次只判了这几个动作"。
 *      🔴 而 **v1 的文本不算坏值**：它结构合法、只是分数用了旧口径 ——
 *      必须能解析出来并让调用方看到 `legacy: true`（丢掉它等于抹掉用户的历史成绩，
 *      照常显示而不标注等于让用户拿两把尺子量出来的数字互相比）。
 *   j) **整场成绩**（`sessionScoreOf`，会被写进 `activity_log.avg_score` 并进导出文件）：
 *      6 条用例两端相等，其中两条的均值**恰好落在平局点**（79.5 / 80.5）。
 *      🔴 这一层**有**平局点，所以"取整实现被偷偷换掉"在**这里**抓得到（见下面的"已知未覆盖"）。
 *   k) 🔴 **v1.7.0 改幅度口径的两条反例**（本层的全部意义 —— 旧口径下它们都是错的）：
 *      ① **只动别的维度不许判完成**：肩高差从 0% 摆到 12%、头一动不动，判「头部侧屈」
 *         时必须是**没动**（旧口径三项取最大 → 判完成、84 分）。这一条同时钉住
 *         「每个动作只用它自己针对的量打分」。
 *      ② **基线本身就超阈值 + 全程不动 → 必须 idle 且 0 分**：脊柱习惯性歪 12° 的人
 *         坐在那儿不动（旧口径 → 判完成、82 分）—— 也就是"姿势越差越容易自动过关"。
 *      再叠一条**动作库驱动**的检查：对 `exercises.ts` 里每个 `measurable` 动作，
 *      "只让它**声明**的 metric 摆动"必须判完成、"只让别的维度摆动"必须不判完成 ——
 *      这一条证的是**动作库的 metric 声明是对的**，而不是"某个函数自己跟自己自洽"。
 *
 * ⚠️ **已知未覆盖（写清楚，免得被当成测过了）**：**动作分**那一层的「取整平局」在当前常量下
 * **不可达**，因此"把 `pyRound` 换成 `Math.round`"在**动作分**这一层抓不到
 * （判定那一层抓得到，见 §e；**整场成绩**那一层也抓得到，见 §j —— 它的均值会落在平局点上）。
 * 推导：峰值活动量经 `pyRound1` 后必是 0.1 的整数倍
 * ⇒ 幅度分是 6 的整数倍 ⇒ `0.5 × 幅度分` 必为整数；到位分量 `0.5 × 100 × ratio` 的取值是
 * {0, 8.333, 16.667, 25, 33.333, 41.667, 50}，永不为 x.5。两者之和不可能落在平局点上。
 * 这不是"暂时没测到"，是这一层**没有**平局点。若将来改权重 / 改达标线使平局可达，
 * 必须回来补一条能区分两种取整的用例，否则 §e 那条自检也保不住这一层。
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const require = createRequire(join(ROOT, 'package.json'))

const FIELDS = ['grade', 'hint', 'peak_activity', 'held_ms', 'hold_ratio', 'cycles']

/** 把前端真实源码 bundle 出来，同时拿到 exerciseQuality 与 scoringModel 的导出。 */
async function loadFrontendSource() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    console.error('✗ 找不到 esbuild（vite 的依赖）。请先 npm install。')
    process.exit(2)
  }

  const built = await esbuild.build({
    stdin: {
      contents: `
import * as eq from './exerciseQuality'
import * as sm from './scoringModel'
import * as data from '../data/exercises'
export const __eq = eq
export const __sm = sm
export const __data = data
`,
      resolveDir: join(ROOT, 'src', 'platform'),
      loader: 'ts',
      sourcefile: 'parity-entry.ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
  })

  const out = join(tmpdir(), `neckguardian-exercise-quality-${process.pid}.mjs`)
  writeFileSync(out, built.outputFiles[0].text)
  const mod = await import(pathToFileURL(out).href)
  try {
    unlinkSync(out)
  } catch {
    /* 删除失败不影响校验结果 */
  }
  // `data` = `src/data/exercises.ts`（动作库）。§k 要拿**真实动作库**去验
  // "每个动作声明的 metric 是不是真的能判出它来" —— 用副本等于自证。
  return { eq: mod.__eq, sm: mod.__sm, data: mod.__data }
}

/**
 * 与**当前**源码逐行相同、**只把两处取整换成 `Math.round`** 的变体，用于证明
 * 「取整实现被换掉」能被本测试发现（见 §e 灵敏度自检）。它不参与任何被测断言，只是一把尺子。
 *
 * 🔴 **必须跟着幅度口径一起改**：本函数是"照抄实现、只换取整"，
 * 若它还停留在旧口径（`exerciseActivity` 绝对偏离），那么它对**每一条**用例都会
 * 给出不同结论 —— §e 会永远报"灵敏度良好"，而它其实只是在证明"两个不同的算法不一样"。
 * 那条自检会变成**假绿**：取整被换掉照样通过。v1.7.0 改口径时重写了这一段。
 */
function makeMathRoundVariant(sm, eq) {
  const r1 = (x) => Math.round(x * 10) / 10 // ← 唯一差异之一
  return (frames, spec) => {
    const kind = spec?.kind ?? 'hold'
    const metric =
      spec?.metric != null && (spec.metric === eq.METRIC_ANY || eq.METRIC_FIELD[spec.metric] !== undefined)
        ? spec.metric
        : eq.METRIC_ANY
    const durationMs = spec?.duration_ms != null ? Number(spec.duration_ms) : 0
    const minCycles = spec?.min_cycles != null ? spec.min_cycles : kind === 'cyclic' ? eq.DEFAULT_MIN_CYCLES : 0
    if (frames.length === 0) {
      return { grade: 'idle', hint: eq.HINT_IDLE, peak_activity: 0, held_ms: 0, hold_ratio: 0, cycles: 0 }
    }
    const metrics = metric === eq.METRIC_ANY ? Object.keys(eq.METRIC_FIELD) : [metric]
    const series = metrics.map((m) => {
      const field = eq.METRIC_FIELD[m]
      const thr = eq.METRIC_THRESHOLD[m]
      let base = Infinity
      for (const f of frames) if (f[field] < base) base = f[field]
      return frames.map((f) => (f[field] - base) / thr)
    })
    const acts = frames.map((_, i) => r1(Math.max(...series.map((s) => s[i]))))
    let peak = acts[0]
    for (let i = 1; i < acts.length; i++) if (acts[i] > peak) peak = acts[i]
    let heldMs = 0
    for (let i = 0; i < frames.length - 1; i++) {
      if (acts[i] < eq.ACTIVITY_ONSET) continue
      const gap = frames[i + 1].t - frames[i].t
      if (gap <= 0 || gap > eq.MAX_FRAME_GAP_MS) continue
      heldMs += gap
    }
    const holdRatio = durationMs > 0 ? Math.min(1, r1(heldMs / durationMs)) : 0 // ← 另一处差异
    let cycles = 0
    let hot = false
    const trough = eq.ACTIVITY_ONSET * eq.CYCLE_TROUGH_RATIO
    for (const a of acts) {
      if (!hot) {
        if (a >= eq.ACTIVITY_ONSET) hot = true
      } else if (a <= trough) {
        cycles += 1
        hot = false
      }
    }
    let grade
    let hint
    if (peak < eq.ACTIVITY_IDLE_MAX) {
      grade = 'idle'
      hint = eq.HINT_IDLE
    } else if (peak < eq.ACTIVITY_ONSET) {
      grade = 'insufficient'
      hint = eq.HINT_AMPLITUDE
    } else if (kind === 'cyclic' && cycles < minCycles) {
      grade = 'insufficient'
      hint = eq.HINT_CYCLES
    } else if (kind === 'hold' && holdRatio < eq.HOLD_TARGET_RATIO) {
      grade = 'insufficient'
      hint = eq.HINT_HOLD
    } else {
      grade = 'completed'
      hint = eq.HINT_COMPLETED
    }
    return { grade, hint, peak_activity: peak, held_ms: heldMs, hold_ratio: holdRatio, cycles }
  }
}

function sameVerdict(a, b) {
  return FIELDS.every((k) => a[k] === b[k])
}

async function main() {
  const expectedPath = join(__dirname, 'exercise-quality-expected.json')
  let payload
  try {
    payload = JSON.parse(readFileSync(expectedPath, 'utf8'))
  } catch {
    console.error(`✗ 找不到 ${expectedPath}，请先运行：python scripts/gen-exercise-quality-cases.py > scripts/exercise-quality-expected.json`)
    process.exit(2)
  }

  const { eq, sm, data } = await loadFrontendSource()
  const replayOnly = process.argv.includes('--replay')
  let failed = false

  // ---- 离线样本回放（直接读样本文件，不看生成的载荷）----
  console.log('=== 离线样本回放（scripts/samples/）===')
  const sampleVerdicts = []
  for (const filename of payload.sample_files) {
    const file = join(__dirname, 'samples', filename)
    let raw
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (e) {
      console.error(`✗ 读不到样本 ${filename}: ${e.message}`)
      failed = true
      continue
    }
    const got = eq.judgeExercise(raw.frames, raw.spec)
    sampleVerdicts.push({ filename, raw, got })
    console.log(
      `  ${String(raw.name).padEnd(18)} ${got.grade.padEnd(13)}` +
        ` peak=${got.peak_activity} held=${got.held_ms}ms ratio=${got.hold_ratio} cycles=${got.cycles}`,
    )
  }
  if (replayOnly) {
    process.exit(failed ? 1 : 0)
  }

  // ---- a) 常量比对 ----
  let constFail = 0
  let constChecked = 0
  for (const [name, value] of Object.entries(payload.constants)) {
    constChecked++
    // EXERCISE_ACTIVITY_START 在 scoringModel 里，其余在 exerciseQuality 里
    const actual = name === 'EXERCISE_ACTIVITY_START' ? sm[name] : eq[name]
    if (actual !== value) {
      console.error(`✗ 常量不一致 ${name}: python=${value} ts=${actual}`)
      constFail++
    }
  }
  if (constFail > 0) failed = true
  console.log(`\n常量比对（Python ↔ 前端真实源码）：${constChecked} 项${constFail ? ` 有 ${constFail} 项差异` : '全部一致'}`)

  // ---- a2) 幅度口径的映射表（metric → 帧字段 / 静息阈值）逐键相等 ----
  // 单排一段而不是塞进上面：它是**映射**（`!==` 比不了），而且这一层最容易
  // "一端改了另一端没改" —— 症状是"同一个动作在手机与电脑上看的是不同部位"，极难查。
  const sameMap = (a, b) =>
    a && b && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k])
  const mapPayload = payload.metrics ?? {}
  const mapBad = []
  if (!sameMap(mapPayload.field, eq.METRIC_FIELD)) {
    mapBad.push(`field：python=${JSON.stringify(mapPayload.field)} ts=${JSON.stringify(eq.METRIC_FIELD)}`)
  }
  if (!sameMap(mapPayload.threshold, eq.METRIC_THRESHOLD)) {
    mapBad.push(`threshold：python=${JSON.stringify(mapPayload.threshold)} ts=${JSON.stringify(eq.METRIC_THRESHOLD)}`)
  }
  if (!sameMap(mapPayload.names, { head: eq.METRIC_HEAD, shoulder: eq.METRIC_SHOULDER, spine: eq.METRIC_SPINE, any: eq.METRIC_ANY })) {
    mapBad.push(`名字常量：python=${JSON.stringify(mapPayload.names)}`)
  }
  // 阈值必须与"静息提醒线"是同一批常量（不许在这里另立一套刻度）
  for (const [m, field] of Object.entries(eq.METRIC_FIELD)) {
    const restThresholds = {
      head_angle: sm.HEAD_TILT_THRESHOLD,
      shoulder_diff: sm.SHOULDER_DIFF_THRESHOLD,
      spine_angle: sm.SPINE_ANGLE_THRESHOLD,
    }
    if (eq.METRIC_THRESHOLD[m] !== restThresholds[field]) {
      mapBad.push(`${m} 的阈值 ${eq.METRIC_THRESHOLD[m]} ≠ 静息线 ${restThresholds[field]}（${field}）`)
    }
  }
  if (mapBad.length > 0) {
    console.error('✗ 幅度口径映射表两端不一致：')
    for (const x of mapBad) console.error(`    ${x}`)
    failed = true
  } else {
    console.log(
      `✓ 幅度口径映射表一致：metric → (帧字段, 静息阈值) 三键两端相同，且阈值就是静息提醒线` +
        `（head ${eq.METRIC_THRESHOLD[eq.METRIC_HEAD]} / shoulder ${eq.METRIC_THRESHOLD[eq.METRIC_SHOULDER]} / spine ${eq.METRIC_THRESHOLD[eq.METRIC_SPINE]}）`,
    )
  }

  // ---- a3) 明细文本版本：当前版本 + 仍能解析的历史版本 ----
  const versions = payload.action_scores_versions ?? {}
  if (versions.current !== eq.ACTION_SCORES_VERSION) {
    console.error(`✗ 明细版本不一致：python=${versions.current} ts=${eq.ACTION_SCORES_VERSION}`)
    failed = true
  } else if (
    JSON.stringify(versions.legacy ?? []) !== JSON.stringify([...(eq.ACTION_SCORES_LEGACY_VERSIONS ?? [])])
  ) {
    console.error(
      `✗ 可解析的历史版本不一致：python=${JSON.stringify(versions.legacy)} ts=${JSON.stringify(eq.ACTION_SCORES_LEGACY_VERSIONS)}`,
    )
    failed = true
  } else {
    console.log(
      `✓ 明细文本版本一致：当前 v${eq.ACTION_SCORES_VERSION}，仍可解析的历史版本 v${(eq.ACTION_SCORES_LEGACY_VERSIONS ?? []).join('、v') || '(无)'}（后者要标成「旧口径」）`,
    )
  }

  // ---- b) 样本文件一致性 ----
  // 载荷里的样本是从文件读出来生成的；这里再读一遍文件，确保两者没漂移
  // （典型翻车：改了 samples/*.json 但忘了重新跑生成器，于是守卫拿旧期望值比对。）
  let driftFail = 0
  for (const s of payload.samples) {
    const gone = sampleVerdicts.find((x) => x.filename === s.source_file.replace(/^samples\//, ''))
    if (!gone) {
      console.error(`✗ 载荷里的样本 ${s.source_file} 不在回放结果中`)
      driftFail++
      continue
    }
    if (JSON.stringify(gone.raw.frames) !== JSON.stringify(s.frames)) {
      console.error(`✗ 样本漂移 ${s.source_file}：载荷里的 frames 与文件不一致（重新跑生成器）`)
      driftFail++
    }
    if (JSON.stringify(gone.raw.spec) !== JSON.stringify(s.spec)) {
      console.error(`✗ 样本漂移 ${s.source_file}：载荷里的 spec 与文件不一致（重新跑生成器）`)
      driftFail++
    }
    if (gone.raw.expected_grade !== s.expected_grade) {
      console.error(`✗ 样本漂移 ${s.source_file}：expected_grade 与文件不一致`)
      driftFail++
    }
    if (!sameVerdict(gone.got, s.expected)) {
      console.error(`✗ 样本判定两端不一致 ${s.source_file}`)
      console.error(`    Python: ${JSON.stringify(s.expected)}`)
      console.error(`    TS:     ${JSON.stringify(gone.got)}`)
      driftFail++
    }
  }
  if (driftFail > 0) failed = true
  console.log(
    driftFail
      ? `✗ 样本一致性：${driftFail} 处问题`
      : `✓ 样本一致性：${payload.samples.length} 段样本与文件一致，且两端判定相同`,
  )

  // ---- c) 用例逐条比对 ----
  let pass = 0
  let mismatch = 0
  for (const c of payload.cases) {
    const got = eq.judgeExercise(c.frames, c.spec)
    if (sameVerdict(got, c.expected)) {
      pass++
    } else {
      mismatch++
      if (mismatch <= 8) {
        console.error(`✗ 不一致「${c.name}」n=${c.frames.length}`)
        console.error(`    Python: ${JSON.stringify(c.expected)}`)
        console.error(`    TS:     ${JSON.stringify(got)}`)
      }
    }
  }
  console.log(`\n完成度判定等价性：${pass} 通过 / ${mismatch} 失败（共 ${payload.cases.length} 条）`)
  if (mismatch > 0) failed = true

  // ---- c2) 动作分逐条比对 ----
  // 与 c) 用**同一批**用例、**同一个** verdict：动作分是判定的下游，
  // 两层一起对拍才能同时抓住"判定漂移"与"判定没漂但分数算错了"。
  let scorePass = 0
  let scoreMismatch = 0
  for (const c of payload.cases) {
    const gotVerdict = eq.judgeExercise(c.frames, c.spec)
    const gotScore = eq.scoreExercise(gotVerdict, c.spec)
    if (gotScore === c.expected_score) {
      scorePass++
    } else {
      scoreMismatch++
      if (scoreMismatch <= 8) {
        console.error(`✗ 动作分不一致「${c.name}」`)
        console.error(`    Python: ${c.expected_score}`)
        console.error(`    TS:     ${gotScore}    verdict=${JSON.stringify(gotVerdict)}`)
      }
    }
  }
  for (const s of payload.samples) {
    const gotScore = eq.scoreExercise(eq.judgeExercise(s.frames, s.spec), s.spec)
    if (gotScore !== s.expected_score) {
      scoreMismatch++
      console.error(`✗ 样本动作分不一致「${s.name}」Python=${s.expected_score} TS=${gotScore}`)
    } else {
      scorePass++
    }
  }
  const scoreTotal = payload.cases.length + payload.samples.length
  console.log(`动作分等价性（帧用例 + 样本）：${scorePass} 通过 / ${scoreMismatch} 失败（共 ${scoreTotal} 条）`)
  if (scoreMismatch > 0) failed = true

  // ---- c3) 逐动作明细的**规范文本**：逐字节一致 ----
  // 为什么必须逐**字节**而不是"解析后相等"：这一列在导出/导入里是**不透明文本**
  // （字段类型 str，导入端不重新序列化），所以"两端写出来的字节一样"是导出文件
  // 可互换的**唯一**保证。解析后比较会放过键序、空白、Unicode 转义这三类真实差异 ——
  // 而它们恰好是两门语言最容易各错各的地方（Python 的 json.dumps 默认
  // `ensure_ascii=True`，JS 的 JSON.stringify 不转义非 ASCII）。
  // 期望值取自**载荷里 Python 生成的那串**，不是拿 TS 自己的输出比（那是自证）。
  let textPass = 0
  let textMismatch = 0
  for (const c of payload.action_scores_cases) {
    const got = eq.serializeActionScores(c.items)
    if (got === c.expected) {
      textPass++
    } else {
      textMismatch++
      if (textMismatch <= 5) {
        console.error(`✗ 明细规范文本不一致「${c.name}」`)
        console.error(`    Python: ${c.expected}`)
        console.error(`    TS:     ${got}`)
      }
    }
  }
  console.log(
    `逐动作明细规范文本：${textPass} 通过 / ${textMismatch} 失败（共 ${payload.action_scores_cases.length} 条，逐字节比对）`,
  )
  if (textMismatch > 0) failed = true

  // ---- c4) 整场成绩（会被写进 `activity_log.avg_score` 并进导出文件）----
  // 两端必须给出同一个值：它是要落库、要进备份、要在界面上当"本次动作成绩"的数。
  let sessPass = 0
  let sessMismatch = 0
  for (const c of payload.session_score_cases) {
    const got = eq.sessionScoreOf(c.items)
    if (got === c.expected) sessPass++
    else {
      sessMismatch++
      console.error(`✗ 整场成绩不一致「${c.name}」：Python=${c.expected} TS=${got}`)
    }
  }
  console.log(
    `整场成绩等价性：${sessPass} 通过 / ${sessMismatch} 失败（共 ${payload.session_score_cases.length} 条，含两个平局点）`,
  )
  if (sessMismatch > 0) failed = true

  const byName = (n) => payload.cases.find((x) => x.name === n)
  const gotOf = (n) => {
    const c = byName(n)
    return c ? eq.judgeExercise(c.frames, c.spec) : null
  }

  // ---- d) 语义硬断言 ----
  let hardFail = 0

  // d1) 三段固定样本必须给出三种**互不相同**的结论，且负样本不得被判为「完成」。
  //     这是 S2 验收标准里唯一一条真正能证伪"判定函数到底有没有在工作"的断言。
  const grades = sampleVerdicts.map((s) => s.got.grade)
  const unique = new Set(grades)
  if (sampleVerdicts.length !== 3 || unique.size !== 3) {
    console.error(`✗ 三段样本应给出三种不同结论，实际：${sampleVerdicts.map((s) => `${s.raw.name}=${s.got.grade}`).join(', ')}`)
    hardFail++
  } else {
    console.log(`✓ 三段样本给出三种不同结论：${sampleVerdicts.map((s) => `${s.raw.name}→${s.got.grade}`).join('、')}`)
  }
  for (const s of sampleVerdicts) {
    if (s.got.grade !== s.raw.expected_grade) {
      console.error(`✗ 样本 ${s.raw.name} 结论应为 ${s.raw.expected_grade}，实际 ${s.got.grade}`)
      hardFail++
    }
  }
  const negative = sampleVerdicts.find((s) => s.raw.expected_grade === 'idle')
  if (!negative) {
    console.error('✗ 样本集里缺少负样本（expected_grade=idle）—— 没有它就无法证明"不动会被判为没做"')
    hardFail++
  } else if (negative.got.grade === 'completed') {
    console.error(`✗ 负样本 ${negative.raw.name} 被判为「完成」—— 判定函数失效`)
    hardFail++
  } else {
    console.log(`✓ 负样本必须失败：${negative.raw.name} 没有被判为「完成」（grade=${negative.got.grade}）`)
  }

  // d2) 空序列不能假装完成
  const empty = gotOf('空序列·保持类')
  if (!empty || empty.grade !== 'idle' || empty.peak_activity !== 0 || empty.held_ms !== 0 || empty.cycles !== 0) {
    console.error(`✗ 空序列应判 idle 且各量为 0，实际 ${JSON.stringify(empty)}`)
    hardFail++
  } else {
    console.log('✓ 空序列判「没动」（不假装完成）')
  }

  // d3) 数据中断不计入保持时长（同一组帧，只有间隔不同）
  //     ⚠️ 期望值是 2000 而不是 3000：新口径下第 0 帧是**基线**（范围 0，未达 onset），
  //        它能贡献的是 i=1→2 与 i=2→3 两个区间。这里断言的是"两个 1000ms 间距被计入、
  //        两个 2000ms 间距被排除"，不是某个绝对数 —— 绝对数跟着用例的帧数走。
  const gapOk = gotOf('中断·间隔 1000ms（计入）')
  const gapBad = gotOf('中断·间隔 2000ms（不计入）')
  if (!gapOk || !gapBad || gapOk.held_ms !== 2000 || gapBad.held_ms !== 0) {
    console.error(`✗ 数据中断未被正确排除：1000ms 间隔 held=${gapOk?.held_ms}（应 2000），2000ms 间隔 held=${gapBad?.held_ms}（应 0）`)
    hardFail++
  } else {
    console.log('✓ 数据中断（间隔 > MAX_FRAME_GAP_MS）不计入保持时长：2000ms → 0ms')
  }

  // d4) 非正间隔被排除（重复时间戳）
  const dup = gotOf('异常·重复时间戳')
  if (!dup || dup.held_ms !== 1000) {
    console.error(`✗ 重复时间戳未被排除：held=${dup?.held_ms}，应 1000`)
    hardFail++
  } else {
    console.log('✓ 非正间隔被排除（重复时间戳的 held 只算真实经过的那 1000ms）')
  }

  // d5) 滞回计数：在起点附近抖动不得被计成多次循环
  const flap = gotOf('往复·在起点附近抖动（滞回防重复计数）')
  const threeCycles = gotOf('往复·恰好 3 次循环')
  if (!flap || flap.cycles !== 0) {
    console.error(`✗ 抖动序列的 cycles 应为 0（滞回失效），实际 ${flap?.cycles}`)
    hardFail++
  } else if (!threeCycles || threeCycles.cycles !== 3) {
    console.error(`✗ 三次循环序列的 cycles 应为 3，实际 ${threeCycles?.cycles}`)
    hardFail++
  } else {
    console.log('✓ 往复计数带滞回：抖动序列 cycles=0，真实三次循环 cycles=3')
  }

  // d6) 往复类不看保持比例（它为往复动作定义，本身没有"保持"的概念）
  if (!threeCycles || threeCycles.hold_ratio >= payload.constants.HOLD_TARGET_RATIO) {
    console.error(`✗ 往复用例的 hold_ratio 应低于保持线以证明「往复类不看它」，实际 ${threeCycles?.hold_ratio}`)
    hardFail++
  } else if (threeCycles.grade !== 'completed') {
    console.error(`✗ 往复类在循环数达标时应判完成（不受 hold_ratio 影响），实际 ${threeCycles.grade}`)
    hardFail++
  } else {
    console.log(`✓ 往复类不受保持比例影响：ratio=${threeCycles.hold_ratio} < ${payload.constants.HOLD_TARGET_RATIO} 仍判完成`)
  }

  // d7) hint 与 grade 必须一一对应（防止"结论说完成、文案说再大一点"）
  const hintByGrade = {
    idle: [payload.constants.HINT_IDLE],
    insufficient: [payload.constants.HINT_AMPLITUDE, payload.constants.HINT_HOLD, payload.constants.HINT_CYCLES],
    completed: [payload.constants.HINT_COMPLETED],
  }
  let hintBad = 0
  const all = [...payload.cases.map((c) => ({ name: c.name, v: eq.judgeExercise(c.frames, c.spec) })), ...sampleVerdicts.map((s) => ({ name: s.raw.name, v: s.got }))]
  for (const { name, v } of all) {
    if (!hintByGrade[v.grade] || !hintByGrade[v.grade].includes(v.hint)) {
      console.error(`✗ 文案与结论不匹配「${name}」grade=${v.grade} hint=${v.hint}`)
      hintBad++
    }
  }
  if (hintBad > 0) {
    hardFail++
  } else {
    console.log(`✓ 引导文案与结论一一对应（检查 ${all.length} 条）`)
  }

  // d8) onset 必须与 S1 运动态共用一个取值（"确实动起来了"的定义只有一处）
  if (eq.ACTIVITY_ONSET !== sm.EXERCISE_ACTIVITY_START) {
    console.error(
      `✗ ACTIVITY_ONSET (${eq.ACTIVITY_ONSET}) 与 EXERCISE_ACTIVITY_START (${sm.EXERCISE_ACTIVITY_START}) 脱钩 —— ` +
        '完成度判定与运动态评分会用两套"算不算动起来"的标准',
    )
    hardFail++
  } else {
    console.log(`✓ 有效活动起点与 S1 同源（ACTIVITY_ONSET = EXERCISE_ACTIVITY_START = ${eq.ACTIVITY_ONSET}）`)
  }

  // d9) 动作分边界用例：**直接构造 verdict**（帧序列上摆不出"幅度恰好压线 / 保持恰好 0.6"），
  //     两端逐条相等。与 c2) 的分工：c2 证"真实链路上两端一致"，d9 证"边界点上一致"。
  const edgeCases = payload.score_cases ?? []
  let edgeFail = 0
  for (const c of edgeCases) {
    const gotScore = eq.scoreExercise(c.verdict, c.spec)
    if (gotScore !== c.expected_score) {
      console.error(`✗ 动作分边界不一致「${c.name}」Python=${c.expected_score} TS=${gotScore}`)
      edgeFail++
    }
  }
  if (edgeCases.length === 0) {
    console.error('✗ 载荷里没有 score_cases —— 动作分的边界点一个都没被覆盖')
    hardFail++
  } else if (edgeFail > 0) {
    hardFail++
  } else {
    console.log(`✓ 动作分边界用例两端一致（${edgeCases.length} 条，含"恰好压线"与"钳位生效"）`)
  }

  // d10) 🔴 核心不变量：`分数 >= 达标分` ⟺ `判定为「完成」`
  //      这是动作分这个功能的**全部意义** —— 分数与判定必须同向。
  //      反例长什么样：幅度满分但没保持住，用户看到 99 分，界面却说「保持住，别急着放下」。
  //      用**真实判定**铺网格（不是构造 verdict）：要证的是"端到端成立"，
  //      而不是"公式自己跟自己自洽"。
  const holdSpec = { kind: eq.KIND_HOLD, duration_ms: 10000, min_cycles: 0, metric: eq.METRIC_HEAD }
  const cycSpec = { kind: eq.KIND_CYCLIC, duration_ms: 3000, min_cycles: 3, metric: eq.METRIC_HEAD }
  // 🔴 第 0 帧**必须是基线**（head=0）：新口径下"幅度"是活动**范围**，
  //    如果整段都是 peakHead（没有回落到基线的帧），范围就是 0 —— 网格会全部退化成
  //    idle，核心不变量变成"0 分且未完成"，恒真，等于没有断言。v1.7.0 改口径时踩到过。
  const holdFrames = (peakHead, heldFrames) => {
    const out = []
    for (let i = 0; i < 21; i++) {
      out.push({ t: i * 500, head_angle: i >= 1 && i <= heldFrames ? peakHead : 0, shoulder_diff: 0, spine_angle: 0 })
    }
    return out
  }
  const cycFrames = (peakHead, cycles) => {
    const out = []
    let t = 0
    for (let i = 0; i < cycles; i++) {
      out.push({ t, head_angle: peakHead, shoulder_diff: 0, spine_angle: 0 })
      t += 500
      out.push({ t, head_angle: 0, shoulder_diff: 0, spine_angle: 0 })
      t += 500
    }
    return out
  }
  const invBad = []
  let invPoints = 0
  const checkInvariant = (label, frames, spec) => {
    const v = eq.judgeExercise(frames, spec)
    const sc = eq.scoreExercise(v, spec)
    invPoints++
    if ((sc >= eq.EXERCISE_PASS_SCORE) !== (v.grade === eq.GRADE_COMPLETED)) {
      invBad.push(`${label}: grade=${v.grade} score=${sc}（达标分 ${eq.EXERCISE_PASS_SCORE}）`)
    }
    if (!Number.isInteger(sc) || sc < 0 || sc > 100) {
      invBad.push(`${label}: 分数越界或非整数 score=${sc}`)
    }
  }
  for (const peak of [1.0, 2.5, 5.0, 7.5, 10.0, 20.0]) {
    for (let held = 0; held <= 21; held++) {
      checkInvariant(`保持·幅度${peak}·保持${held}帧`, holdFrames(peak, held), holdSpec)
    }
  }
  for (const peak of [5.0, 10.0, 20.0]) {
    for (let cys = 0; cys <= 5; cys++) {
      checkInvariant(`往复·幅度${peak}·${cys}次`, cycFrames(peak, cys), cycSpec)
    }
  }
  if (invBad.length > 0) {
    console.error(`✗ 核心不变量「分数 >= ${eq.EXERCISE_PASS_SCORE} ⟺ 判「完成」」被打破 ${invBad.length} 处（共 ${invPoints} 个网格点）：`)
    for (const x of invBad.slice(0, 6)) console.error(`    ${x}`)
    hardFail++
  } else {
    console.log(`✓ 核心不变量成立：${invPoints} 个网格点上，分数 >= ${eq.EXERCISE_PASS_SCORE} ⟺ 判定为「完成」`)
  }

  // d11) 单调性：同一个动作，幅度越大分数不得下降（钳位只压未达标者，不反转方向）
  const monoBad = []
  for (const held of [0, 3, 6, 12, 21]) {
    let prev = -1
    for (const peak of [0.2, 0.5, 1.0, 2.5, 5.0, 10.0, 20.0]) {
      const sc = eq.scoreExercise(eq.judgeExercise(holdFrames(peak, held), holdSpec), holdSpec)
      if (sc < prev) monoBad.push(`保持 ${held} 帧：幅度升到 ${peak} 时分数 ${prev} → ${sc}`)
      prev = sc
    }
  }
  if (monoBad.length > 0) {
    console.error(`✗ 分数对幅度单调性被打破 ${monoBad.length} 处：`)
    for (const x of monoBad.slice(0, 5)) console.error(`    ${x}`)
    hardFail++
  } else {
    console.log('✓ 分数对幅度单调不减（5 组保持帧数 × 7 档幅度）')
  }

  // d12) 没动就是 `IDLE_SCORE`：判 idle 时不许给出个位数的"你动了但很少"。
  // 🔴 期望值取**载荷里 Python 的那个值**，不能取 `eq.IDLE_SCORE` ——
  //    后者是"函数拿它算、断言又拿它比"，恒真，等于没有断言。
  //    这条写法上的坑是变异测试 M3（`IDLE_SCORE 0 → 5`）抓出来的：原写法照样绿。
  const idleOf = (peak) =>
    eq.scoreExercise(
      { grade: eq.GRADE_IDLE, hint: '', peak_activity: peak, held_ms: 0, hold_ratio: 0, cycles: 0 },
      holdSpec,
    )
  const idleLow = idleOf(eq.ACTIVITY_IDLE_MAX)
  const idleHigh = idleOf(20.0)
  const idleWant = payload.constants.IDLE_SCORE
  if (idleLow !== idleWant || idleHigh !== idleWant) {
    console.error(
      `✗ 判 idle（没动）时应给 ${idleWant} 分，实际 峰值${eq.ACTIVITY_IDLE_MAX}→${idleLow}、峰值 20→${idleHigh} —— 峰值不该影响它`,
    )
    hardFail++
  } else {
    console.log(`✓ 没动就是 ${idleWant} 分（不看峰值，不编造"动了但很少"）`)
  }

  // d13) 解析端必须**认得**写入端写出的东西，且对坏值一律返回 `null`（不猜、不折中）。
  //      两件事都只能在这里验：
  //        - 往返：`parseActionScores(Python 生成的文本)` 必须还原出同一份明细。
  //          注意这是**跨语言**往返（Python 写、TS 读），比"自己写自己读"强得多。
  //        - 拒坏值：显示端拿到的可能是老记录（NULL）、手改过的文件、将来版本的文本。
  //          返回 `null` = "读不出来"，界面显示 `--`；**不许**丢掉坏项留下半份，
  //          那会被读成"本次只判了这几个动作" —— 又是"展示了不能证明的数字"。
  const rtBad = []
  for (const c of payload.action_scores_cases) {
    const parsed = eq.parseActionScores(c.expected)
    if (parsed === null || parsed.length !== c.items.length) {
      rtBad.push(`「${c.name}」往返条数不符：期望 ${c.items.length}，得 ${parsed === null ? 'null' : parsed.length}`)
      continue
    }
    for (let i = 0; i < parsed.length; i++) {
      const a = parsed[i]
      const b = c.items[i]
      if (a.id !== b.id || a.score !== b.score || a.grade !== b.grade) {
        rtBad.push(`「${c.name}」第 ${i} 项不符：${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)
      }
    }
  }
  const badInputs = [
    ['老记录（NULL）', null],
    ['老记录（undefined）', undefined],
    ['空串', ''],
    ['不是 JSON', 'neckguardian'],
    ['是数组不是对象', '[1,2,3]'],
    ['版本不认识（将来版本的文本）', '{"v":3,"items":[]}'],
    ['版本是字符串（不做隐式转换）', '{"v":"2","items":[]}'],
    ['版本缺失', '{"items":[]}'],
    ['items 不是数组', '{"v":2,"items":{}}'],
    ['条目不是对象', '{"v":2,"items":[42]}'],
    ['条目缺 grade', '{"v":2,"items":[{"id":"a","score":80}]}'],
    ['grade 不是已知结论', '{"v":2,"items":[{"id":"a","score":80,"grade":"great"}]}'],
    ['score 是字符串（不做隐式转换）', '{"v":2,"items":[{"id":"a","score":"80","grade":"completed"}]}'],
    ['id 为空串', '{"v":2,"items":[{"id":"","score":80,"grade":"completed"}]}'],
  ]
  for (const [label, input] of badInputs) {
    if (eq.parseActionScores(input) !== null) {
      rtBad.push(`坏值未被拒绝：${label} → 应返回 null`)
    }
  }

  // 🔴 v1 的文本**不是**坏值：结构合法，只是分数用了旧口径（绝对偏离）。
  //    丢掉它 = 抹掉用户的历史成绩；照常显示而不标注 = 让用户拿两把尺子量出来的
  //    数字互相比。所以它必须能解析出来，并且**让调用方看到 legacy**。
  const legacyText = '{"v":1,"items":[{"id":"neck-flex-left","score":84,"grade":"completed"}]}'
  const legacyParsed = eq.parseActionScoresDetailed(legacyText)
  if (legacyParsed === null) {
    rtBad.push('v1（旧口径）文本被当成坏值拒绝了 —— 老用户的历史成绩会凭空消失')
  } else if (legacyParsed.legacy !== true || legacyParsed.version !== 1) {
    rtBad.push(`v1 文本解析出来但没标成 legacy：${JSON.stringify(legacyParsed)}`)
  } else if (legacyParsed.items.length !== 1 || legacyParsed.items[0].score !== 84) {
    rtBad.push(`v1 文本的明细没还原出来：${JSON.stringify(legacyParsed.items)}`)
  } else if (eq.parseActionScores(legacyText)?.length !== 1) {
    rtBad.push('只要明细的那个接口（parseActionScores）没能读出 v1 的文本')
  }
  // 反向对照：当前版本**不许**被标成 legacy（不然"旧口径"这个标签就成了装饰）
  const currentParsed = eq.parseActionScoresDetailed(payload.action_scores_cases[1].expected)
  if (currentParsed === null || currentParsed.legacy !== false) {
    rtBad.push(`当前版本（v${eq.ACTION_SCORES_VERSION}）被标成了 legacy：${JSON.stringify(currentParsed)}`)
  }

  if (rtBad.length > 0) {
    console.error(`✗ 明细解析端不合格 ${rtBad.length} 处：`)
    for (const x of rtBad.slice(0, 8)) console.error(`    ${x}`)
    hardFail++
  } else {
    console.log(
      `✓ 明细解析：跨语言往返 ${payload.action_scores_cases.length} 条全部还原、` +
        `${badInputs.length} 类坏值全部拒绝、v1 旧口径能解析且被标出（当前版本不标）`,
    )
  }

  // ---- k) 🔴 v1.7.0 改幅度口径的两条反例（本层的全部意义）----
  //
  // 前两层（c / c2）证的是"两端算得一样"，**证不了"这个算法对不对"**。
  // 这一层证的是**结论本身**：下面这些场景在旧口径下都是错的，
  // 且期望值是**这里写死的语义**（不是拿 Python 的输出比 —— 那是自证）。
  //
  // 旧口径 = `exercise_activity()`（三轴绝对偏离取最大）。两个实测缺陷：
  //   ① 高低肩 6% 的人做「颈部左侧屈」时头没动 → 旧口径判完成、84 分；
  //   ② 习惯性脊柱倾斜 12° 的人全程不动 → 旧口径判完成、82 分。
  // 两条的共同后果：**姿势越差越容易"自动过关"**。
  const kBad = []

  // k1) 只动**别的**维度，不许算这个动作做到位
  const onlyShoulder = byName('metric·head：肩高差再大也不算头部动作')
  const swapped = byName('metric·shoulder：同一串帧换看肩部就是真动作')
  if (!onlyShoulder || !swapped) {
    kBad.push('载荷里缺少 metric 对照用例 —— 这一层没东西可验')
  } else if (onlyShoulder.expected.grade === eq.GRADE_COMPLETED || onlyShoulder.expected_score >= eq.EXERCISE_PASS_SCORE) {
    kBad.push(
      `「肩高差从 0% 摆到 12%、头一动不动」被判成做到了「头部侧屈」（grade=${onlyShoulder.expected.grade} score=${onlyShoulder.expected_score}）` +
        ' —— 那等于让别的部位冒充这个动作的幅度',
    )
  } else if (swapped.expected.grade !== eq.GRADE_COMPLETED) {
    kBad.push(`同一串帧换成「看肩部」却没判完成（grade=${swapped.expected.grade}）—— metric 没起作用`)
  } else {
    console.log(
      `✓ 反例① 只动别的维度不算数：同一串帧看 head → ${onlyShoulder.expected.grade}（${onlyShoulder.expected_score} 分），` +
        `看 shoulder → ${swapped.expected.grade}（${swapped.expected_score} 分）`,
    )
  }

  // k2) 基线本身就超标 + 全程不动 → 必须没动、0 分
  const tiltedStill = byName('metric·spine：基线歪 12° 但全程不动 → 没动')
  if (!tiltedStill) {
    kBad.push('载荷里缺少"基线超标但不动"的用例')
  } else if (tiltedStill.expected.grade !== eq.GRADE_IDLE || tiltedStill.expected_score !== eq.IDLE_SCORE) {
    kBad.push(
      `「脊柱习惯性歪 12°、全程不动」被判成 ${tiltedStill.expected.grade}（${tiltedStill.expected_score} 分）` +
        ` —— 应当 ${eq.GRADE_IDLE} / ${eq.IDLE_SCORE} 分。旧口径下这里是 82 分：姿势越差越容易自动过关`,
    )
  } else {
    console.log(`✓ 反例② 基线超标不等于做到了：脊柱歪 12° 全程不动 → ${tiltedStill.expected.grade} / ${tiltedStill.expected_score} 分`)
  }

  // k3) **动作库驱动**：对每个 `measurable` 动作，用真实 `exercises.ts` 的声明去验
  //     "只让它声明的量摆动"必须判完成、"只让别的量摆动"必须不判完成。
  //     这一条证的是**动作库的 metric 声明是对的**，而不是"某个函数自己跟自己自洽"。
  const AXES = [eq.METRIC_HEAD, eq.METRIC_SHOULDER, eq.METRIC_SPINE]
  const peakOf = {
    head: sm.HEAD_TILT_THRESHOLD * 2,
    shoulder: sm.SHOULDER_DIFF_THRESHOLD * 2,
    spine: sm.SPINE_ANGLE_THRESHOLD * 2,
  }
  const frameOn = (t, axes) => {
    const f = { t, head_angle: 0, shoulder_diff: 0, spine_angle: 0 }
    for (const a of axes) f[eq.METRIC_FIELD[a]] = peakOf[a]
    return f
  }
  const seriesOn = (axes, kind, durationMs, minCycles) => {
    if (kind === eq.KIND_CYCLIC) {
      const out = []
      let t = 0
      const n = Math.max(1, minCycles)
      for (let i = 0; i < n; i++) {
        out.push(frameOn(t, axes))
        t += 500
        out.push(frameOn(t, []))
        t += 500
      }
      return out
    }
    const n = Math.max(1, Math.round(durationMs / 500))
    const out = [frameOn(0, [])]
    for (let i = 1; i <= n; i++) out.push(frameOn(i * 500, axes))
    return out
  }
  const library = (data?.EXERCISES ?? []).filter((e) => e.measurable)
  if (library.length === 0) {
    kBad.push('从 exerciseQuality 侧读不到动作库里的 measurable 动作（bundle 出问题了？）—— 这一层会空转')
  }
  let kAnySkipped = 0
  for (const e of library) {
    const spec = { kind: e.kind, metric: e.metric, duration_ms: e.duration * 1000, min_cycles: e.min_cycles }
    const declared = e.metric === eq.METRIC_ANY ? AXES : [e.metric]
    const pos = eq.judgeExercise(seriesOn(declared, e.kind, e.duration * 1000, e.min_cycles), spec)
    if (pos.grade !== eq.GRADE_COMPLETED) {
      kBad.push(
        `「${e.name}」按它**声明**的 metric=${e.metric} 做足了幅度，却没判完成（grade=${pos.grade}, peak=${pos.peak_activity}）` +
          ' —— 要么声明错了 metric，要么阈值/口径有问题',
      )
      continue
    }
    if (e.metric === eq.METRIC_ANY) {
      // `any` 的定义就是"哪个量动得多算哪个"，所以"只动别的量"它本来就该算数 ——
      // 跳过反向检查，但要**报出跳过数**，免得这条检查悄悄变成空转。
      kAnySkipped++
      continue
    }
    const others = AXES.filter((a) => a !== e.metric)
    const neg = eq.judgeExercise(seriesOn(others, e.kind, e.duration * 1000, e.min_cycles), spec)
    if (neg.grade === eq.GRADE_COMPLETED) {
      kBad.push(
        `「${e.name}」只看 ${e.metric}，但"只动 ${others.join('/')}"也被判成完成（grade=${neg.grade}）` +
          ' —— 这个动作的分数在看别的部位',
      )
    }
  }

  if (kBad.length > 0) {
    // 🔴 每条反例**各自带 `✗`**：变异脚本判定"是否被抓住"靠的是
    //    「预期关键词出现在**某条 ✗ 行**里」。如果三条反例共用一个 ✗ 头部行、
    //    明细行不带 ✗，那么"k1 被触发"和"k2 被触发"在判据上**无法区分** ——
    //    k1/k2/k3 三条断言就会退化成"整体有牙"，而不是**逐条**有牙。
    console.error(`✗ k) 幅度口径反例不成立 ${kBad.length} 处：`)
    for (const x of kBad) console.error(`✗   ${x}`)
    hardFail++
  } else if (library.length > 0) {
    console.log(
      `✓ 反例③ 动作库驱动：${library.length} 个可判定动作按**声明的 metric** 做足幅度都判完成，` +
        `且"只动别的量"都不判完成（${kAnySkipped} 个 metric=any 的动作按定义跳过反向检查）`,
    )
  }

  if (hardFail > 0) failed = true

  // ---- e) 取整灵敏度自检（守卫的守卫）----
  // 如果没有一条用例能把 `pyRound1` 与 `Math.round` 区分开，
  // 那「取整实现被偷偷换掉」本测试就发现不了 —— 这条守卫就是摆设。
  const mathRound = makeMathRoundVariant(sm, eq)
  const sensitive = []
  for (const c of payload.cases) {
    const a = eq.judgeExercise(c.frames, c.spec)
    const b = mathRound(c.frames, c.spec)
    if (!sameVerdict(a, b)) sensitive.push(c.name)
  }
  for (const s of sampleVerdicts) {
    const a = eq.judgeExercise(s.raw.frames, s.raw.spec)
    const b = mathRound(s.raw.frames, s.raw.spec)
    if (!sameVerdict(a, b)) sensitive.push(s.raw.name)
  }
  if (sensitive.length === 0) {
    console.error('✗ 取整灵敏度为 0：没有任何用例能区分「平局取偶」与「Math.round」')
    console.error('  → 这条守卫对取整实现的漂移毫无灵敏度，请补充取整平局点用例')
    failed = true
  } else {
    console.log(`✓ 取整灵敏度自检：${sensitive.length} 条用例能区分平局取偶 / Math.round（例：${sensitive.slice(0, 3).join('、')}）`)
  }

  if (failed) process.exit(1)
  console.log('✓ 前端 TS 与 Python 后端的动作完成度判定、动作分与逐动作明细完全一致')
}

main()
