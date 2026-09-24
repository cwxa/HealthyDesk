import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import ScoreGauge from './ScoreGauge'
import ExerciseGuide from './ExerciseGuide'
import type { ExerciseGrade } from '../platform/exerciseQuality'

export interface ExerciseState {
  phase: 'active' | 'done'
  current: number
  timeLeft: number
  /**
   * 实时动作达成度（0–100），来自**运动态评分通道**。
   * 刻意不叫 `poseScore`：活动期间用户本来就应该把头摆到非中立位，
   * 拿静息姿态分去衡量运动中的人会得出"姿态异常"的反向结论。
   */
  activityScore: number
  hasPose: boolean
  /** 本次活动的达成度采样序列（每个采样点是运动态通道的分数）。 */
  sessionScores: number[]
  totalDur: number
  progress: number
  /**
   * 实时引导（来自 `judgeExercise` 的滚动窗口判定）。
   * 空串表示"窗口内帧还不够，暂时不给提示" —— 不要用静态文案兜底，
   * 否则会在动作刚开始时给出一句与实际无关的话。
   */
  qualityHint: string
  /** 实时引导对应的结论；null = 窗口内数据不足。 */
  qualityGrade: ExerciseGrade | null
  /**
   * 整场活动的完成度统计。
   * - `completed`：判为「完成」的动作数
   * - `moved`：**动过但没到位**的动作数（grade = insufficient）—— 收尾文案靠它区分
   *   「你根本没动」和「你动了但幅度不够」，否则会用"没检测到动作"去说一个正在努力的人
   * - `judged`：**可判定且有采样**的动作数（分母）
   * - `notJudgeable`：当前指标测不到、因此**没参与判定**的动作数
   *
   * 摄像头没拍到人时 `judged` 为 0，此时**不能**下"你没做"的结论，
   * 界面显示 `--`（与「平均达成度」在无数据时显示 `--` 同一口径）。
   */
  verdict: { completed: number; moved: number; judged: number; notJudgeable: number } | null
}

/**
 * 动作库。
 *
 * `kind` / `min_cycles` 是完成度判定（`judgeExercise`）所需的元数据：
 * 保持类看「幅度 + 保持时长」，往复类看「幅度 + 有效次数」。
 *
 * 🔴 `measurable` —— **当前三个指标能否反映这个动作**。判据是本节目的度量本身：
 *    `exerciseActivity` 只看「头部侧倾角 / 肩部高度差 / 脊柱倾斜角」三个量，
 *    它们反映的是**不对称与倾斜**。于是：
 *      - 头侧屈、肩部环绕 → 会产生明显的单侧偏斜 / 高度差 → 可判定 ✅
 *      - 颈部左右转（绕垂直轴旋转，正对摄像头时耳线仍水平）、
 *        扩胸（双侧对称）、头部后缩（矢状面平移，三角度几乎不变）→ **测不到** ❌
 *    对不可判定的动作给"没检测到动作"的结论，就是**冤枉真的在做的用户** ——
 *    正是 S2 要消灭的那类缺陷（产品惩罚用户做它要求做的事）。
 *    所以这类动作**不参与完成度判定**，界面照常给静态要领、不给实时判定。
 *    ⚠️ 这张表是按指标定义推出来的，**尚未用真机数据校准**（本项目目前没有
 *    真机验证手段）。将来拿到真实帧序列后应重新核对，必要时改判。
 *
 * 这里仍然硬编码在组件里 —— 抽成独立数据模块是 ROADMAP-SCORING 的 S7，
 * 届时 `kind` / `min_cycles` / `measurable` 三个字段要一并搬过去。
 */
export const exercises = [
  { name: '颈部左侧屈', duration: 12, icon: '↩', hint: '头向左肩倾斜，感受右侧颈部拉伸', color: '#4CAF50', kind: 'hold' as const, min_cycles: 0, measurable: true },
  { name: '颈部右侧屈', duration: 12, icon: '↪', hint: '头向右肩倾斜，感受左侧颈部拉伸', color: '#66BB6A', kind: 'hold' as const, min_cycles: 0, measurable: true },
  { name: '颈部左转', duration: 12, icon: '⬅', hint: '缓慢向左转头，保持双肩放松', color: '#2196F3', kind: 'hold' as const, min_cycles: 0, measurable: false },
  { name: '颈部右转', duration: 12, icon: '➡', hint: '缓慢向右转头，保持双肩放松', color: '#42A5F5', kind: 'hold' as const, min_cycles: 0, measurable: false },
  { name: '肩部环绕', duration: 12, icon: '⭕', hint: '双肩向后画圈，幅度尽量大', color: '#FF9800', kind: 'cyclic' as const, min_cycles: 3, measurable: true },
  { name: '扩胸运动', duration: 12, icon: '🤲', hint: '双手后伸，挺胸抬头', color: '#9C27B0', kind: 'cyclic' as const, min_cycles: 3, measurable: false },
  { name: '头部后缩', duration: 10, icon: '⬇', hint: '收下巴向后平移，像做双下巴', color: '#00BCD4', kind: 'hold' as const, min_cycles: 0, measurable: false },
]

