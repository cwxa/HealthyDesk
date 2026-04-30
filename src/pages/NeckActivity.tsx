import { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useWebSocket } from '../hooks/useWebSocket'
import { useApi } from '../hooks/useApi'
import PostureSkeleton from '../components/PostureSkeleton'
import ScoreGauge from '../components/ScoreGauge'
import ExercisePanel, { exercises, type ExerciseState } from '../components/ExercisePanel'
import { speak, speakPostureIssue } from '../utils/speech'
import type { PoseResult } from '../types'

type Mode = 'monitor' | 'exercise' | 'done'

export default function NeckActivity() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [latestResult, setLatestResult] = useState<PoseResult | null>(null)
  const [mode, setMode] = useState<Mode>('monitor')
  const { connect, disconnect, connected, sendFrame, onPoseResult } = useWebSocket()
  const { post } = useApi()
  const intervalRef = useRef<number>(0)
  const lastRecordRef = useRef(0)

  // Exercise state
  const [exCurrent, setExCurrent] = useState(0)
  const [exTimeLeft, setExTimeLeft] = useState(exercises[0].duration)
  const [exScores, setExScores] = useState<number[]>([])
  const exTimerRef = useRef<number>(0)
  const exScoresRef = useRef<number[]>([])

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      }
      setCameraReady(true)
      setCameraError('')
      connect()
    } catch {
      setCameraError('无法访问摄像头，请检查权限设置')
    }
  }, [connect])

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    setCameraReady(false)
    disconnect()
  }, [disconnect])

  useEffect(() => {
    startCamera()
    return () => {
      stopCamera()
      clearInterval(intervalRef.current)
      clearInterval(exTimerRef.current)
    }
  }, [startCamera, stopCamera])

  // Frame capture
  const captureAndSend = useCallback(() => {
    if (!canvasRef.current || !videoRef.current || !connected) return
    const canvas = canvasRef.current
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    canvas.width = 640
    canvas.height = 480
    ctx.drawImage(videoRef.current, 0, 0, 640, 480)
    sendFrame(canvas.toDataURL('image/jpeg', 0.7))
  }, [connected, sendFrame])

  useEffect(() => {
    if (!cameraReady || !connected) return
    intervalRef.current = window.setInterval(captureAndSend, 200)
    return () => clearInterval(intervalRef.current)
  }, [cameraReady, connected, captureAndSend])

  // Pose result handling
  useEffect(() => {
    onPoseResult((result: PoseResult) => {
      setLatestResult(result)
      if (result.type === 'pose' && result.issues && result.issues.length > 0) {
        const severeOnly = result.issues.filter(i => i.includes('严重'))
        if (severeOnly.length > 0) speakPostureIssue(severeOnly)
      }
      if (result.type === 'pose' && result.score !== undefined) {
        if (mode === 'exercise') {
          setExScores(p => { const next = [...p, result.score!]; exScoresRef.current = next; return next })
        }
        const now = Date.now()
        if (now - lastRecordRef.current >= 1500) {
          lastRecordRef.current = now
          post('/api/posture/record', {
            timestamp: result.timestamp,
            head_angle: result.head_angle,
            shoulder_diff: result.shoulder_diff,
            spine_angle: result.spine_angle,
            score: result.score,
          }).catch(() => {})
        }
      }
    })
  }, [onPoseResult, post, mode])

  // Start exercise
  const startExercise = useCallback(() => {
    setMode('exercise')
    setExCurrent(0)
    setExTimeLeft(exercises[0].duration)
    setExScores([])
    exScoresRef.current = []
    speak('请跟随引导完成肩颈活动')
  }, [])

  // Exercise timer
  useEffect(() => {
    if (mode !== 'exercise') return
    exTimerRef.current = window.setInterval(() => {
      setExTimeLeft(t => {
        if (t <= 1) {
          setExCurrent(c => {
            if (c < exercises.length - 1) {
              setExTimeLeft(exercises[c + 1].duration)
              return c + 1
            } else {
              finishExercise()
              return c
            }
          })
          return 0
        }
        return t - 1
      })
    }, 1000)
    return () => clearInterval(exTimerRef.current)
  }, [mode])

  const skipCurrent = () => {
    setExCurrent(c => {
      if (c < exercises.length - 1) {
        setExTimeLeft(exercises[c + 1].duration)
        return c + 1
      } else {
        finishExercise()
        return c
      }
    })
  }

  const endExercise = () => {
    clearInterval(exTimerRef.current)
    finishExercise()
  }

  const finishExercise = useCallback(() => {
    clearInterval(exTimerRef.current)
    setMode('done')
    const ss = exScoresRef.current
    const avg = ss.length > 0 ? Math.round(ss.reduce((a, b) => a + b, 0) / ss.length) : 0
    const dur = exercises.reduce((s, e) => s + e.duration, 0)
    speak('活动完成！')
    post('/api/activity/record', {
      timestamp: new Date().toISOString(),
      activity_type: 'exercise',
      exercise_count: exercises.length,
      duration_sec: dur,
      avg_score: avg,
    }).then(() => console.log('Activity recorded OK')).catch(e => console.error('Activity record failed:', e))
  }, [post])

  const score = latestResult?.type === 'pose' ? (latestResult.score ?? 0) : 0
  const issues = latestResult?.type === 'pose' ? (latestResult.issues ?? []) : []

  const totalDur = exercises.reduce((s, e) => s + e.duration, 0)
  const elapsed = totalDur - exercises.slice(exCurrent).reduce((s, e, i) => s + (i === 0 ? exTimeLeft : e.duration), 0)
  const progress = (elapsed / totalDur) * 100

  const exState: ExerciseState = {
    phase: mode === 'done' ? 'done' : 'active',
    current: exCurrent,
    timeLeft: exTimeLeft,
    poseScore: score,
    hasPose: latestResult?.type === 'pose',
    sessionScores: exScores,
    totalDur,
    progress,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h2 style={{ fontSize: 24, fontWeight: 700 }}>🧘 肩颈活动</h2>
        {cameraError && (
          <button onClick={() => { setCameraError(''); startCamera() }} style={{
            padding: '10px 24px', borderRadius: 8, border: 'none',
            background: '#4CAF50', color: '#fff', cursor: 'pointer',
            fontSize: 14, fontWeight: 600,
          }}>重试摄像头</button>
        )}
      </div>

      {/* Camera + Side Panel */}
      <div style={{ display: 'flex', gap: 16, height: 570 }}>
        {/* Camera panel */}
        <div style={{
          flex: 1, position: 'relative', background: '#1a1a2e',
          borderRadius: 12, overflow: 'hidden', height: '100%',
          boxShadow: '0 2px 16px rgba(0,0,0,0.08)',
        }}>
          {!cameraReady && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, zIndex: 5 }}>
              {cameraError ? (
                <>
                  <div style={{ width: 72, height: 72, borderRadius: '50%', background: '#FFF3E0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: 32 }}>📷</span>
                  </div>
                  <p style={{ color: '#E65100', fontSize: 15, fontWeight: 500, textAlign: 'center', maxWidth: 300 }}>{cameraError}</p>
                </>
              ) : (
                <>
                  <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: 32, filter: 'grayscale(0.5)' }}>📷</span>
                  </div>
                  <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 15, fontWeight: 500 }}>正在启动摄像头...</p>
                </>
              )}
            </div>
          )}

          <video
            ref={videoRef}
            style={{ display: cameraReady ? 'block' : 'none', width: '100%', height: '100%', objectFit: 'cover', transform: 'scaleX(-1)' }}
            playsInline muted
          />
          <canvas ref={canvasRef} style={{ display: 'none' }} />

          {cameraReady && latestResult?.type === 'pose' && latestResult.landmarks && (
            <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', transform: 'scaleX(-1)' }}>
              <PostureSkeleton landmarks={latestResult.landmarks} width={640} height={480} />
            </div>
          )}

          {!connected && cameraReady && (
            <div style={{ position: 'absolute', top: 12, left: 12, background: 'rgba(255,167,38,0.9)', color: '#fff', padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 500, zIndex: 10 }}>
              正在连接后端...
            </div>
          )}

          {connected && cameraReady && (
            <div style={{ position: 'absolute', top: 12, left: 12, display: 'flex', alignItems: 'center', gap: 6, zIndex: 10 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#4CAF50', boxShadow: '0 0 8px rgba(76,175,80,0.6)' }} />
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>实时检测中</span>
            </div>
          )}

          {cameraReady && connected && latestResult?.type === 'no_pose' && (
            <div style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', background: 'rgba(0,0,0,0.65)', color: '#fff', padding: '8px 20px', borderRadius: 20, fontSize: 13, zIndex: 10 }}>
              未检测到人体，请面向摄像头
            </div>
          )}

          {/* Posture metrics overlay */}
          {cameraReady && (
            <div style={{ position: 'absolute', bottom: 16, left: 0, right: 0, display: 'flex', justifyContent: 'center', gap: 16, zIndex: 10 }}>
              <MetricBadge label="头部侧倾" value={latestResult?.type === 'pose' ? latestResult.head_angle : undefined} unit="°" warn={5} critical={17} />
              <MetricBadge label="肩部高差" value={latestResult?.type === 'pose' ? latestResult.shoulder_diff : undefined} unit="%" warn={4} critical={8} />
              <MetricBadge label="脊柱倾斜" value={latestResult?.type === 'pose' ? latestResult.spine_angle : undefined} unit="°" warn={10} critical={20} />
            </div>
          )}
        </div>

        {/* Right panel */}
        <div style={{ width: 300, minWidth: 300, height: '100%', display: 'flex', flexDirection: 'column', gap: 12, overflow: 'hidden' }}>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {mode === 'monitor' ? (
            <>
              {/* Score card */}
              <div style={{ background: '#fff', borderRadius: 12, padding: '16px 16px 14px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)', textAlign: 'center', flexShrink: 0 }}>
                <p style={{ fontSize: 12, color: '#999', marginBottom: 10, fontWeight: 600, letterSpacing: 1 }}>实时评分</p>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <ScoreGauge score={score} size={100} hasData={latestResult?.type === 'pose'} />
                </div>
                <p style={{
                  marginTop: 8, fontSize: 13, fontWeight: 600,
                  color: score >= 80 ? '#4CAF50' : score >= 60 ? '#FF9800' : score > 0 ? '#EF5350' : '#999',
                }}>
                  {score > 0 ? (score >= 80 ? '姿态良好' : score >= 60 ? '需要注意' : '姿态异常') : '等待数据...'}
                </p>
              </div>

              {/* Metrics */}
              <div style={{ background: '#fff', borderRadius: 12, padding: '14px 16px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)', flex: 1, minHeight: 0 }}>
                <p style={{ fontSize: 12, color: '#999', marginBottom: 10, fontWeight: 600, letterSpacing: 1 }}>检测指标</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <MetricRow icon="↕" label="头部侧倾角" value={latestResult?.type === 'pose' ? `${latestResult.head_angle?.toFixed(1)}°` : '--'} warn={latestResult?.type === 'pose' ? (latestResult.head_angle ?? 0) > 5 : false} okRange="≤5°" />
                  <MetricRow icon="⇔" label="肩部高度差" value={latestResult?.type === 'pose' ? `${latestResult.shoulder_diff?.toFixed(1)}%` : '--'} warn={latestResult?.type === 'pose' ? (latestResult.shoulder_diff ?? 0) > 4 : false} okRange="≤4%" />
                  <MetricRow icon="↻" label="脊柱倾斜角" value={latestResult?.type === 'pose' ? `${latestResult.spine_angle?.toFixed(1)}°` : '--'} warn={latestResult?.type === 'pose' ? (latestResult.spine_angle ?? 0) > 10 : false} okRange="≤10°" />
                </div>
              </div>

              {/* Issues */}
              <AnimatePresence>
                {issues.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    style={{ background: '#FFF5F5', borderRadius: 12, padding: '10px 14px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)', border: '1px solid #FFCDD2', flexShrink: 0 }}
                  >
                    <p style={{ fontSize: 12, fontWeight: 600, color: '#C62828', marginBottom: 6 }}>⚠ 检测到问题</p>
                    {issues.map((issue, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0' }}>
                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#EF5350', flexShrink: 0 }} />
                        <span style={{ fontSize: 13, color: '#C62828' }}>{issue}</span>
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </>
          ) : (
            <ExercisePanel state={exState} onSkipCurrent={skipCurrent} onEndExercise={endExercise} />
          )}
          </div>

          {/* Start exercise button (only in monitor mode) */}
          {mode === 'monitor' && (
            <button
              onClick={startExercise}
              style={{
                width: '100%', padding: '14px 0', borderRadius: 12, border: 'none',
                background: 'linear-gradient(135deg, #4CAF50 0%, #81C784 100%)',
                color: '#fff', cursor: 'pointer', fontSize: 16, fontWeight: 700,
                boxShadow: '0 4px 20px rgba(76,175,80,0.35)', letterSpacing: 2,
              }}
            >
              🧘 开 始 活 动
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function MetricRow({ icon, label, value, warn, okRange }: {
  icon: string; label: string; value: string; warn: boolean; okRange: string
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 10px', borderRadius: 8,
      background: warn ? '#FFF5F5' : 'transparent',
      transition: 'background 0.3s',
    }}>
      <span style={{ fontSize: 16, opacity: 0.6 }}>{icon}</span>
      <span style={{ flex: 1, fontSize: 12, color: '#666' }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: warn ? '#EF5350' : '#333' }}>{value}</span>
      <span style={{ fontSize: 11, color: '#bbb', minWidth: 32, textAlign: 'right' }}>{okRange}</span>
    </div>
  )
}

function MetricBadge({ label, value, unit, warn, critical }: {
  label: string; value: number | undefined; unit: string; warn: number; critical: number
}) {
  const num = value ?? 0
  const hasValue = value !== undefined
  const status = !hasValue ? 'none' : num > critical ? 'danger' : num > warn ? 'warn' : 'ok'
  const bg = status === 'danger' ? 'rgba(239,83,80,0.85)' : status === 'warn' ? 'rgba(255,167,38,0.85)' : 'rgba(0,0,0,0.65)'
  const border = status === 'danger' ? 'rgba(239,83,80,0.5)' : status === 'warn' ? 'rgba(255,167,38,0.5)' : 'rgba(255,255,255,0.1)'

  return (
    <div style={{ background: bg, backdropFilter: 'blur(8px)', borderRadius: 10, padding: '8px 16px', textAlign: 'center', minWidth: 80, border: `1px solid ${border}`, transition: 'all 0.3s' }}>
      <p style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', marginBottom: 3 }}>{label}</p>
      <p style={{ fontSize: 18, fontWeight: 700, color: '#fff' }}>{hasValue ? `${num.toFixed(1)}${unit}` : '--'}</p>
    </div>
  )
}
