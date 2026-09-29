import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import ScoreGauge from './ScoreGauge'
import ExerciseGuide from './ExerciseGuide'
import type { ActionScoreItem, ExerciseGrade } from '../platform/exerciseQuality'
import { sessionScoreOf } from '../platform/exerciseQuality'
import { EXERCISES as exercises, NOT_MEASURABLE_LABEL } from '../data/exercises'

export interface ExerciseState {
  phase: 'active' | 'done'
  current: number
  timeLeft: number
  /**
   * 实时动作达成度（0–100）。
   * 刻意不叫 `poseScore`：活动期间用户本来就应该把头摆到非中立位，
   * 拿静息姿态分去衡量运动中的人会得出"姿态异常"的反向结论。
   *
   * 🔴 v1.7.0 起：**有逐动作判定时，它与 `qualityHint` 同源** ——
   * 同一个滚动窗口 verdict、同一个 `scoreExercise`（也就是与逐动作成绩同一个函数），
   * 因此徽章与提示不可能互相打脸，且徽章同样满足「≥ 80 ⟺ 判完成」（未达标钳到 79 以下）。
   * 只有当判定取不到时（动作的指标测不到 / 窗口帧不足）才回落到**运动态评分通道**
   * （`_exercise_score`，三项取最大的绝对偏离）；那时 `qualityHint` 也是空的，
   * 所以仍然不会出现"徽章说好、提示说没动"的组合。
   */
  activityScore: number
  hasPose: boolean
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
   * - `items`：**逐动作得分明细**（只含 `judged` 的那些）——
   *   界面上的「本次动作成绩」与落库的 `action_scores` 都由它派生，
   *   这样"总分 / 逐项 / 到位动作数"三者同源，不可能互相矛盾。
   *
   * 摄像头没拍到人时 `judged` 为 0、`items` 为空，此时**不能**下"你没做"的结论，
   * 界面显示 `--`（与「本次动作成绩」在无明细时显示 `--` 同一口径）。
   * 🔴 `items` 为空 ≠ "得 0 分"，也 ≠ "老记录没有这项数据"：三态别混。
   */
  verdict: {
    completed: number
    moved: number
    judged: number
    notJudgeable: number
    items: ActionScoreItem[]
  } | null
}

// 动作库已抽到 `src/data/exercises.ts`（ROADMAP-SCORING S7）：这里是**消费者**，
// 不再定义动作。别名 `exercises` 只为让下面的读法保持不变。
// 🔴 别把数组搬回来 —— `scripts/verify-exercises.mjs` 会断言「动作名只出现在数据文件里」，
//    且引导组件已改为按数据里的图元作图（不再按下标 `switch`）。

interface Props {
  state: ExerciseState
  onSkipCurrent: () => void
  onEndExercise: () => void
}

export default function ExercisePanel({ state, onSkipCurrent, onEndExercise }: Props) {
  const navigate = useNavigate()
  const { phase, current, timeLeft, activityScore, hasPose, totalDur, progress, qualityHint, qualityGrade, verdict } = state
  const ex = exercises[current]

  if (phase === 'done') {
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

    // ---- 「本次动作成绩」= 逐动作得分的平均（与明细、与到位动作数同源）----
    // 🔴 这里**不再**用「逐帧达成度的平均」：那个数没有"做到位没有"的含义 ——
    //    用户幅度很小地晃满 82 秒，逐帧平均也能拿到中等分数，而界面每一句引导都在说
    //    「幅度还不够」。用它当成绩就是**文案与数字互相打脸**。
    const items = verdict?.items ?? []
    const sessionScore = sessionScoreOf(items)
    const hasScore = items.length > 0
    const scoreOf = new Map(items.map((it) => [it.id, it]))

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
            {/* 无明细 → `--`。🔴 显示成 0 会被读成"得了 0 分"，
                而 0 分是**可达的**（全程没动），两者必须分开。 */}
            <p style={{ fontSize: 26, fontWeight: 700, color: hasScore ? '#2E7D32' : '#bbb' }}>
              {hasScore ? sessionScore : '--'}
            </p>
            <p style={{ fontSize: 12, color: '#999' }}>本次动作成绩</p>
          </div>
          <div style={{ textAlign: 'center' }}>
            {/* 分母用"可判定且有采样"的动作数，不是动作总数：没数据时显示 --，不编造 0/7 */}
            <p style={{ fontSize: 26, fontWeight: 700, color: judged > 0 ? '#2E7D32' : '#bbb' }}>{judged > 0 ? completedCount : '--'}</p>
            <p style={{ fontSize: 12, color: '#999' }}>到位动作{judged > 0 ? ` / ${judged}` : ''}</p>
          </div>
          <div style={{ textAlign: 'center' }}>
            <p style={{ fontSize: 26, fontWeight: 700, color: '#2E7D32' }}>{totalDur}s</p>
            <p style={{ fontSize: 12, color: '#999' }}>活动时长</p>
          </div>
        </div>

        {/* 逐动作明细：每个动作各得多少分。
            列出**全部**动作而不是只列判过的 —— 少一个动作用户就会以为"系统把我的动作漏了"。
            没判过的如实标「未判定」并写明原因，**不编造分数**、也不显示 0。
            名单与顺序都由动作库派生（不写死），与上面的总分同源。 */}
        {verdict !== null && (
          <div style={{
            width: '100%', maxWidth: 320, maxHeight: 190, overflowY: 'auto',
            background: '#f9fafb', borderRadius: 10, padding: '10px 12px',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <p style={{ fontSize: 11, color: '#999', marginBottom: -2 }}>逐动作得分</p>
            {exercises.map((e) => {
              const it = scoreOf.get(e.id)
              const color = it ? (it.grade === 'completed' ? '#2E7D32' : '#EF6C00') : '#bbb'
              // 未判定的两种原因要分开说，否则用户不知道自己该改什么：
              //   measurable=false → 这个指标本来就测不到（改也是白改）
              //   其余             → 这个动作没采到帧（跳过 / 没进画面）
              const reason = e.measurable ? '未判定' : '未判定·指标测不到'
              return (
                <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#555', width: 82, flexShrink: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {e.name}
                  </span>
                  <div style={{ flex: 1, height: 6, background: '#eee', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${it ? Math.max(0, Math.min(100, it.score)) : 0}%`, background: color, borderRadius: 3 }} />
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color, width: it ? 30 : 96, textAlign: 'right', flexShrink: 0 }}>
                    {it ? it.score : reason}
                  </span>
                </div>
              )
            })}
          </div>
        )}

        {/* 说清"判定了几个" —— 只统计指标能反映的动作，剩下几个不装作判过。
            名单由数据里 `measurable === false` 的动作**派生**（短名去重后拼接）：
            写死动作名会与动作库脱钩，改一个动作就得回来改文案。 */}
        {verdict !== null && verdict.notJudgeable > 0 && (
          <p style={{ fontSize: 11, color: '#bbb', textAlign: 'center', lineHeight: 1.5, maxWidth: 260 }}>
            另有 {verdict.notJudgeable} 个动作（{NOT_MEASURABLE_LABEL}）当前摄像头角度无法判定，未计入
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
        <ExerciseGuide exercise={ex} size={160} />
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