interface Props {
  state: ExerciseState
  onSkipCurrent: () => void
  onEndExercise: () => void
}

export default function ExercisePanel({ state, onSkipCurrent, onEndExercise }: Props) {
  const navigate = useNavigate()
  const { phase, current, timeLeft, activityScore, hasPose, sessionScores, totalDur, progress, qualityHint, qualityGrade, verdict } = state
  const ex = exercises[current]

  if (phase === 'done') {
    const avg = sessionScores.length > 0
      ? Math.round(sessionScores.reduce((a, b) => a + b, 0) / sessionScores.length)
      : 0

    // ⚠️ 收尾文案必须与判定**同源**，分三种而不是两种：
    //   有人完成 → 完成；动了没到位 → "幅度还可以更大"；一次都没动 → "没检测到动作"。
    //   只分两种（完成 / 没检测到动作）就会拿"没检测到动作"去说一个确实在动、
    //   只是幅度不够的人 —— 又是"文案与判定互相打脸"。
    //   judged === 0（摄像头没拍到人）时什么都不断言，保持原来的「活动完成!」。
    const judged = verdict?.judged ?? 0
    const completedCount = verdict?.completed ?? 0
    const movedCount = verdict?.moved ?? 0
    const headline =
      judged === 0 || completedCount > 0
        ? { icon: '🎉', title: '活动完成!', color: '#2E7D32', sub: '' }
        : movedCount > 0
          ? { icon: '💪', title: '动作做到了，幅度还可以更大', color: '#EF6C00', sub: '按引导把幅度再打开一点，效果更好' }
          : { icon: '🤔', title: '本次没检测到动作', color: '#EF6C00', sub: '下次跟着引导一起做吧' }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 16 }}>
        <motion.div initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ type: 'spring', stiffness: 200 }}>
          <span style={{ fontSize: 48 }}>{headline.icon}</span>
        </motion.div>
        <h3 style={{ fontSize: 20, fontWeight: 700, color: headline.color, textAlign: 'center' }}>
          {headline.title}
        </h3>
        {headline.sub && (
          <p style={{ fontSize: 12, color: '#999', marginTop: -8 }}>{headline.sub}</p>
        )}
        <div style={{ display: 'flex', gap: 28 }}>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 26, fontWeight: 700, color: '#2E7D32' }}>{sessionScores.length > 0 ? avg : '--'}</p>
            <p style={{ fontSize: 12, color: '#999' }}>平均达成度</p>
          </div>
          <div style={{ textAlign: 'center' }}>
            {/* 分母用"可判定且有采样"的动作数，不是动作总数：没数据时显示 --，不编造 0/7 */}
            <p style={{ fontSize: 26, fontWeight: 700, color: '#2E7D32' }}>{judged > 0 ? completedCount : '--'}</p>
            <p style={{ fontSize: 12, color: '#999' }}>到位动作{judged > 0 ? ` / ${judged}` : ''}</p>
          </div>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 26, fontWeight: 700, color: '#2E7D32' }}>{totalDur}s</p>
            <p style={{ fontSize: 12, color: '#999' }}>活动时长</p>
          </div>
        </div>
        {/* 说清"判定了几个" —— 只统计指标能反映的动作，剩下几个不装作判过 */}
        {verdict !== null && verdict.notJudgeable > 0 && (
          <p style={{ fontSize: 11, color: '#bbb', textAlign: 'center', lineHeight: 1.5, maxWidth: 260 }}>
            另有 {verdict.notJudgeable} 个动作（转颈 / 扩胸 / 头部后缩）当前摄像头角度无法判定，未计入
          </p>
        )}
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

      {/* Exercise animation guide */}
      <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 12 }}>
        <ExerciseGuide exerciseIndex={current} color={ex.color} size={160} />
      </div>

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
        <p style={{ fontSize: 12, color: '#999', marginBottom: 6 }}>实时动作达成度</p>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <ScoreGauge score={activityScore} size={80} hasData={hasPose} />
        </div>
      </div>

      {/* 实时引导（判定结果驱动，取代了"只有一个倒计时"）
          ⚠️ 固定高度占位：这段文字跟着高频判定结果反复出现/消失，
          一旦参与布局就会不断改变面板高度、把下面所有元素推来推去。 */}
      <div style={{
        height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 8, flexShrink: 0,
      }}>
        {qualityGrade !== null && (
          <span style={{
            fontSize: 13, fontWeight: 600, lineHeight: 1.3,
            color: qualityGrade === 'completed' ? '#2E7D32' : '#EF6C00',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%',
          }}>{qualityHint}</span>
        )}
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
