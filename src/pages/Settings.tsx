import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useApi } from '../hooks/useApi'
import { useAI } from '../hooks/useAI'
import { isMobile, platformLabel } from '../platform/runtime'
import { data, exportFileName } from '../platform/dataLayer'
import type { DataStatus } from '../platform/dataLayer'
import { MAX_RETENTION_DAYS, MIN_RETENTION_DAYS, clampRetentionDays } from '../platform/dailyAgg'
import { pickTextFile, saveTextFile } from '../platform/dataFiles'
import { formatBytes } from '../utils/format'
import type { Settings as SettingsType } from '../types'
import { EyeIcon, EyeOffIcon } from '../components/icons'

const DEFAULT_MODELS = ['deepseek-chat', 'deepseek-reasoner']

export default function Settings() {
  const { get, put } = useApi()
  const { fetchConfig, saveConfig, testConnection } = useAI()
  const [settings, setSettings] = useState<SettingsType>({
    reminder_interval: '30',
    ai_enabled: 'false',
    auto_start: 'false',
    voice_enabled: 'true',
  })
  const [saved, setSaved] = useState(false)
  const [appVersion, setAppVersion] = useState('')

  // ---- DeepSeek 配置状态 ----
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [keyMasked, setKeyMasked] = useState('')
  const [hasKey, setHasKey] = useState(false)
  const [baseUrl, setBaseUrl] = useState('https://api.deepseek.com')
  const [model, setModel] = useState('deepseek-chat')
  const [models, setModels] = useState<string[]>(DEFAULT_MODELS)
  const [aiSaving, setAiSaving] = useState(false)
  const [aiMsg, setAiMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [testing, setTesting] = useState(false)

  // ---- 数据管理状态（导出 / 导入 / 清除 / 保留期） ----
  const [dataStatus, setDataStatus] = useState<DataStatus | null>(null)
  const [dataBusy, setDataBusy] = useState<DataBusy>(null)
  const [dataMsg, setDataMsg] = useState<DataMsg | null>(null)
  /** 清除是两步：第一次点击只切到"确认"，避免误触把数据删了。 */
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    window.electronAPI?.getAppVersion?.().then(setAppVersion).catch(() => {})
  }, [])

  useEffect(() => {
    get<Record<string, string>>('/api/settings').then((data) => {
      setSettings({
        reminder_interval: data.reminder_interval || '30',
        ai_enabled: data.ai_enabled || 'false',
        auto_start: data.auto_start || 'false',
        voice_enabled: data.voice_enabled || 'true',
      })
    }).catch(console.error)
  }, [get])

  const loadAIConfig = useCallback(() => {
    fetchConfig().then((cfg) => {
      setHasKey(cfg.has_api_key)
      setKeyMasked(cfg.api_key_masked || '')
      setBaseUrl(cfg.base_url || 'https://api.deepseek.com')
      setModel(cfg.model || 'deepseek-chat')
      if (cfg.available_models?.length) setModels(cfg.available_models)
    }).catch(console.error)
  }, [fetchConfig])

  useEffect(() => { loadAIConfig() }, [loadAIConfig])

  const updateSetting = async (key: string, value: string) => {
    setSettings((s) => ({ ...s, [key]: value }))
    try {
      await put('/api/settings', { key, value })
      if (key === 'auto_start') {
        window.electronAPI?.setAutoStart(value === 'true')
      }
      if (key === 'reminder_interval' && isMobile()) {
        window.dispatchEvent(new CustomEvent('reminder-interval-changed', {
          detail: { minutes: parseInt(value) || 30 },
        }))
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      console.error('Failed to save setting:', err)
    }
  }

  const saveAIConfig = async () => {
    setAiSaving(true)
    setAiMsg(null)
    try {
      const cfg = await saveConfig({
        api_key: apiKeyInput.trim() || undefined,
        base_url: baseUrl.trim(),
        model: model.trim(),
      })
      setApiKeyInput('')
      setHasKey(cfg.has_api_key)
      setKeyMasked(cfg.api_key_masked || '')
      setAiMsg({ kind: 'ok', text: '配置已保存' })
    } catch (e) {
      setAiMsg({ kind: 'err', text: '保存失败，请重试' })
      console.error('Save AI config failed:', e)
    } finally {
      setAiSaving(false)
      setTimeout(() => setAiMsg(null), 3000)
    }
  }

  const runTest = async () => {
    setTesting(true)
    setAiMsg(null)
    try {
      const res = await testConnection()
      if (res.ok) {
        setAiMsg({ kind: 'ok', text: `连接成功 · ${res.model || model}` })
      } else {
        setAiMsg({ kind: 'err', text: res.error || '连接失败' })
      }
    } catch (e) {
      setAiMsg({ kind: 'err', text: '测试请求失败，请检查后端是否运行' })
      console.error('Test AI connection failed:', e)
    } finally {
      setTesting(false)
    }
  }

  // -------------------- 数据管理 --------------------
  //
  // 三条语义在两端一致（桌面 backend/api/data.py、移动 localData.ts）：
  // 导出不含 API Key；导入=覆盖数据表（设置项合并）；清除只清健康数据。

  const refreshDataStatus = useCallback(() => {
    data.getDataStatus().then(setDataStatus).catch((e) => {
      console.error('读取存储状态失败:', e)
    })
  }, [])

  useEffect(() => { refreshDataStatus() }, [refreshDataStatus])

  const handleExportJson = async () => {
    setDataBusy('export')
    setDataMsg(null)
    try {
      const { bundle, skipped } = await data.exportData()
      const rows = Object.values(bundle.tables).reduce((n, r) => n + r.length, 0)
      const out = await saveTextFile(exportFileName('json'), JSON.stringify(bundle, null, 2))
      if (!out.saved) return // 用户主动取消：不提示，也不报错
      setDataMsg({
        kind: 'ok',
        text: `已导出 ${rows} 行（不含 DeepSeek API Key）${skippedText(skipped)}`,
      })
    } catch (e) {
      console.error('导出备份失败:', e)
      setDataMsg({ kind: 'err', text: '导出失败，请重试' })
    } finally {
      setDataBusy(null)
    }
  }

  const handleExportCsv = async () => {
    setDataBusy('csv')
    setDataMsg(null)
    try {
      const csv = await data.exportDailyCsv()
      const days = Math.max(0, csv.split('\r\n').filter((l) => l.trim()).length - 1)
      const out = await saveTextFile(exportFileName('csv'), csv, 'text/csv')
      if (!out.saved) return
      setDataMsg(days > 0
        ? { kind: 'ok', text: `已导出 ${days} 天的每日汇总` }
        : { kind: 'warn', text: '还没有每日归档，导出的是空表头（先记录一会儿数据再导）' })
    } catch (e) {
      console.error('导出 CSV 失败:', e)
      setDataMsg({ kind: 'err', text: '导出失败，请重试' })
    } finally {
      setDataBusy(null)
    }
  }

  const handleImport = async () => {
    setDataMsg(null)
    let picked: { name: string; text: string } | null
    try {
      picked = await pickTextFile()
    } catch (e) {
      console.error('读取文件失败:', e)
      setDataMsg({ kind: 'err', text: '读取文件失败' })
      return
    }
    if (!picked) return // 取消选择

    let payload: unknown
    try {
      payload = JSON.parse(picked.text)
    } catch {
      setDataMsg({ kind: 'err', text: `「${picked.name}」不是有效的 JSON 文件` })
      return
    }

    setDataBusy('import')
    try {
      const res = await data.importData(payload)
      if (!res.ok) {
        setDataMsg({ kind: 'err', text: importErrorText(res.error) })
        return
      }
      const rows = Object.values(res.imported).reduce<number>((n, v) => n + (v ?? 0), 0)
      setDataMsg({
        kind: 'ok',
        text: `已导入 ${rows} 行：原有健康数据被覆盖，设置项为合并 ${skippedText(res.skipped)}`,
      })
      refreshDataStatus()
    } catch (e) {
      console.error('导入失败:', e)
      setDataMsg({ kind: 'err', text: '导入失败，请检查后端是否在运行' })
    } finally {
      setDataBusy(null)
    }
  }

  const handleClear = async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      setDataMsg({
        kind: 'warn',
        text: '再点一次即清除本机全部健康数据（不可恢复）。设置与 API Key 不受影响。',
      })
      setTimeout(() => setConfirmClear(false), 8000)
      return
    }
    setConfirmClear(false)
    setDataBusy('clear')
    setDataMsg(null)
    try {
      const cleared = await data.clearHealthData()
      const rows = Object.values(cleared).reduce<number>((n, v) => n + (v ?? 0), 0)
      setDataMsg({
        kind: 'ok',
        text: `已清除 ${rows} 行健康数据（提醒间隔、AI 配置等设置已保留）`,
      })
      refreshDataStatus()
    } catch (e) {
      console.error('清除数据失败:', e)
      setDataMsg({ kind: 'err', text: '清除失败，请重试' })
    } finally {
      setDataBusy(null)
    }
  }

  /**
   * 改保留期后**立刻跑一次维护**：后台是 30 分钟一轮，不主动触发的话
   * 用户看不到任何变化，会以为设置没生效。
   */
  const handleRetentionChange = async (raw: string) => {
    const days = clampRetentionDays(raw)
    setDataBusy('retention')
    setDataMsg(null)
    try {
      await updateSetting('retention_days', String(days))
      const res = await data.maintainData()
      refreshDataStatus()
      setDataMsg({
        kind: 'ok',
        text: res.samplesDeleted > 0
          ? `保留期已设为 ${res.keepDays} 天，已清理 ${res.samplesDeleted} 条超期原始采样`
          : `保留期已设为 ${res.keepDays} 天，暂无需清理的原始采样`,
      })
    } catch (e) {
      console.error('保存保留期失败:', e)
      setDataMsg({ kind: 'err', text: '保存保留期失败，请重试' })
    } finally {
      setDataBusy(null)
    }
  }

  return (
    <div>
      <motion.h2
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        style={{ fontSize: 24, fontWeight: 700, marginBottom: 24 }}
      >
        ⚙ 系统设置
      </motion.h2>

      <div style={{ maxWidth: 600, margin: '0 auto' }}>
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          style={cardStyle}
        >
          <SettingRow
            label="提醒间隔（分钟）"
            description="每工作多少分钟提醒一次肩颈放松（最少2分钟）"
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                min="2"
                max="120"
                value={settings.reminder_interval}
                onChange={(e) => {
                  const value = parseInt(e.target.value) || 2
                  const clamped = Math.max(2, Math.min(120, value))
                  updateSetting('reminder_interval', String(clamped))
                }}
                style={{
                  width: 80,
                  padding: '8px 12px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  fontSize: 14,
                  textAlign: 'center',
                }}
              />
              <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>分钟</span>
            </div>
          </SettingRow>

          {/* AI 增强模式仅桌面端有效（移动端无后端，本期不支持 AI） */}
          {!isMobile() && (
            <SettingRow
              label="AI 增强模式"
              description="连接 DeepSeek 大模型，对肩颈情况生成个性化分析与建议"
            >
              <label style={switchContainer}>
                <input
                  type="checkbox"
                  checked={settings.ai_enabled === 'true'}
                  onChange={(e) => updateSetting('ai_enabled', e.target.checked ? 'true' : 'false')}
                  style={{ display: 'none' }}
                />
                <span style={{
                  ...switchTrack,
                  background: settings.ai_enabled === 'true' ? 'var(--primary)' : '#ccc',
                }}>
                  <motion.span
                    animate={{ x: settings.ai_enabled === 'true' ? 20 : 0 }}
                    style={switchThumb}
                  />
                </span>
              </label>
            </SettingRow>
          )}

          <SettingRow
            label="语音提醒"
            description="姿态异常和活动提醒时播放语音"
          >
            <label style={switchContainer}>
              <input
                type="checkbox"
                checked={settings.voice_enabled === 'true'}
                onChange={(e) => updateSetting('voice_enabled', e.target.checked ? 'true' : 'false')}
                style={{ display: 'none' }}
              />
              <span style={{
                ...switchTrack,
                background: settings.voice_enabled === 'true' ? 'var(--primary)' : '#ccc',
              }}>
                <motion.span
                  animate={{ x: settings.voice_enabled === 'true' ? 20 : 0 }}
                  style={switchThumb}
                />
              </span>
            </label>
          </SettingRow>

          {!isMobile() && (
            <SettingRow
              label="开机自启动"
              description="系统启动时自动运行 NeckGuardian"
            >
              <label style={switchContainer}>
                <input
                  type="checkbox"
                  checked={settings.auto_start === 'true'}
                  onChange={(e) => updateSetting('auto_start', e.target.checked ? 'true' : 'false')}
                  style={{ display: 'none' }}
                />
                <span style={{
                  ...switchTrack,
                  background: settings.auto_start === 'true' ? 'var(--primary)' : '#ccc',
                }}>
                  <motion.span
                    animate={{ x: settings.auto_start === 'true' ? 20 : 0 }}
                    style={switchThumb}
                  />
                </span>
              </label>
            </SettingRow>
          )}
        </motion.div>

        {/* ---- DeepSeek 大模型配置（仅桌面版） ---- */}
        {!isMobile() && (
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18 }}
          style={{ ...cardStyle, marginTop: 16 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 16 }}>🤖</span>
            <p style={{ fontSize: 15, fontWeight: 700 }}>DeepSeek 大模型</p>
            {hasKey && (
              <span style={{
                fontSize: 11, color: '#2E7D32', background: '#E8F5E9',
                padding: '2px 8px', borderRadius: 10,
              }}>
                已配置
              </span>
            )}
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.7 }}>
            填入 DeepSeek API Key 后，可在仪表盘生成基于你实时姿态与使用数据的肩颈分析报告。
            Key 仅保存在本机数据库，不会上传。
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="API Key">
              <div style={{ position: 'relative' }}>
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKeyInput}
                  onChange={(e) => setApiKeyInput(e.target.value)}
                  placeholder={hasKey ? keyMasked : 'sk-...'}
                  style={{ ...inputStyle, paddingRight: 40 }}
                  autoComplete="off"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  style={eyeButton}
                  title={showKey ? '隐藏' : '显示'}
                >
                  {showKey ? <EyeOffIcon size={16} color="#999" /> : <EyeIcon size={16} color="#999" />}
                </button>
              </div>
              <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 6 }}>
                {hasKey ? '留空表示保持当前 Key 不变' : '在 platform.deepseek.com 创建 API Key'}
              </p>
            </Field>

            <Field label="模型">
              <input
                list="deepseek-models"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                style={inputStyle}
                placeholder="deepseek-chat"
              />
              <datalist id="deepseek-models">
                {models.map((m) => <option key={m} value={m} />)}
              </datalist>
            </Field>

            <Field label="Base URL">
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                style={inputStyle}
                placeholder="https://api.deepseek.com"
              />
            </Field>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 2 }}>
              <button
                onClick={saveAIConfig}
                disabled={aiSaving}
                style={{
                  ...primaryBtn, opacity: aiSaving ? 0.6 : 1,
                  cursor: aiSaving ? 'not-allowed' : 'pointer',
                }}
              >
                {aiSaving ? '保存中…' : '保存配置'}
              </button>
              <button
                onClick={runTest}
                disabled={testing}
                style={{
                  ...ghostBtn, opacity: testing ? 0.6 : 1,
                  cursor: testing ? 'not-allowed' : 'pointer',
                }}
              >
                {testing ? '测试中…' : '测试连接'}
              </button>
              {aiMsg && (
                <span style={{
                  fontSize: 12, fontWeight: 500,
                  color: aiMsg.kind === 'ok' ? 'var(--success)' : '#E65100',
                }}>
                  {aiMsg.kind === 'ok' ? '✓ ' : '⚠ '}{aiMsg.text}
                </span>
              )}
            </div>
          </div>
        </motion.div>
        )}

        {saved && (
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            style={{ color: 'var(--success)', fontSize: 13, marginTop: 12, textAlign: 'center' }}
          >
            设置已保存 ✓
          </motion.p>
        )}

        {/* ---- 数据管理（桌面 / 移动共用，都走两端一致的数据层） ---- */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.28 }}
          style={{ ...cardStyle, marginTop: 16 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 16 }}>🗂</span>
            <p style={{ fontSize: 15, fontWeight: 700 }}>数据管理</p>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.7 }}>
            所有数据只存在本机。导出的备份文件两端通用 ——{' '}
            {isMobile() ? '手机的备份可以导回电脑' : '电脑的备份可以导进手机'}。
            <br />
            <b style={{ color: 'var(--text)' }}>导出不包含 DeepSeek API Key</b>；
            「清除数据」也只清健康数据，提醒间隔、AI 配置等设置一律保留。
          </p>

          {dataStatus && (
            <div style={{
              fontSize: 12, color: 'var(--text-secondary)', lineHeight: 2,
              background: 'var(--bg)', borderRadius: 8, padding: '10px 12px', marginBottom: 4,
            }}>
              占用空间：<b style={valueStyle}>{formatBytes(dataStatus.db_bytes)}</b>
              {dataStatus.quota_bytes
                ? <span>（浏览器配额 {formatBytes(dataStatus.quota_bytes)}）</span>
                : null}
              <br />
              原始采样：<b style={valueStyle}>{dataStatus.raw_samples.toLocaleString()}</b> 条
              <span>　·　</span>
              每日归档：<b style={valueStyle}>{dataStatus.daily_rows}</b> 天
              {dataStatus.first_day && (
                <span>（{dataStatus.first_day} ~ {dataStatus.last_day}）</span>
              )}
              <br />
              数据表版本：v{dataStatus.schema_version}
            </div>
          )}

          <SettingRow
            label="原始采样保留期（天）"
            description={`超过保留期的逐帧采样会被清理，但每日汇总永久保留（可填 ${MIN_RETENTION_DAYS}-${MAX_RETENTION_DAYS}）`}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                min={MIN_RETENTION_DAYS}
                max={MAX_RETENTION_DAYS}
                value={dataStatus?.keep_days ?? ''}
                disabled={!dataStatus || dataBusy === 'retention'}
                onChange={(e) => handleRetentionChange(e.target.value)}
                style={{
                  width: 80, padding: '8px 12px', borderRadius: 6,
                  border: '1px solid var(--border)', fontSize: 14, textAlign: 'center',
                }}
              />
              <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>天</span>
            </div>
          </SettingRow>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
            <button
              onClick={handleExportJson}
              disabled={dataBusy !== null}
              style={btnStyle(dataBusy !== null)}
            >
              {dataBusy === 'export' ? '导出中…' : '导出备份 (JSON)'}
            </button>
            <button
              onClick={handleExportCsv}
              disabled={dataBusy !== null}
              style={ghostBtnStyle(dataBusy !== null)}
            >
              {dataBusy === 'csv' ? '导出中…' : '导出每日汇总 (CSV)'}
            </button>
            <button
              onClick={handleImport}
              disabled={dataBusy !== null}
              style={ghostBtnStyle(dataBusy !== null)}
            >
              {dataBusy === 'import' ? '导入中…' : '导入备份'}
            </button>
            <button
              onClick={handleClear}
              disabled={dataBusy !== null}
              style={dangerBtnStyle(dataBusy !== null, confirmClear)}
            >
              {dataBusy === 'clear' ? '清除中…' : confirmClear ? '确认清除' : '清除健康数据'}
            </button>
          </div>

          {dataMsg && (
            <p style={{
              fontSize: 12, marginTop: 12, lineHeight: 1.7,
              color: dataMsg.kind === 'ok' ? 'var(--success)'
                : dataMsg.kind === 'warn' ? '#E65100' : 'var(--danger)',
            }}>
              {dataMsg.kind === 'ok' ? '✓ ' : '⚠ '}{dataMsg.text}
            </p>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          style={{ ...cardStyle, marginTop: 16 }}
        >
          <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>关于 NeckGuardian</p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            版本：{appVersion || '1.6.1'}<br />
            平台：{platformLabel()}（{isMobile() ? '移动端' : '桌面端'}）<br />
            技术栈：{isMobile()
              ? 'Capacitor + React + TypeScript + MediaPipe(本地推理)'
              : 'Electron + React + TypeScript + Python FastAPI + MediaPipe'}<br />
            数据存储：{isMobile() ? '本机 IndexedDB，所有数据不上传' : '本地 SQLite，所有数据不上传'}<br />
            隐私保护：摄像头画面仅在本地处理，{isMobile() ? '姿态推理全程在本机完成。' : '仅在启用 AI 分析时，将匿名的姿态指标与统计数据发送至 DeepSeek'}
          </p>
        </motion.div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>{label}</p>
      {children}
    </div>
  )
}

