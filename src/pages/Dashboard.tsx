import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useApi } from '../hooks/useApi'
import { isMobile } from '../platform/runtime'
import type { PartHealth } from '../platform/partHealth'
import ScoreGauge from '../components/ScoreGauge'
import TrendChart from '../components/TrendChart'
import AIAnalysisPanel from '../components/AIAnalysisPanel'
import type { ActivityRecord, WeeklyReport as WeeklyReportType } from '../types'
import { parseActionScoresDetailed } from '../platform/exerciseQuality'
import { TrendingUpIcon, ActivityIcon, BarChart2Icon, CheckIcon, MonitorIcon, ClockIcon, NeckIcon, FlameIcon } from '../components/icons'

interface Summary {
  today_activities: number
  today_avg: number
  /** 三个部位各自的真实聚合；后端与移动端 localStats 都提供（旧数据缺失时为 undefined）。 */
  part_health?: PartHealth
}

export default function Dashboard() {
  const { get } = useApi()
  const [summary, setSummary] = useState<Summary | null>(null)
  const [activities, setActivities] = useState<ActivityRecord[]>([])
  const [weekly, setWeekly] = useState<WeeklyReportType | null>(null)

  useEffect(() => {
    get<Summary>('/api/stats/summary').then(setSummary).catch(e => console.error('Stats summary failed:', e))
    get<ActivityRecord[]>('/api/activity/recent?limit=10').then(setActivities).catch(e => console.error('Activity recent failed:', e))
    get<WeeklyReportType>('/api/stats/weekly').then(setWeekly).catch(e => console.error('Weekly report failed:', e))
  }, [get])

  /**
   * 组装 AI 分析请求体。
   *
   * 🔴 `score` 在提示词里是**「当前姿态评分」**（`backend/services/ai_advisor.py`），
   * 所以它只能来自**静息姿态通道**。这里原先是
   * `activities[0].avg_score`（局部变量还叫 `hasPose`）—— 那是**活动成绩**
   * （"动作做到位没有"），与坐姿无关：用户刚做完一组拉伸时运动态通道刻意把分数压住，
   * AI 于是拿一个活动分去回答"我坐姿怎么样"。
   *
   * 两个字段名都像"分数"、取值又都是 0–100，所以这个混用长期没人发现 ——
   * 正是本项目反复修的那类「文案与数字互相打脸」。现在活动成绩另有
   * `action_scores` 逐动作明细，更不该再冒充姿态分：
   * **姿态分一律走 `today_avg` / `weekly_avg`，活动分一律走 `avg_score`。**
   */
  const buildAIPayload = useCallback(() => {
    const postureScore = summary?.today_avg ?? weekly?.posture_avg
    if (weekly === null && summary === null) return null

    return {
      score: postureScore,
      today_avg: summary?.today_avg ?? undefined,
      weekly_avg: weekly?.posture_avg ?? undefined,
      today_activities: summary?.today_activities ?? undefined,
      completion_rate: weekly?.completion_rate ?? undefined,
      daily_minutes: weekly ? Math.round(weekly.total_minutes / 7) : undefined,
      issues: [],
    }
  }, [summary, weekly])

  const tips = [
    { icon: MonitorIcon, text: '显示器顶部与眼睛齐平' },
    { icon: ClockIcon, text: '每30分钟起身活动' },
    { icon: NeckIcon, text: '保持背部挺直坐姿' },
    { icon: FlameIcon, text: '双肩放松自然下沉' },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div>
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 4 }}>📊 仪表盘</h2>
        <p style={{ fontSize: 13, color: '#999' }}>您的肩颈健康概览</p>
      </div>

      {/* Stats cards */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile() ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: 14 }}>
        <StatCard label="今日平均评分" value={summary?.today_avg} unit="分" color="#4CAF50" icon={TrendingUpIcon} delay={0} />
        <StatCard label="今日活动次数" value={summary?.today_activities} unit="次" color="#FF9800" icon={ActivityIcon} delay={0.04} />
        <StatCard label="本周平均评分" value={weekly?.posture_avg} unit="分" color="#2196F3" icon={BarChart2Icon} delay={0.08} />
        <p style={{ fontSize: 12, color: '#888', gridColumn: '1 / -1' }}>姿态统计采用更新后的测量口径，历史旧口径数据保留在导出记录中。</p>
        <StatCard label="活动完成率" value={weekly?.completion_rate} unit="%" color="#9C27B0" icon={CheckIcon} delay={0.12} />
      </div>

      {/* Trend chart */}
      {weekly && weekly.trend.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.16 }}
          style={{ background: '#fff', borderRadius: 14, padding: '20px 24px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}
        >
          <p style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 12 }}>📈 姿态评分趋势（近7天）</p>
          <TrendChart data={weekly.trend} />
        </motion.div>
      )}

      {/* AI 肩颈分析 */}
      {/* AI 分析仅桌面端提供（移动端无后端，本期不支持） */}
      {!isMobile() && <AIAnalysisPanel buildPayload={buildAIPayload} />}

      {/* Bottom: 2x2 grid */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile() ? '1fr' : '1fr 1fr', gap: 14 }}>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18 }}
          style={{ background: '#fff', borderRadius: 14, padding: '20px 24px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', gap: 20 }}
        >
          <ScoreGauge score={summary?.today_avg ?? 0} size={80} hasData={summary?.today_avg !== undefined} />
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 10 }}>健康指数</p>
            {/* 三个值均来自 posture_score 的分项字段真实聚合（后端 part_health.py /
                移动端 partHealth.ts），此前头部写死 85、肩部凭空 +5、躯干直接用总分。
                无采样时为 null → 显示「暂无数据」，而不是被误读成「健康度 0」。 */}
            <HealthBar label="头部" value={summary?.part_health?.head} color="#4CAF50" />
            <HealthBar label="肩部" value={summary?.part_health?.shoulder} color="#2196F3" />
            <HealthBar label="躯干" value={summary?.part_health?.spine} color="#FF9800" />
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.24 }}
          style={{ background: '#fff', borderRadius: 14, padding: '20px 24px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}
        >
          <p style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 14 }}>💡 健康小贴士</p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {tips.map((tip, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
                <tip.icon size={16} color="#666" />
                <span style={{ fontSize: 12, color: '#666' }}>{tip.text}</span>
              </div>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.30 }}
          style={{ background: '#fff', borderRadius: 14, padding: '20px 24px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}
        >
          <p style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 12 }}>💪 改善建议</p>
          <ul style={{ fontSize: 13, color: '#999', paddingLeft: 18, lineHeight: 2, margin: 0 }}>
            <li>保持每天活动习惯</li>
            <li>注意工作时长控制</li>
            <li>坚持定时活动习惯</li>
            {weekly && weekly.posture_avg < 60 && <li style={{ color: '#EF5350' }}>⚠ 姿态评分偏低，建议增加活动频率</li>}
            {weekly && weekly.completion_rate < 50 && <li style={{ color: '#FF9800' }}>⚠ 活动完成率偏低，请重视每次提醒</li>}
          </ul>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.36 }}
          style={{ background: '#fff', borderRadius: 14, padding: '20px 24px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}
        >
          <p style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 12 }}>📋 数据摘要</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <SummaryRow label="本周活动次数" value={`${weekly?.weekly_activities ?? '--'}次`} />
            <SummaryRow label="本周运动时长" value={`${weekly ? Math.round(weekly.total_exercise_sec / 60) : '--'}分钟`} />
            <SummaryRow label="日均使用" value={`${weekly ? Math.round(weekly.total_minutes / 7) : '--'}分钟`} />
            <SummaryRow label="日均活动" value={`${weekly ? (weekly.total_breaks / 7).toFixed(1) : '--'}次`} />
          </div>
        </motion.div>
      </div>

      {/* Activity records */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.3 }}
        style={{ background: '#fff', borderRadius: 14, padding: '20px 24px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}
      >
        <p style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 16 }}>📋 最近活动记录</p>

        {activities.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '32px 0', color: '#bbb' }}>
            <p style={{ fontSize: 36, marginBottom: 8 }}>🧘</p>
            <p style={{ fontSize: 13 }}>暂无活动记录</p>
            <p style={{ fontSize: 12, marginTop: 4 }}>完成一次肩颈活动后将在此显示</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {activities.map((a, i) => (
              <ActivityRow key={a.id} activity={a} isLast={i === activities.length - 1} />
            ))}
          </div>
        )}
      </motion.div>
    </div>
  )
}

