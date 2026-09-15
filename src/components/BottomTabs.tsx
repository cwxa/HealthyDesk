import { NavLink } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ActivityIcon, DashboardIcon, SettingsIcon } from './icons'

const navItems = [
  { path: '/', label: '肩颈活动', icon: ActivityIcon },
  { path: '/dashboard', label: '仪表盘', icon: DashboardIcon },
  { path: '/settings', label: '设置', icon: SettingsIcon },
]

/**
 * 移动端底部标签栏。
 *
 * 桌面端用左侧 200px 侧边栏（Sidebar），手机上改为底部标签栏更符合触控习惯，
 * 也把纵向空间让给摄像头画面。
 */
export default function BottomTabs() {
  return (
    <nav
      style={{
        display: 'flex',
        borderTop: '1px solid var(--border)',
        background: 'var(--bg-card)',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}
    >
      {navItems.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          end
          style={({ isActive }) => ({
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 3,
            padding: '10px 0 8px',
            textDecoration: 'none',
            color: isActive ? 'var(--primary-dark)' : 'var(--text-secondary)',
            fontSize: 11,
          })}
        >
          {({ isActive }) => (
            <>
              <motion.div whileTap={{ scale: 0.9 }}>
                <item.icon size={22} color={isActive ? '#2E7D32' : undefined} />
              </motion.div>
              {item.label}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  )
}
