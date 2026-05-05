import { useState, useEffect, useCallback } from 'react'
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import NeckActivity from './pages/NeckActivity'
import Settings from './pages/Settings'
import { useApi } from './hooks/useApi'

function AppShell() {
  const [backendReady, setBackendReady] = useState(false)
  const [reminderVisible, setReminderVisible] = useState(false)
  const [isStartupReminder, setIsStartupReminder] = useState(false)
  const navigate = useNavigate()
  const { post, get } = useApi()

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
      console.log('Backend ready on port', data.port)
      setBackendReady(true)
    })
    const timer = setTimeout(() => setBackendReady(true), 5000)
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.onStartExercise(() => {
        console.log('[App] onStartExercise received')
        navigate('/')
      })
      window.electronAPI.onReminder(() => {
        console.log('[App] onReminder received from IPC')
        get<{is_startup_reminder?: boolean}>('/api/reminder/status')
          .then((res: {is_startup_reminder?: boolean}) => {
            console.log('[App] Reminder status:', res)
            setIsStartupReminder(res.is_startup_reminder || false)
          })
          .catch(() => {
            setIsStartupReminder(false)
          })
          .finally(() => {
            console.log('[App] Showing reminder modal')
            navigate('/')
            setReminderVisible(true)
            speak('该活动一下了！请你活动肩颈。')
          })
      })
    }
  }, [navigate, get])

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
  }, [post, get])

  const acceptReminder = useCallback(async () => {
    setReminderVisible(false)
    try {
      await post('/api/reminder/end', {})
    } catch (e) {
      console.error('End break failed:', e)
    }
    window.dispatchEvent(new CustomEvent('start-exercise-mode'))
    navigate('/')
  }, [post, navigate])

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
        <p style={{ color: '#607D8B', fontSize: 14 }}>正在启动服务...</p>
      </div>
    )
  }

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

      {/* Global reminder modal */}
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
              zIndex: 100,
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
                maxWidth: 420, width: '90%', textAlign: 'center',
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
