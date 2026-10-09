import * as db from '../src/platform/localDb'
import { rollupDaily } from '../src/platform/localMaintenance'
import { buildExport, validateExport, buildDailyCsv } from '../src/platform/exportFormat'

const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }

export async function runStorageTests() {
  // 此页面运行在新建测试 Chrome profile 中，实际执行 v2 → v3 IndexedDB 升级。
  const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('neckguardian', 2)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('posture_daily', { keyPath: 'date' })
      request.result.createObjectStore('posture_score', { keyPath: 'id', autoIncrement: true }).createIndex('timestamp', 'timestamp')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const archival = { date: '2020-01-01', sample_count: 10, score_sum: 900, min_score: 80, head_bad_count: 0, shoulder_bad_count: 0, spine_bad_count: 0, updated_at: '2020-01-01T00:00:00.000Z' }
  await new Promise<void>((resolve, reject) => {
    const tx = oldDb.transaction(['posture_daily', 'posture_score'], 'readwrite')
    tx.objectStore('posture_daily').put(archival)
    tx.objectStore('posture_score').add({ timestamp: '2026-10-08T03:00:00.000Z', head_angle: 0, shoulder_diff: 0, spine_angle: 0, score: 10 })
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  oldDb.close()
  check((await db.getDailyRows()).length === 0, 'Legacy archive must not enter current-version statistics')
  const all = await db.getDailyRows(undefined, null)
  check(all.length === 1 && all[0].metric_version === 1 && all[0].score_sum === 900, 'Upgrade must preserve legacy archive')
  await db.addPostureRecord({ timestamp: '2026-10-08T03:00:00.000Z', head_angle: 0, shoulder_diff: 0, spine_angle: 0, score: 90, metric_version: 2 })
  check(await rollupDaily() === 2, 'Same-day legacy/current samples must create two aggregates')
  const rows = await db.getDailyRows('2026-10-08', null)
  check(rows.length === 2, 'Composite archive key must preserve both metric versions')
  check(rows.find(r => r.metric_version === 1)?.score_sum === 10, 'Legacy score sum changed')
  check(rows.find(r => r.metric_version === 2)?.score_sum === 90, 'Current score sum mixed with legacy data')
  check(await rollupDaily() === 0, 'Versioned rollup must be idempotent')
  check((await db.getDailyRows('2026-10-08')).length === 1, 'Current-version filter failed')
  const result = buildExport({ posture_daily: await db.readAllRows('posture_daily'), posture_score: await db.readAllRows('posture_score') }, '1.7.2', db.DB_VERSION, '2026-10-08T03:00:00.000Z')
  const imported = validateExport(result.bundle)
  check(imported.ok, 'Export round-trip failed')
  check(result.bundle.format_version === 2, 'Versioned archive requires export format v2')
  const legacy = validateExport({ ...result.bundle, format_version: 1, tables: { ...result.bundle.tables, posture_daily: [archival] } })
  check(legacy.ok && legacy.bundle?.tables.posture_daily[0].metric_version === 1, 'Format v1 import must assign legacy measurement version')
  if (!imported.bundle) throw new Error('Missing import bundle')
  await db.replaceStoreRows('posture_daily', imported.bundle.tables.posture_daily)
  check((await db.getDailyRows(undefined, null)).length === 3, 'Import must preserve both metric versions and legacy archive')
  check(buildDailyCsv(rows).includes('测量版本'), 'CSV must identify measurement version')
  // 老备份没有版本字段时，归档仍应归为 v1，不报 DataError。
  await db.replaceStoreRows('posture_daily', [archival])
  check((await db.getDailyRows(undefined, null))[0].metric_version === 1, 'Legacy backup default version failed')
  return { passed: true, checks: 15, schema: db.DB_VERSION }
}
