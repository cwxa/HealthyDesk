/**
 * 时间戳契约守卫 —— 钉住「写入格式」与「本地日归属」这一对口径。
 *
 * 用法：node scripts/verify-timefmt.mjs
 *
 * ## 为什么需要它
 *
 * 桌面端此前用 `datetime.now().isoformat()`（**本地时间、无时区标记**）把帧的时间戳
 * 写进 `posture_score`，而所有按天判定都走 SQLite 的 `date(timestamp,'localtime')`
 * —— 该修饰符**假定输入是 UTC**。于是 SQLite 又减了一次本地偏移（UTC+8 下 8 小时）：
 *
 *     本地 16:00 之后的采样全部被算到「次日」
 *
 * 后果是仪表盘「今日均分」下午起不再增长、趋势图日期整体错位、保留期边界跟着偏，
 * 而错位的归档行一进 `posture_daily` 就长期保留 —— **错误被固化**。
 *
 * 🔴 这条缺陷在本项目的 CI 上**完全不可见**：runner 的 TZ 是 UTC、偏移为 0，
 * 本地串与 UTC 串恰好相同。所以守卫必须**显式构造跨日界的时刻**，并靠
 * 「源码断言写入端不再产生本地格式」+「行为断言契约格式的日归属正确」两头夹住，
 * 而不是指望换个环境它自己暴露。
 *
 * ## 判据与证据的分工
 *
 * 证据（真实 Python / 真实 SQLite / 真实迁移 SQL / 真实 rollup_daily）由
 * `scripts/timefmt-probe.py` 收集；**是绿是红一律由本文件断言**，与仓库里其余
 * `verify-*.mjs` 保持一致 —— 判据集中在一处才看得出守卫到底在守什么。
 *
 * ## 一处如实记录的盲区
 *
 * 「旧写法会错位」这条需要本机时区偏移非 0 才能复现。偏移为 0 时探针会返回
 * `legacy_misplaced: null`，本脚本会把该项记为**未覆盖**并单独打印 —— 不算失败，
 * 但也不假装验过（守卫的射程必须诚实，否则「全绿」会骗人）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const CONTRACT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** 探针里固定的往返时刻 —— 两端必须给出**同一个字符串**。 */
const FIXED_ISO = '2026-01-02T03:04:05.678Z'

let failed = false
const fail = (msg) => {
  console.error(`✗ ${msg}`)
  failed = true
}
const ok = (msg) => console.log(`✓ ${msg}`)

/**
 * 找一个能 `import aiosqlite` 的 Python。
 *
 * 🔴 找不到就**显式失败**，绝不降级成「跳过」—— 一条被静默跳过的守卫比没有守卫更糟，
 * 它会让 CI 报绿而实际什么都没验（本项目的铁律 #33）。
 */
