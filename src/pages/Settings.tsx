import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useApi } from '../hooks/useApi'
import type { Settings as SettingsType } from '../types'

export default function Settings() {
  const { get, put } = useApi()
  const [settings, setSettings] = useState<SettingsType>({
    reminder_interval: '30',
    ai_enabled: 'false',
    auto_start: 'false',
    voice_enabled: 'true',
  })
  const [saved, setSaved] = useState(false)

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

  const updateSetting = async (key: string, value: string) => {
    setSettings((s) => ({ ...s, [key]: value }))
    try {
      await put('/api/settings', { key, value })
      if (key === 'auto_start') {
        window.electronAPI?.setAutoStart(value === 'true')
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      console.error('Failed to save setting:', err)
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
            description="每工作多少分钟提醒一次肩颈放松"
          >
            <select
              value={settings.reminder_interval}
              onChange={(e) => updateSetting('reminder_interval', e.target.value)}
              style={selectStyle}
            >
              <option value="15">15 分钟</option>
              <option value="30">30 分钟</option>
              <option value="45">45 分钟</option>
              <option value="60">60 分钟</option>
            </select>
          </SettingRow>

          <SettingRow
            label="AI 增强模式"
            description="连接 DeepSeek 获取个性化建议（需要 API Key 环境变量 DEEPSEEK_API_KEY）"
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
        </motion.div>

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
            版本：1.0.0<br />
            技术栈：Electron + React + TypeScript + Python FastAPI + MediaPipe<br />
            数据存储：本地 SQLite，所有数据不上传<br />
            隐私保护：摄像头画面仅在本地处理，不发送至任何服务器
          </p>
        </motion.div>
      </div>
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

const selectStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 6,
  border: '1px solid var(--border)',
  fontSize: 14,
  background: 'var(--bg)',
  cursor: 'pointer',
}

const switchContainer: React.CSSProperties = { cursor: 'pointer', display: 'inline-block' }
const switchTrack: React.CSSProperties = {
  display: 'inline-flex', width: 44, height: 24, borderRadius: 12,
  padding: 2, cursor: 'pointer', transition: 'background 0.2s',
}
const switchThumb: React.CSSProperties = {
  width: 20, height: 20, borderRadius: '50%', background: '#fff', display: 'block',
}
