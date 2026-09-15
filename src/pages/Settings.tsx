import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useApi } from '../hooks/useApi'
import { useAI } from '../hooks/useAI'
import { isMobile } from '../platform/runtime'
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

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5 }}
          style={{ ...cardStyle, marginTop: 16 }}
        >
          <p style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>关于 NeckGuardian</p>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
            版本：{appVersion || '1.3.6'}<br />
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