function SettingRow({ label, description, children }: {
  label: string; description: string; children: React.ReactNode
}) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '16px 0', borderBottom: '1px solid var(--border)',
    }}>
      <div style={{ flex: 1, marginRight: 16 }}>
        <p style={{ fontSize: 14, fontWeight: 500 }}>{label}</p>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>{description}</p>
      </div>
      {children}
    </div>
  )
}

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)',
  borderRadius: 'var(--radius)',
  padding: 20,
  boxShadow: 'var(--shadow)',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  fontSize: 13,
  boxSizing: 'border-box',
}

const eyeButton: React.CSSProperties = {
  position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
  background: 'transparent', border: 'none', cursor: 'pointer',
  display: 'flex', alignItems: 'center', padding: 4,
}

const primaryBtn: React.CSSProperties = {
  padding: '9px 22px', borderRadius: 8, border: 'none',
  background: 'var(--primary)', color: '#fff',
  fontSize: 13, fontWeight: 600,
}

const ghostBtn: React.CSSProperties = {
  padding: '9px 22px', borderRadius: 8,
  border: '1px solid var(--border)', background: 'transparent',
  color: 'var(--text)', fontSize: 13, fontWeight: 600,
}

const switchContainer: React.CSSProperties = { cursor: 'pointer', display: 'inline-block' }
const switchTrack: React.CSSProperties = {
  display: 'inline-flex', width: 44, height: 24, borderRadius: 12,
  padding: 2, cursor: 'pointer', transition: 'background 0.2s',
}
const switchThumb: React.CSSProperties = {
  width: 20, height: 20, borderRadius: '50%', background: '#fff', display: 'block',
}

