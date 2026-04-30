import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import ScoreGauge from './ScoreGauge'

export interface ExerciseState {
  phase: 'active' | 'done'
  current: number
  timeLeft: number
  poseScore: number
  hasPose: boolean
  sessionScores: number[]
  totalDur: number
  progress: number
}

export const exercises = [
  { name: '颈部左侧屈', duration: 12, icon: '↩', hint: '头向左肩倾斜，感受右侧颈部拉伸', color: '#4CAF50' },
  { name: '颈部右侧屈', duration: 12, icon: '↪', hint: '头向右肩倾斜，感受左侧颈部拉伸', color: '#66BB6A' },
  { name: '颈部左转', duration: 12, icon: '⬅', hint: '缓慢向左转头，保持双肩放松', color: '#2196F3' },
  { name: '颈部右转', duration: 12, icon: '➡', hint: '缓慢向右转头，保持双肩放松', color: '#42A5F5' },
  { name: '肩部环绕', duration: 12, icon: '⭕', hint: '双肩向后画圈，幅度尽量大', color: '#FF9800' },
  { name: '扩胸运动', duration: 12, icon: '🤲', hint: '双手后伸，挺胸抬头', color: '#9C27B0' },
  { name: '头部后缩', duration: 10, icon: '⬇', hint: '收下巴向后平移，像做双下巴', color: '#00BCD4' },
]

interface Props {
  state: ExerciseState
  onSkipCurrent: () => void
  onEndExercise: () => void
}

export default function ExercisePanel({ state, onSkipCurrent, onEndExercise }: Props) {
  const navigate = useNavigate()
  const { phase, current, timeLeft, poseScore, hasPose, sessionScores, totalDur, progress } = state
  const ex = exercises[current]

  if (phase === 'done') {
    const avg = sessionScores.length > 0
      ? Math.round(sessionScores.reduce((a, b) => a + b, 0) / sessionScores.length)
      : 0

    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 16 }}>
        <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200 }}>
          <span style={{ fontSize: 48 }}>🎉</span>
        </motion.div>
        <h3 style={{ fontSize: 20, fontWeight: 700, color: '#2E7D32' }}>活动完成!</h3>
        <div style={{ display: 'flex', gap: 28 }}>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 26, fontWeight: 700, color: '#2E7D32' }}>{sessionScores.length > 0 ? avg : '--'}</p>
            <p style={{ fontSize: 12, color: '#999' }}>平均评分</p>
          </div>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 26, fontWeight: 700, color: '#2E7D32' }}>{totalDur}s</p>
            <p style={{ fontSize: 12, color: '#999' }}>活动时长</p>
          </div>
        </div>
        <button
          onClick={() => navigate('/dashboard')}
          style={{
            marginTop: 8, padding: '10px 24px', borderRadius: 8, border: 'none',
            background: 'linear-gradient(135deg, #4CAF50, #66BB6A)',
            color: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600,
          }}
        >
          查看统计 →
        </button>
      </div>
    )
  }

  const exDuration = exercises[current].duration
  const timePct = exDuration > 0 ? timeLeft / exDuration : 0
  const timerRadius = 44
  const timerCircumference = 2 * Math.PI * timerRadius
  const timerOffset = timerCircumference * (1 - timePct)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
      {/* Exercise steps indicator */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {exercises.map((item, i) => (
          <div key={i} style={{
            flex: 1, height: 4, borderRadius: 2,
            background: i < current ? item.color : i === current ? item.color : '#eee',
            opacity: i <= current ? 1 : 0.5,
            transition: 'all 0.3s',
          }} />
        ))}
      </div>

      {/* Current exercise */}
      <AnimatePresence mode="wait">
        <motion.div
          key={current}
          initial={{ opacity: 0, x: -16 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 16 }}
          transition={{ duration: 0.2 }}
          style={{ textAlign: 'center', marginBottom: 12 }}
        >
          <div style={{ width: 60, height: 60, borderRadius: '50%', background: `${ex.color}15`, display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 10px' }}>
            <span style={{ fontSize: 30 }}>{ex.icon}</span>
          </div>
          <h3 style={{ fontSize: 20, fontWeight: 700, color: '#333', marginBottom: 4 }}>{ex.name}</h3>
          <p style={{ fontSize: 13, color: '#777', lineHeight: 1.5 }}>{ex.hint}</p>
        </motion.div>
      </AnimatePresence>

      {/* Countdown timer */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
        <div style={{ position: 'relative', width: 100, height: 100 }}>
          <svg width={100} height={100} style={{ transform: 'rotate(-90deg)' }}>
            <circle cx={50} cy={50} r={timerRadius} fill="none" stroke="#eee" strokeWidth={5} />
            <circle cx={50} cy={50} r={timerRadius} fill="none"
              stroke={timeLeft <= 3 ? '#EF5350' : '#4CAF50'}
              strokeWidth={5} strokeLinecap="round"
              strokeDasharray={timerCircumference}
              strokeDashoffset={timerOffset}
              style={{ transition: 'stroke-dashoffset 1s linear, stroke 0.3s' }}
            />
          </svg>
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
            <span style={{ fontSize: 34, fontWeight: 800, color: timeLeft <= 3 ? '#EF5350' : '#2E7D32', lineHeight: 1 }}>{timeLeft}</span>
            <span style={{ fontSize: 11, color: '#999', marginTop: 2 }}>秒</span>
          </div>
        </div>
      </div>

      {/* Live score */}
      <div style={{ textAlign: 'center', marginBottom: 16 }}>
        <p style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>实时姿态评分</p>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ScoreGauge score={poseScore} size={80} hasData={hasPose} />
        </div>
      </div>

      {/* Progress */}
      <div style={{ background: '#f9fafb', borderRadius: 10, padding: '12px 16px', marginTop: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: '#999' }}>总体进度</span>
          <span style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>{current + 1} / {exercises.length}</span>
        </div>
        <div style={{ height: 6, background: '#eee', borderRadius: 3, overflow: 'hidden' }}>
          <motion.div style={{ height: '100%', borderRadius: 3, background: 'linear-gradient(90deg, #4CAF50, #81C784)' }} animate={{ width: `${progress}%` }} transition={{ duration: 0.3 }} />
        </div>
      </div>

      {/* Bottom actions */}
      <div style={{ paddingTop: 12, display: 'flex', gap: 10 }}>
        <button onClick={onSkipCurrent} style={{
          flex: 1, padding: '10px 16px', borderRadius: 8,
          border: '1px solid #e0e0e0', background: '#fff',
          color: '#999', cursor: 'pointer', fontSize: 13, fontWeight: 500,
        }}>
          跳过当前
        </button>
        <button onClick={onEndExercise} style={{
          flex: 1, padding: '10px 16px', borderRadius: 8,
          border: '1px solid #FFCDD2', background: '#fff',
          color: '#EF5350', cursor: 'pointer', fontSize: 13, fontWeight: 500,
        }}>
          结束活动
        </button>
      </div>
    </div>
  )
}
