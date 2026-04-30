import { useState, useEffect } from 'react'
import { HashRouter, Routes, Route, useNavigate } from 'react-router-dom'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import NeckActivity from './pages/NeckActivity'
import Settings from './pages/Settings'

function AppShell() {
  const [backendReady, setBackendReady] = useState(false)
  const navigate = useNavigate()

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
      window.electronAPI.onStartExercise(() => navigate('/'))
      window.electronAPI.onReminder(() => navigate('/'))
    }
  }, [navigate])

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
