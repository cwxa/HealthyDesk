import { useState, useEffect } from 'react'
import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useApi } from '../hooks/useApi'
import { ActivityIcon, DashboardIcon, SettingsIcon, NeckIcon } from './icons'

const navItems = [
  { path: '/', label: '肩颈活动', icon: ActivityIcon },
  { path: '/dashboard', label: '仪表盘', icon: DashboardIcon },
  { path: '/settings', label: '系统设置', icon: SettingsIcon },
]

interface ReminderStatus {
  pending: boolean
  next_reminder: string | null
  snooze_until: string | null
  last_triggered: string | null
}

export default function Sidebar() {
  const { get } = useApi()
  const [nextReminderText, setNextReminderText] = useState('')

  useEffect(() => {
    const fetchReminderStatus = async () => {
      try {
        const status = await get<ReminderStatus>('/api/reminder/status')
        if (status.next_reminder) {
          const nextTime = new Date(status.next_reminder)
          const now = new Date()
          const diff = nextTime.getTime() - now.getTime()
          
          if (diff <= 0) {
            setNextReminderText('⏰ 即将提醒')
          } else if (diff < 60000) {
            setNextReminderText('⏰ 1分钟内提醒')
          } else if (diff < 3600000) {
            const minutes = Math.floor(diff / 60000)
            setNextReminderText(`⏰ ${minutes}分钟后提醒`)
          } else {
            setNextReminderText(`下次活动: ${nextTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`)
          }
        } else if (status.snooze_until) {
          const snoozeTime = new Date(status.snooze_until)
          setNextReminderText(`暂停至: ${snoozeTime.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`)
        } else {
          setNextReminderText('')
        }
      } catch (e) {
        console.error('Failed to get reminder status:', e)
      }
    }

    fetchReminderStatus()
    const interval = setInterval(fetchReminderStatus, 30000)
    return () => clearInterval(interval)
  }, [get])

  return (
    <nav style={{
      width: 200, minWidth: 200, background: 'var(--bg-card)',
      borderRight: '1px solid var(--border)', display: 'flex',
      flexDirection: 'column', padding: '16px 0', boxShadow: 'var(--shadow)',
    }}>
      <div style={{ padding: '0 20px 20px', borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <NeckIcon size={28} color="#4CAF50" />
          <div>
            <h1 style={{ fontSize: 18, color: 'var(--primary-dark)', fontWeight: 700 }}>
              NeckGuardian
            </h1>
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              肩颈健康助手
            </p>
          </div>
        </div>
      </div>

      {navItems.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          end
          style={({ isActive }) => ({
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 20px', margin: '2px 8px', borderRadius: 8,
            textDecoration: 'none', color: isActive ? 'var(--primary-dark)' : 'var(--text-secondary)',
            background: isActive ? 'rgba(76,175,80,0.1)' : 'transparent',
            fontWeight: isActive ? 600 : 400,
            fontSize: 14,
            transition: 'all 0.2s',
          })}
        >
          <motion.div
            whileHover={{ scale: 1.1 }}
            style={{ fontSize: 18 }}
          >
            <item.icon size={18} />
          </motion.div>
          {item.label}
        </NavLink>
      ))}

      <div style={{ marginTop: 'auto', padding: '16px 20px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {nextReminderText && (
          <div style={{
            padding: '8px 12px', borderRadius: 8,
            background: '#FFF9C4', border: '1px solid #FFE082',
            fontSize: 12, color: '#F57C00', textAlign: 'center',
          }}>
            {nextReminderText}
          </div>
        )}
        <button
          onClick={() => window.electronAPI?.minimizeToTray()}
          style={{
            width: '100%', padding: '8px 12px', borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--bg)',
            cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 13,
          }}
        >
          最小化到托盘
        </button>
        <button
          onClick={() => window.electronAPI?.quitApp()}
          style={{
            width: '100%', padding: '8px 12px', borderRadius: 8,
            border: '1px solid #FFCDD2', background: '#fff',
            cursor: 'pointer', color: '#EF5350', fontSize: 13,
          }}
        >
          退出程序
        </button>
      </div>
    </nav>
  )
}
