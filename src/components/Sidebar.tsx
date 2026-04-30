import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'

const navItems = [
  { path: '/', label: '肩颈活动', icon: '🧘' },
  { path: '/dashboard', label: '仪表盘', icon: '📊' },
  { path: '/settings', label: '系统设置', icon: '⚙' },
]

export default function Sidebar() {
  return (
    <nav style={{
      width: 200, minWidth: 200, background: 'var(--bg-card)',
      borderRight: '1px solid var(--border)', display: 'flex',
      flexDirection: 'column', padding: '16px 0', boxShadow: 'var(--shadow)',
    }}>
      <div style={{ padding: '0 20px 20px', borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
        <h1 style={{ fontSize: 18, color: 'var(--primary-dark)', fontWeight: 700 }}>
          🛡 NeckGuardian
        </h1>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
          肩颈健康助手
        </p>
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
          <motion.span
            whileHover={{ scale: 1.1 }}
            style={{ fontSize: 18 }}
          >
            {item.icon}
          </motion.span>
          {item.label}
        </NavLink>
      ))}

      <div style={{ marginTop: 'auto', padding: '16px 20px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 8 }}>
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