// ---------------------------------------------------------------------------
// 数据管理：文案与按钮样式
// ---------------------------------------------------------------------------

type DataBusy = 'export' | 'csv' | 'import' | 'clear' | 'retention' | null
interface DataMsg { kind: 'ok' | 'err' | 'warn'; text: string }

/** 数据层的错误码 → 用户看得懂的话。码是约定的（两端同码），文案只属于界面。 */
const IMPORT_ERRORS: Record<string, string> = {
  not_an_object: '文件内容不是一个对象，可能不是备份文件',
  bad_format: '这不是 NeckGuardian 的备份文件',
  unsupported_version: '备份文件版本不受支持，请升级到最新版后再试',
  missing_tables: '备份文件缺少数据段，可能已损坏',
}

function importErrorText(code: string | null): string {
  if (!code) return '导入失败'
  const prefix = 'missing_table:'
  if (code.startsWith(prefix)) {
    return `备份文件缺少「${code.slice(prefix.length)}」数据段，可能已损坏`
  }
  return IMPORT_ERRORS[code] ?? `导入失败：${code}`
}

const TABLE_LABELS: Record<string, string> = {
  settings: '设置',
  posture_score: '姿态采样',
  posture_daily: '每日归档',
  usage_record: '使用记录',
  activity_log: '活动记录',
}

/** 把「跳过 N 行」的诊断计数说成一句人话（没有脏行时返回空串）。 */
function skippedText(skipped: Partial<Record<string, number>>): string {
  const parts = Object.entries(skipped)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([table, n]) => `${TABLE_LABELS[table] ?? table} ${n} 行`)
  return parts.length ? `（已跳过格式异常：${parts.join('、')}）` : ''
}

const valueStyle: React.CSSProperties = { color: 'var(--text)', fontWeight: 600 }

const btnStyle = (disabled: boolean): React.CSSProperties => ({
  ...primaryBtn, opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer',
})

const ghostBtnStyle = (disabled: boolean): React.CSSProperties => ({
  ...ghostBtn, opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer',
})

/** 「清除」两步走的按钮：第一次点击后变实心红，第二次才真的执行。 */
const dangerBtnStyle = (disabled: boolean, armed: boolean): React.CSSProperties => ({
  ...ghostBtn,
  opacity: disabled ? 0.6 : 1,
  cursor: disabled ? 'not-allowed' : 'pointer',
  borderColor: armed ? 'var(--danger)' : 'var(--border)',
  color: armed ? '#fff' : 'var(--danger)',
  background: armed ? 'var(--danger)' : 'transparent',
})
