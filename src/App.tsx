import { useState, useEffect, useCallback } from 'react'
import { HashRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Sidebar from './components/Sidebar'
import BottomTabs from './components/BottomTabs'
import Dashboard from './pages/Dashboard'
import NeckActivity from './pages/NeckActivity'
import Settings from './pages/Settings'
import { useApi } from './hooks/useApi'
import { isMobile } from './platform/runtime'
import { localReminder } from './platform/localReminder'
import { data } from './platform/dataLayer'
import { NeckIcon } from './components/icons'

function AppShell() {
  const [backendReady, setBackendReady] = useState(false)
  const [reminderVisible, setReminderVisible] = useState(false)
  const [isStartupReminder, setIsStartupReminder] = useState(false)
  const navigate = useNavigate()
  const location = useLocation()
  const { post, get } = useApi()
  const mobile = isMobile()
  const activityRoute = location.pathname === '/'

  const speak = (text: string) => {
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      const utterance = new SpeechSynthesisUtterance(text)
      utterance.lang = 'zh-CN'
      window.speechSynthesis.speak(utterance)
    }
  }

  useEffect(() => {
    window.electronAPI?.onBackendReady((data) => {
      setBackendReady(true)
    })
    // 移动端没有 Electron 后端进程；稍作延时确保本地数据层可用
    const timer = setTimeout(() => setBackendReady(true), mobile ? 300 : 5000)
    return () => clearTimeout(timer)
  }, [mobile])

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.onStartExercise(() => {
        sessionStorage.setItem('neckguardian:start-exercise', '1')
        window.dispatchEvent(new CustomEvent('start-exercise-mode'))
        navigate('/')
      })
      window.electronAPI.onReminder(() => {
        get<{is_startup_reminder?: boolean}>('/api/reminder/status')
          .then((res: {is_startup_reminder?: boolean}) => {
            setIsStartupReminder(res.is_startup_reminder || false)
          })
          .catch(() => {
            setIsStartupReminder(false)
          })
          .finally(() => {
            navigate('/')
            setReminderVisible(true)
            speak('该活动一下了！请你活动肩颈。')
          })
      })
    } else if (mobile) {
      // 移动端：本地定时器驱动提醒（无 Python APScheduler）
      localReminder.start(({ isStartup }) => {
        setIsStartupReminder(isStartup)
        navigate('/')
        setReminderVisible(true)
        speak(isStartup ? '欢迎使用健康桌面！请你开始肩颈活动。' : '该活动一下了！请你活动肩颈。')
      })
      return () => localReminder.stop()
    }
  }, [navigate, get, mobile])

  // 提醒间隔设置变更时，热更新移动端调度器
  useEffect(() => {
    if (!mobile) return
    const handler = (e: Event) => {
      const m = (e as CustomEvent<{ minutes: number }>).detail?.minutes
      if (m) localReminder.updateInterval(m)
    }
    window.addEventListener('reminder-interval-changed', handler)
    return () => window.removeEventListener('reminder-interval-changed', handler)
  }, [mobile])

  // 移动端使用时长计时：桌面版由后端 APScheduler 每分钟 +1，
  // 这里用定时器复刻同样行为，App 在前台时每分钟累加 1 分钟。
  useEffect(() => {
    if (!mobile) return
    const tick = () => {
      if (document.hidden) return
      data.addUsageMinutes(1).catch(() => {})
    }
    const timer = window.setInterval(tick, 60_000)
    return () => window.clearInterval(timer)
  }, [mobile])

  useEffect(() => {
    const handleShowReminder = async () => {
      let startupReminder = false
      try {
        const status = await get<{is_startup_reminder?: boolean}>('/api/reminder/status')
        startupReminder = status.is_startup_reminder || false
        setIsStartupReminder(startupReminder)
      } catch (e) {
        console.error('Failed to get reminder status:', e)
        setIsStartupReminder(false)
      }
      navigate('/')
      setReminderVisible(true)
      speak(startupReminder ? '欢迎使用健康桌面！请先完成初始肩颈活动。' : '该活动一下了！请你活动肩颈。')
    }
    window.addEventListener('show-reminder-modal', handleShowReminder)
    return () => window.removeEventListener('show-reminder-modal', handleShowReminder)
  }, [get, navigate])

  const dismissReminder = useCallback(async () => {
    setReminderVisible(false)
    if (mobile) {
      localReminder.snooze(5)
      return
    }
    try {
      const status = await get<{is_startup_reminder?: boolean}>('/api/reminder/status')
      if (status.is_startup_reminder) {
        console.warn('Cannot snooze startup reminder - must complete activity')
        return
      }
      await post('/api/reminder/snooze', { minutes: 5 })
    } catch (e) {
      console.error('Snooze failed:', e)
    }
  }, [post, get, mobile])

  const acceptReminder = useCallback(async () => {
    setReminderVisible(false)
    if (mobile) {
      localReminder.beginBreak()
    } else {
      try {
        await post('/api/reminder/end', {})
      } catch (e) {
        console.error('End break failed:', e)
      }
    }
    // 用 sessionStorage 兜底：若 NeckActivity 尚未挂载（用户在其他页），
    // 事件会丢失，标记可让该页挂载后自行进入练习模式。
    sessionStorage.setItem('neckguardian:start-exercise', '1')
    window.dispatchEvent(new CustomEvent('start-exercise-mode'))
    navigate('/')
  }, [post, navigate, mobile])

  if (!backendReady) {
    return (
      <div style={{
        height: '100vh', display: 'flex', alignItems: 'center',
        justifyContent: 'center', flexDirection: 'column', gap: 16,
        background: '#F5F7FA',
      }}>
        <div style={{
          width: 50, height: 50, borderRadius: '50%',
          border: '4px solid #C8E6C9',
          borderTopColor: '#4CAF50',
          animation: 'spin 1s linear infinite',
        }} />
        <p style={{ color: '#607D8B', fontSize: 14 }}>{mobile ? '正在启动...' : '正在启动服务...'}</p>
      </div>
    )
  }

  const reminderModal = (
    <AnimatePresence>
      {reminderVisible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100, padding: 20,
          }}
          onClick={dismissReminder}
        >
          <motion.div
            initial={{ scale: 0.8, opacity: 0, y: 30 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.8, opacity: 0, y: 30 }}
            transition={{ type: 'spring', stiffness: 300, damping: 24 }}
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'linear-gradient(145deg, #FFF9C4 0%, #FFF8E1 100%)',
              borderRadius: 24, padding: '40px 36px 28px',
              maxWidth: 420, width: '100%', textAlign: 'center',
              boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
              border: '2px solid #FFD54F',
            }}
          >
            <div style={{ fontSize: 56, marginBottom: 12 }}>{isStartupReminder ? '👋' : '⏰'}</div>
            <h3 style={{ fontSize: 22, fontWeight: 800, color: '#E65100', marginBottom: 6 }}>
              {isStartupReminder ? '欢迎使用健康桌面！' : '该活动一下了！'}
            </h3>
            <p style={{ fontSize: 14, color: '#BF360C', lineHeight: 1.7, marginBottom: 28 }}>
              {isStartupReminder
                ? '请你开始肩颈活动。'
                : '你已经连续工作了一段时间。请你活动肩颈。'}
            </p>
            <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
              {!isStartupReminder && (
                <button
                  onClick={dismissReminder}
                  style={{
                    padding: '10px 28px', borderRadius: 12, border: '2px solid #FFCC80',
                    background: 'transparent', color: '#E65100', fontSize: 14, fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  稍后提醒
                </button>
              )}
              <button
                onClick={acceptReminder}
                style={{
                  padding: '10px 28px', borderRadius: 12, border: 'none',
                  background: 'linear-gradient(135deg, #4CAF50 0%, #66BB6A 100%)',
                  color: '#fff', fontSize: 14, fontWeight: 700,
                  cursor: 'pointer', boxShadow: '0 4px 16px rgba(76,175,80,0.4)',
                }}
              >
                🧘 {isStartupReminder ? '开始初始活动' : '开始活动'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )

  // ---- 移动端布局：紧凑顶栏 + 内容 + 底部标签栏 ----
  if (mobile) {
    return (
      <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 16px',
          paddingTop: 'calc(12px + env(safe-area-inset-top))',
          borderBottom: '1px solid var(--border)', background: 'var(--bg-card)',
        }}>
          <NeckIcon size={24} color="#4CAF50" />
          <h1 style={{ fontSize: 17, fontWeight: 700, color: 'var(--primary-dark)' }}>NeckGuardian</h1>
        </header>

        {/* 「肩颈活动」页是固定高度的整屏布局（摄像头自适应剩余空间，不需要滚动），
            其余页面维持常规的纵向滚动。 */}
        <main style={{
          flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
          background: 'var(--bg)',
        }}>
          <div
            className={activityRoute ? undefined : 'no-scrollbar'}
            style={{
              flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
              padding: activityRoute ? '10px 14px 10px' : '16px 14px 24px',
              overflowY: activityRoute ? 'hidden' : 'auto',
              WebkitOverflowScrolling: 'touch',
            }}
          >
            <Routes>
              <Route path="/" element={<NeckActivity />} />
              <Route path="/dashboard" element={<Dashboard />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </div>
        </main>

        <BottomTabs />
        {reminderModal}
      </div>
    )
  }

  // ---- 桌面端布局：侧边栏 + 内容 ----
  return (
    <div style={{ height: '100vh', display: 'flex' }}>
      <Sidebar />
      <main style={{
        flex: 1, overflow: 'auto', background: 'var(--bg)',
        display: 'flex', justifyContent: 'center',
      }}>
        <div style={{ width: '100%', maxWidth: 860, padding: '28px 32px' }}>
          <Routes>
            <Route path="/" element={<NeckActivity />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/settings" element={<Settings />} />
          </Routes>
        </div>
      </main>

      {reminderModal}
    </div>
  )
}

export default function App() {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  )
}
