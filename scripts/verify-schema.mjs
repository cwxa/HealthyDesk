/**
 * 表结构守卫：迁移引擎 + 迁移 5 + **三处字段定义的同构**。
 *
 * 用法：
 *   1. 先由 Python 收集证据：
 *        python scripts/schema-probe.py > .buildenv/schema.json
 *   2. node scripts/verify-schema.mjs [证据文件路径]     # 默认 .buildenv/schema.json
 *
 * 为什么需要它（三块都没有别的守卫覆盖）：
 *
 * 1. 🔴 **迁移必须是幂等的，而 SQLite 没有 `ADD COLUMN IF NOT EXISTS`。** 迁移 5 加一列，
 *    只能写成"先查 `PRAGMA table_info` 再 ALTER"的可调用迁移。裸 SQL 的失败形态很隐蔽：
 *    迁移**成功**、版本号**没记上**（那两步之间进程被杀掉），于是下次启动**重放**它 →
 *    抛 "duplicate column name" → 应用再也起不来。
 *    ⚠️ 只跑一次 `apply_migrations` 是验不到这条的：runner 会按版本号
 *    `if version <= start: continue` 跳过已应用的迁移。所以 D 段**显式构造**了
 *    "删掉版本行再跑一次"的状态 —— 这一点是被变异测试 S1 逼出来的（去掉迁移里的
 *    存在性判断，只跑常规重跑会全绿）。现有的 `verify-timefmt.mjs` 只验**迁移 4 的 SQL**。
 * 2. **迁移编号连续递增**是 `MIGRATIONS` 列表的硬要求，此前没有任何地方断言过。
 * 3. 🔴 **同一个字段在三处各写了一遍**：桌面 `db/migrations.py` 的列、移动端
 *    `localDb.ts` 的行接口、导出规格 `exportFormat.ts` 的 `TABLE_FIELDS`。
 *    漂开的后果是**静默**的 —— 桌面能存、导出文件里没有、或手机上读不出来，
 *    而没有任何一处会报错。迁移 5 正好给了一次机会把这条钉住。
 *
 * 判据全部来自 `schema-probe.py` 摆出来的事实（真实 `apply_migrations`、真实 SQLite），
 * 不在这里重算一遍 —— 那样就成了"我自己实现一遍再跟自己比"。
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { unlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const require = createRequire(join(ROOT, 'package.json'))

const PROBE = join(ROOT, 'scripts', 'schema-probe.py')
const DEFAULT_EVIDENCE = join(ROOT, '.buildenv', 'schema.json')

let failed = false
const fail = (msg) => {
  console.error(`✗ ${msg}`)
  failed = true
}

/** 找一个能 import aiosqlite 的 python（与 verify-timefmt.mjs 同一套候选顺序）。 */
function findPython() {
  const candidates = [
    process.env.NG_PYTHON,
    join(ROOT, '.buildenv', 'Scripts', 'python.exe'),
    join(ROOT, '.buildenv', 'bin', 'python'),
    'python',
    'python3',
  ].filter(Boolean)
  for (const exe of candidates) {
    if ((exe.includes('/') || exe.includes('\\')) && !existsSync(exe)) continue
    try {
      execFileSync(exe, ['-c', 'import aiosqlite'], { stdio: 'ignore', cwd: ROOT })
      return exe
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

/**
 * 跑探针拿事实。传了路径就当证据文件已存在，直接读。
 *
 * ⚠️ 用**异步** execFile 且带重试：Windows 上紧挨着前一次 spawn 再同步启动同一个
 * venv 里的 `python.exe` 会偶发 `EBUSY`（杀软/文件索引持有句柄），同步版没有喘息的机会，
 * 直接抛栈崩掉 —— 那种红是"脚本自己坏了"，与被测的表结构无关。
 */
async function loadEvidence() {
  const given = process.argv[2]
  if (given) {
    if (!existsSync(given)) {
      console.error(`✗ 找不到证据文件 ${given}`)
      process.exit(2)
    }
    return JSON.parse(readFileSync(given, 'utf8'))
  }
  const py = findPython()
  if (!py) {
    console.error('✗ 找不到能 import aiosqlite 的 python（设 NG_PYTHON 或建 .buildenv venv）')
    process.exit(2)
  }
  let lastErr
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const { stdout } = await execFileP(py, [PROBE], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      return JSON.parse(stdout)
    } catch (err) {
      lastErr = err
      if (err.code !== 'EBUSY') throw err
      await sleep(150 * attempt)
    }
  }
  throw lastErr
}

/** 把前端真实源码 bundle 出来（读的是源码，不是内联副本）。 */
async function loadExportFormat() {
  let esbuild
  try {
    esbuild = require('esbuild')
  } catch {
    console.error('✗ 找不到 esbuild（vite 的依赖）。请先 npm install。')
    process.exit(2)
  }
  const built = await esbuild.build({
    entryPoints: [join(ROOT, 'src', 'platform', 'exportFormat.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    logLevel: 'silent',
  })
  const out = join(tmpdir(), `neckguardian-schema-${process.pid}.mjs`)
  writeFileSync(out, built.outputFiles[0].text)
  const mod = await import(pathToFileURL(out).href)
  try {
    unlinkSync(out)
  } catch {
    /* 删除失败不影响校验 */
  }
  return mod
}

/**
 * 从 `localDb.ts` 源码里取出 `ActivityLogRecord` 的键集合。
 *
 * ⚠️ 为什么是**源码级**解析：接口是 TS **类型**，运行时不存在（项目铁律：
 * "类型在运行时不存在，对拍脚本拿不到值"）。所以只能剥注释后按正则取 ——
 * 与 `verify-timefmt.mjs` 的 §E 源码守卫同一手法。
 * 代价是它只能抓"字段增减"，抓不到类型变化；这已经足够，因为这里要比的就是**字段名**。
 */
function mobileActivityLogKeys() {
  const src = readFileSync(join(ROOT, 'src', 'platform', 'localDb.ts'), 'utf8')
    .replace(/\r\n/g, '\n')
  // 先剥掉块注释与行注释，避免注释里出现的字段名被算进来
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const m = code.match(/export interface ActivityLogRecord \{([\s\S]*?)\n\}/)
  if (!m) throw new Error('在 localDb.ts 里找不到 ActivityLogRecord 接口（改名了？正则要跟着改）')
  const keys = new Set()
  for (const line of m[1].split('\n')) {
    const km = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\??\s*:/)
    if (km) keys.add(km[1])
  }
  return [...keys].sort()
}

async function main() {
  const ev = await loadEvidence()
  const mod = await loadExportFormat()

  // ---- A) 迁移清单：编号连续递增、LATEST_VERSION 一致、至少有一条可调用迁移 ----
  const nums = ev.migration_numbers
  if (nums.length === 0) fail('迁移清单是空的')
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) fail(`迁移编号必须从 1 连续递增，第 ${i + 1} 个是 ${nums[i]}`)
  }
  if (ev.latest_version !== nums[nums.length - 1]) {
    fail(`LATEST_VERSION=${ev.latest_version} 与清单最后一项 ${nums[nums.length - 1]} 不一致`)
  }
  if (!ev.callable_migrations.includes(ev.latest_version)) {
    fail(
      `迁移 ${ev.latest_version} 不是可调用迁移 —— SQLite 没有 ADD COLUMN IF NOT EXISTS，` +
        `加列写成裸 SQL 就不幂等（第二次执行抛 duplicate column name）`,
    )
  }
  console.log(
    `A. 迁移清单：v${nums.join(', v')}（连续递增），LATEST_VERSION=${ev.latest_version}，` +
      `可调用迁移 = ${ev.callable_migrations.map((v) => `v${v}`).join(', ')}`,
  )

  // ---- B) 空库跑完所有迁移：新列在，且只出现一次 ----
  const freshCols = ev.fresh.columns.activity_log ?? []
  const colName = ev.action_scores_column
  const freshHits = freshCols.filter((c) => c === colName).length
  if (ev.fresh.version !== ev.latest_version) {
    fail(`空库迁移后版本是 ${ev.fresh.version}，期望 ${ev.latest_version}`)
  }
  if (freshHits !== 1) fail(`空库的 activity_log 里 ${colName} 列出现 ${freshHits} 次（期望 1 次）`)
  console.log(`B. 空库：迁移到 v${ev.fresh.version}，activity_log 列为 ${freshCols.join(' / ')}`)

  // ---- C) v4 老库升级 ----
  const up = ev.upgrade
  // 实验前提：老库必须**真的没有**这一列，否则下面几条等于空转（"验了"与"验到了"是两件事）
  if (up.has_column_before) fail(`实验前提不成立：老库本来就有 ${colName} 列，这个实验什么都没验到`)
  if (up.version_after !== ev.latest_version) {
    fail(`老库升级后版本是 ${up.version_after}，期望 ${ev.latest_version}`)
  }
  if (up.after_rows !== up.before_rows) {
    fail(`升级把活动记录搞丢/搞重了：升级前 ${up.before_rows} 条，升级后 ${up.after_rows} 条`)
  }
  if (JSON.stringify(up.after_avg_scores) !== JSON.stringify(up.before_avg_scores)) {
    fail(`升级改动了老数据：avg_score ${JSON.stringify(up.before_avg_scores)} → ${JSON.stringify(up.after_avg_scores)}`)
  }
  if (up.after_action_scores.some((v) => v !== null)) {
    fail(
      `老行的新列不是 NULL（${JSON.stringify(up.after_action_scores)}）—— ` +
        `"这个版本还没有这项数据"与"本次一个动作都没判出来"必须能区分`,
    )
  }
  if (up.after_columns.filter((c) => c === colName).length !== 1) {
    fail(`升级后 ${colName} 列不是恰好一列：${JSON.stringify(up.after_columns)}`)
  }
  console.log(
    `C. v4 老库升级：${up.before_rows} 条记录全部保留、avg_score 逐条不变、` +
      `新列在旧行上为 NULL（列 ${up.before_columns.length} → ${up.after_columns.length}）`,
  )

  // ---- D) 幂等 ----
  // 分两段，因为它们的强度完全不同：
  //   D1 直接再跑一遍 `apply_migrations` —— 其实很弱：runner 会按版本号跳过已应用的迁移。
  //   D2 **构造"成功但版本号没记上"**（删掉最新版本行）后再跑 —— 迁移会在"列已存在"的库上
  //      真正重放一遍。这才是幂等性要防的场景，也是 `ADD COLUMN` 这类迁移唯一会炸的路径。
  //      🔴 这一条是被变异测试 S1 逼出来的（去掉迁移里的存在性判断，只跑 D1 会**全绿**）。
  if (up.second_error) fail(`迁移不幂等（常规重跑）：第二次执行抛异常 —— ${up.second_error}`)
  if (up.second_version !== up.version_after) {
    fail(`第二次执行的版本 ${up.second_version} 与第一次 ${up.version_after} 不同`)
  }
  if (JSON.stringify(up.second_columns) !== JSON.stringify(up.after_columns)) {
    fail(`第二次执行改变了列集合：${JSON.stringify(up.after_columns)} → ${JSON.stringify(up.second_columns)}`)
  }
  if (up.second_rows !== up.after_rows) fail(`第二次执行改动了行数：${up.after_rows} → ${up.second_rows}`)

  if (up.replay_error) {
    fail(
      `迁移不幂等（版本号丢失后重放）：抛异常 —— ${up.replay_error}\n` +
        `    → 这条就是"迁移成功但版本号没记上"之后的表现；线上会变成应用起不来`,
    )
  }
  if (up.replay_version !== ev.latest_version) {
    fail(`版本号丢失后重放，版本停在 ${up.replay_version}，期望 ${ev.latest_version}`)
  }
  if (JSON.stringify(up.replay_columns) !== JSON.stringify(up.after_columns)) {
    fail(`版本号丢失后重放改变了列集合：${JSON.stringify(up.replay_columns)}`)
  }
  if (up.replay_rows !== up.after_rows) {
    fail(`版本号丢失后重放改动了行数：${up.after_rows} → ${up.replay_rows}`)
  }
  if (JSON.stringify(up.version_rows) !== JSON.stringify(nums)) {
    fail(`schema_version 表里的编号是 ${JSON.stringify(up.version_rows)}，期望 ${JSON.stringify(nums)}（不许重复）`)
  }
  console.log(
    `D. 幂等：常规重跑不变；**删掉版本号后再跑一次**（模拟"成功但没记上"）仍不报错、` +
      `列集合与行数不变、版本回到 v${up.replay_version}`,
  )

  // ---- E) 🔴 三处字段定义必须同构 ----
  // 桌面（SQLite 列，去掉自增主键 id）↔ 导出规格 ↔ 移动端行接口。
  // `id` 在导出里**没有**：导入是删除重建、id 会重排，所以它不属于跨端数据（见 exportFormat）。
  const desktop = freshCols.filter((c) => c !== 'id').sort()
  const exported = mod.TABLE_FIELDS.activity_log.map(([name]) => name).sort()
  let mobile = []
  try {
    mobile = mobileActivityLogKeys().filter((k) => k !== 'id')
  } catch (e) {
    fail(`解析移动端行接口失败：${e.message}`)
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
  if (!same(desktop, exported)) {
    fail(`桌面列与导出规格不一致：桌面 ${JSON.stringify(desktop)} vs 导出 ${JSON.stringify(exported)}`)
  }
  if (!same(desktop, mobile)) {
    fail(`桌面列与移动端行接口不一致：桌面 ${JSON.stringify(desktop)} vs 移动端 ${JSON.stringify(mobile)}`)
  }
  if (!failed) {
    console.log(
      `E. 三处字段同构：桌面 activity_log 列（去 id）== 导出规格 == 移动端 ActivityLogRecord ` +
        `= [${desktop.join(', ')}]`,
    )
  }

  console.log('')
  if (failed) {
    console.error('✗ 表结构守卫未通过')
    process.exit(1)
  }
  console.log('✓ 表结构与迁移成立：编号连续、加列幂等、老数据不丢、三处字段同构')
}

main()