function ActivityRow({ activity, isLast }: { activity: ActivityRecord; isLast: boolean }) {
  const time = new Date(activity.timestamp)
  const timeStr = time.toLocaleString('zh-CN', {
    month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
  const isToday = new Date().toDateString() === time.toDateString()
  const timeDisplay = isToday ? `今天 ${time.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : timeStr

  // 🔴 活动分有**四态**，显示必须分开（判据见 `exerciseQuality.parseActionScoresDetailed`）：
  //   `null`              → 老记录：写它的时候还没有逐动作明细，数字来自**改动前的旧口径**
  //                         （静息分 / 逐帧达成度），与现在的成绩**不可比** → 标出来，别假装能比
  //   `legacy` (v1 / v2)  → 有明细，但分数是用**当年那把尺子**算的，同样不可比：
  //                         v1 = 幅度按"绝对偏离"、三项取最大；v2 = 幅度按"活动范围"、
  //                         但不要求极值被时间支撑。⚠️ 两版口径**互不相同**，
  //                         所以下面的 explain 按 `parsed.version` 分开说
  //   `items: []`         → 判过了但一个动作都没判出来（摄像头没拍到人）→ 显示 `--`
  //                         （写 0 会被读成"得了 0 分"，而 0 分是可达的：全程没动）
  //   `items.length>0`    → 本次动作成绩，与收尾页的「逐动作得分」同源
  const parsed = parseActionScoresDetailed(activity.action_scores)
  const legacy = parsed === null || parsed.legacy
  const items = parsed === null ? null : parsed.items
  const noVerdict = items !== null && items.length === 0
  const shown = noVerdict ? '--' : `${activity.avg_score}分`
  let explain: string
  if (parsed === null) {
    explain = '旧记录：当时这个分数用的是改动前的算法，与现在的「本次动作成绩」不可比'
  } else if (parsed.legacy) {
    // 🔴 历史版本不止一个，**口径各不相同**，文案必须按版本说 ——
    // 否则会把 v1 的记录说成"活动范围口径"（那是 v2 才有的事），
    // 等于用一个错的理由去解释一个不可比的数字。
    explain =
      parsed.version === 1
        ? '旧口径（v1）：分数按"偏离有多大"算、且三个维度取最大 —— 与现在的"活动范围 + 时间支撑"不可比'
        : '旧口径（v2）：分数按"活动范围"算，但没要求这个范围的两端被时间支撑（一帧抖动也算数）—— 与现在不可比'
  } else if (items!.length === 0) {
    explain = '本次活动没有可判定的动作（摄像头没拍到人？），因此没有成绩'
  } else {
    explain = `本次动作成绩：${items!.length} 个动作，分别 ${items!.map((it) => it.score).join(' / ')}`
  }

  const scoreColor = noVerdict
    ? '#999'
    : activity.avg_score >= 80 ? '#4CAF50' : activity.avg_score >= 60 ? '#FF9800' : '#EF5350'

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 0', borderBottom: isLast ? 'none' : '1px solid #f5f5f5',
    }}>
      <div style={{
        width: 36, height: 36, borderRadius: 10,
        background: activity.activity_type === 'exercise' ? '#E8F5E9' : '#E3F2FD',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <span style={{ fontSize: 16 }}>{activity.activity_type === 'exercise' ? '🧘' : '⚡'}</span>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ fontSize: 13, fontWeight: 500, color: '#333' }}>
          {activity.activity_type === 'exercise' ? '肩颈放松活动' : '快速活动'}
        </p>
        <p style={{ fontSize: 11, color: '#999' }}>
          {timeDisplay} · {activity.exercise_count} 个动作 · {activity.duration_sec}秒
        </p>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {legacy && (
          <span
            title={explain}
            style={{ fontSize: 10, color: '#999', border: '1px solid #e0e0e0', borderRadius: 4, padding: '1px 4px' }}
          >
            旧口径
          </span>
        )}
        <div title={explain} style={{
          padding: '4px 12px', borderRadius: 20,
          background: noVerdict ? '#f5f5f5' : activity.avg_score >= 80 ? '#E8F5E9' : activity.avg_score >= 60 ? '#FFF3E0' : '#FFEBEE',
          fontWeight: 700, fontSize: 15,
          color: scoreColor,
        }}>
          {shown}
        </div>
      </div>
    </div>
  )
}

function StatCard({ label, value, unit, color, icon: Icon, delay }: {
  label: string; value: number | undefined; unit: string; color: string; icon: React.ElementType; delay: number
}) {
  return (
    <div
      style={{ background: '#fff', borderRadius: 14, padding: '20px 22px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <Icon size={20} color={color} />
        <span style={{ fontSize: 13, color: '#999', fontWeight: 500 }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 34, fontWeight: 700, color, lineHeight: 1 }}>{value !== undefined ? Math.round(value) : '--'}</span>
        <span style={{ fontSize: 14, color: '#bbb' }}>{unit}</span>
      </div>
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 0', borderBottom: '1px solid #f5f5f5' }}>
      <span style={{ fontSize: 13, color: '#999' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600, color: '#555' }}>{value}</span>
    </div>
  )
}

function HealthBar({ label, value, color }: { label: string; value: number | null | undefined; color: string }) {
  // 无数据（今日还没有任何姿态采样）与「健康度 0」是两件事，不能都用 0 表示。
  const hasData = typeof value === 'number' && Number.isFinite(value)
  const pct = hasData ? Math.max(0, Math.min(100, value)) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 11, color: '#999', width: 28 }}>{label}</span>
      <div style={{ flex: 1, height: 6, background: '#f0f0f0', borderRadius: 3, overflow: 'hidden' }}>
        {hasData && (
          <motion.div
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 0.8, delay: 0.3 }}
            style={{ height: '100%', borderRadius: 3, background: color }}
          />
        )}
      </div>
      <span style={{ fontSize: 11, color: hasData ? '#999' : '#ccc', width: 48, textAlign: 'right' }}>
        {hasData ? `${pct}%` : '暂无数据'}
      </span>
    </div>
  )
}