function findPython() {
  const candidates = [
    process.env.NG_PYTHON,
    join(ROOT, '.buildenv', 'Scripts', 'python.exe'), // Windows 干净 venv
    join(ROOT, '.buildenv', 'bin', 'python'), // POSIX 干净 venv
    'python',
    'python3',
  ].filter(Boolean)

  for (const exe of candidates) {
    if ((exe.includes('/') || exe.includes('\\')) && !existsSync(exe)) continue
    const probe = spawnSync(exe, ['-c', 'import aiosqlite, sqlite3, sys; print(sys.version.split()[0])'], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    if (probe.status === 0) return { exe, version: probe.stdout.trim() }
  }
  return null
}

/** 读后端源码，剥掉注释后再做「不许再自己拼时间戳」的断言。 */
function backendSources() {
  const files = {
    camera: 'backend/ws/camera_ws.py',
    retention: 'backend/services/retention.py',
    data: 'backend/api/data.py',
    migrations: 'backend/db/migrations.py',
    timefmt: 'backend/services/timefmt.py',
  }
  const out = {}
  for (const [key, rel] of Object.entries(files)) {
    const text = readFileSync(join(ROOT, rel), 'utf8')
    out[key] = {
      rel,
      raw: text,
      // 去掉 `#` 开始的整行注释与行尾注释，避免「注释里提到了旧写法」被误判成违规。
      // ⚠️ 先把 CRLF 归一成 LF 再逐行剥 —— `.*$` 里的 `.` **不匹配 `\r`**，而
      //    非 multiline 的 `$` 只匹配字符串末尾，于是 CRLF 上这行剥注释**静默失效**。
      //    本机 `core.autocrlf` 检出的是 CRLF、CI 检出的是 LF，不归一就会出现
      //    「本机红、CI 绿」—— 守卫本身的分叉比它要抓的 bug 更难查。
      code: text
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((l) => l.replace(/\s*#.*$/, ''))
        .join('\n'),
    }
  }
  return out
}

function main() {
  const py = findPython()
  if (!py) {
    console.error('✗ 找不到可用的 Python（需要能 `import aiosqlite`）')
    console.error('  试过：$NG_PYTHON、.buildenv/Scripts/python.exe、.buildenv/bin/python、python、python3')
    console.error('  本机可用：.buildenv 是打包后端用的干净 venv（Py3.12.4），已装 aiosqlite')
    process.exit(1)
  }
  console.log(`Python：${py.exe}（${py.version}）`)

  const probe = spawnSync(py.exe, ['-u', 'scripts/timefmt-probe.py'], {
    encoding: 'utf8',
    cwd: ROOT,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (probe.status !== 0) {
    console.error('✗ 证据收集脚本失败（scripts/timefmt-probe.py）：')
    console.error((probe.stderr || probe.stdout || '').split('\n').slice(-25).join('\n'))
    process.exit(1)
  }

  let p
  try {
    p = JSON.parse(probe.stdout)
  } catch (e) {
    console.error(`✗ 探针输出不是合法 JSON：${e.message}`)
    console.error(probe.stdout.slice(0, 500))
    process.exit(1)
  }

  // ---- A. 契约格式 ----
  if (!p.contract.now_matches_contract) fail(`now_iso_ms() 产出不符合契约格式：${p.contract.now}`)
  if (!CONTRACT_RE.test(p.contract.now)) fail(`now_iso_ms() 未匹配契约正则：${p.contract.now}`)
  if (p.contract.roundtrip_fixed !== FIXED_ISO) {
    fail(`固定时刻往返不一致：python=${p.contract.roundtrip_fixed} 期望=${FIXED_ISO}`)
  }
  // 两端同一格式：JS 的 toISOString() 与 Python 的 to_iso_ms() 对同一瞬时给出同一串
  const jsBack = new Date(FIXED_ISO).toISOString()
  if (jsBack !== FIXED_ISO) fail(`JS toISOString() 往返不一致：${jsBack}`)
  const acceptsBad = p.contract.is_iso_ms_accepts.filter((s) => !CONTRACT_RE.test(s))
  if (acceptsBad.length) fail(`is_iso_ms() 该接受的被拒：${acceptsBad.join('、')}`)
  const rejectsBad = p.contract.is_iso_ms_rejects.filter((s) => CONTRACT_RE.test(s))
  if (rejectsBad.length) fail(`is_iso_ms() 该拒绝的被接受：${rejectsBad.join('、')}`)
  console.log(
    `A. 契约格式：now 匹配 / 固定往返两端同为 ${FIXED_ISO} / ` +
      `is_iso_ms 接受 ${p.contract.is_iso_ms_accepts.length} 例、拒绝 ${p.contract.is_iso_ms_rejects.length} 例`,
  )

  // ---- B. 本地日归属 ----
  const badClock = p.local_day.clock_samples.filter((s) => !s.ok)
  for (const s of badClock) {
    fail(`契约串的日归属错误：本地 ${s.local} → ${s.ts} 被算成 ${s.sql_day}（期望 ${s.expect}）`)
  }
  const badBounds = p.local_day.bounds.filter(
    (b) => !b.start_is_day || !b.end_is_next_day || !b.continuous || !b.start_is_contract,
  )
  for (const b of badBounds) {
    fail(
      `日边界不变式不成立 ${b.day}：start 落当天=${b.start_is_day} end 落次日=${b.end_is_next_day} ` +
        `连续=${b.continuous} 契约格式=${b.start_is_contract}（start=${b.start} end=${b.end}）`,
    )
  }
  console.log(
    `B. 本地日归属：${p.local_day.clock_samples.length} 个时刻（含 23:59 不跨天）+ ` +
      `${p.local_day.bounds.length} 天日边界不变式全部成立（本机偏移 ${p.local_day.offset_minutes} 分钟）`,
  )

  // B3) 旧写法的错位留证。偏移为 0 时不可复现 —— 如实报告为「未覆盖」。
  let uncovered = 0
  const legacy = p.local_day.legacy_misplaced
  if (legacy === null) {
    uncovered++
    console.warn(
      '⚠ 未覆盖：本机时区偏移为 0（本地串与 UTC 串相同），「写入本地格式会跨日错位」这条' +
        '在本机不可复现 —— CI runner 同理。该项不计失败，但也不算验过。',
    )
  } else if (!legacy.misplaced) {
    fail(
      `负样本未生效：本地 ${legacy.hour_local} 点写入的本地串 ${legacy.ts}，` +
        `SQLite 归属 ${legacy.sql_day} 与真实日 ${legacy.true_day} 相同 —— ` +
        `说明该构造在本机时区（偏移 ${legacy.offset_minutes} 分钟）下不会跨日，负样本失去意义`,
    )
  } else {
    console.log(
      `✓ 负样本留证：本地 ${legacy.hour_local}:00 写入的旧格式串 ${legacy.ts} ` +
        `被 SQLite 算成 ${legacy.sql_day}（真实日 ${legacy.true_day}）—— 这正是本次修复的缺陷`,
    )
  }

  // ---- C. SQL 分组键 与 区间窗口 必须同源 ----
  if (!p.grouping.counts_match) fail('SQL 分组键(date(ts,localtime)) 与区间窗口(local_day_bounds_utc) 的天计数不一致')
  if (!p.grouping.total_match) {
    fail(
      `SQL 分组键与区间窗口的样本总数不一致 —— 有样本落在窗口之外被漏掉` +
        `（这正是「把本地零点换成 UTC 零点」那类回归的形态：本地凌晨的样本会消失）`,
    )
  }
  console.log(
    `C. 归档取数同源：${p.grouping.sql_days.length} 天、${p.grouping.sample_total} 条样本，` +
      `两套实现的按天计数逐天相等、总量守恒（含压日界的本地 01:00 / 23:30 样本）`,
  )

  // ---- D. 迁移 ----
  const m = p.migration
  // 实验前提：库里必须**同时**有旧格式串与已经是契约格式的串。缺任何一批，
  // 后面的断言就有相当一部分变成了空转（"验了"与"验到了"是两件事）。
  if (m.legacy_rows_before !== m.legacy_count) {
    fail(`实验前提不成立：本应有 ${m.legacy_count} 条旧格式串，实际 ${m.legacy_rows_before} 条（这个实验什么都没验到）`)
  }
  if (m.native_ids_found !== m.native_count) {
    fail(`实验前提不成立：本应有 ${m.native_count} 条已是契约格式的串，实际识别出 ${m.native_ids_found} 条`)
  }
  if (!m.native_untouched) {
    fail('已经是 UTC Z 的记录被迁移改动过 —— 转换条件没有排除带时区标记的串（会把它再减一次本地偏移）')
  }
  if (!m.all_after_contract) fail(`迁移后仍有非契约格式的时间戳：${JSON.stringify(m.after_sample)}`)
  if (!m.local_day_preserved) fail('迁移前后「本地日」发生了变化 —— 转换把记录挪到了别的日子')
  if (!m.stale_day_kept) fail(`保留范围之外的归档被删掉了（${m.stale_day}）—— 那些天的原始采样早已清理，删了即永久丢失`)
  if (m.stale_day_count_kept !== 999) fail(`范围外归档被重算过：${m.stale_day} 的 sample_count 应为 999，实得 ${m.stale_day_count_kept}`)
  if (!m.misplaced_day_removed) fail(`错位产生的幽灵归档行未被清掉（${m.misplaced_day}）`)
  if (m.expected_days.includes(m.misplaced_day)) fail(`归档的日期集合仍包含幽灵日 ${m.misplaced_day}`)
  if (!m.counts_match) fail('归档行的 sample_count 与按本地日区间查出的条数不一致（归档与窗口不同源）')
  if (m.counts_checked < 2) fail(`归档同源只验了 ${m.counts_checked} 天，样本不足`)
  // 总量守恒：不管怎么切天，各天样本数之和必须等于原始表总行数。
  // 窗口若错位（例如把「本地零点」换成「UTC 零点」），本地凌晨那部分样本会被**静默
  // 漏掉**，而上面那条「归档 == 窗口」反而恒成立（rollup 用的就是同一个窗口）——
  // 只有这条能抓住那类回归。
  if (!m.total_conserved) {
    fail(`归档样本总数 ${m.archived_total} != 原始表总行数 ${m.raw_total} —— 有样本被日窗口漏掉或重复计入`)
  }
  if (!m.archived_days_exact) {
    fail(
      `覆盖范围内的归档天集合与原始表的本地日分组不一致：` +
        `归档=${JSON.stringify(m.daily_after ? Object.keys(m.daily_after) : [])} 期望=${JSON.stringify(m.expected_days)}`,
    )
  }
  const idemBad = Object.entries(m.idempotent || {}).filter(([, v]) => !v)
  for (const [day] of idemBad) fail(`迁移/重算不幂等：${day} 第二次的结果与第一次不同`)
  if (!m.idempotent_days_same) fail('迁移/重算不幂等：第二次的天集合与第一次不同')
  console.log(
    `D. 迁移：${m.legacy_rows_before} 条旧格式串 → 全部契约格式、逐条本地日不变；` +
      `范围外归档保留（${m.stale_day}=999）、幽灵行清除（${m.misplaced_day}）、` +
      `归档与区间窗口同源（${m.counts_checked} 天）、二次执行幂等`,
  )

  // ---- E. 源码守卫：写入端不许再自己拼时间戳 ----
  const src = backendSources()
  // 灵敏度自检：剥注释必须**真的生效**。CRLF 会让 `\s*#.*$` 静默失效
  // （`.` 不匹配 `\r`，非 multiline 的 `$` 又只匹配串尾）→ 注释里的旧写法被当成违规，
  // 出现「本机（autocrlf）红、CI（checkout 成 LF）绿」这种最难查的分叉。
  for (const key of Object.keys(src)) {
    if (src[key].raw.includes('#') && src[key].code.includes('#')) {
      fail(`剥注释在 ${src[key].rel} 上没生效（CRLF 让 \`.*$\` 匹配失败？）—— 源码守卫会因此误报`)
    }
  }
  if (/datetime\.now\(\)\s*\.\s*isoformat\s*\(/.test(src.camera.code)) {
    fail(`${src.camera.rel} 仍在用 datetime.now().isoformat()（本地时间、无时区标记）—— 这正是本次修复的根因`)
  }
  if (!/now_iso_ms\s*\(/.test(src.camera.code)) {
    fail(`${src.camera.rel} 未使用 services.timefmt.now_iso_ms()，帧时间戳的格式不再受契约约束`)
  }
  // 「自己拼时间戳格式」的特征：直接 strftime 出 `%Y-%m-%dT...`
  const OWN_IMPL_RE = /strftime\s*\(\s*['"]%Y-%m-%dT/
  // ⚠️ 唯一允许的例外是 `db/migrations.py`：迁移 4 的 SQL 里必然要写
  // `strftime('%Y-%m-%dT%H:%M:%fZ', timestamp, 'utc')` —— 那是把**存量数据**从旧格式
  // 搬运成新格式的 SQL 表达式，逐行转换在 Python 里做不了。它不产生「当前时刻」，
  // 只搬运旧值，所以不受「单点定义」约束；其行为正确性由上面 D 段实测保证。
  for (const key of ['retention', 'data', 'camera']) {
    if (OWN_IMPL_RE.test(src[key].code)) {
      fail(`${src[key].rel} 自己拼了时间戳格式 —— 必须复用 services/timefmt.py（单点定义）`)
    }
  }
  if (!OWN_IMPL_RE.test(src.timefmt.code)) {
    fail(`${src.timefmt.rel} 里找不到时间戳格式化实现 —— 单点定义被搬走了？`)
  }
  console.log(
    `E. 源码守卫：相机链路用 now_iso_ms()、四个调用方均无自建格式化（唯一实现在 ${src.timefmt.rel}）`,
  )

  console.log('')
  if (failed) {
    console.error('✗ 时间戳契约守卫未通过')
    process.exit(1)
  }
  console.log(
    `✓ 时间戳契约成立：写入 UTC 毫秒+Z、本地日归属正确、归档与窗口同源、迁移幂等` +
      (uncovered ? `（⚠ ${uncovered} 项因本机时区偏移为 0 未覆盖）` : ''),
  )
}

main()
