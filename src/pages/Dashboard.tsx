import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { useApi } from '../hooks/useApi'
import ScoreGauge from '../components/ScoreGauge'
import TrendChart from '../components/TrendChart'
import type { ActivityRecord, WeeklyReport as WeeklyReportType } from '../types'
import { TrendingUpIcon, ActivityIcon, BarChart2Icon, CheckIcon, MonitorIcon, ClockIcon, NeckIcon, FlameIcon } from '../components/icons'

interface Summary { today_activities: number; today_avg: number }

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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
        <StatCard label="今日平均评分" value={summary?.today_avg} unit="分" color="#4CAF50" icon={TrendingUpIcon} delay={0} />
        <StatCard label="今日活动次数" value={summary?.today_activities} unit="次" color="#FF9800" icon={ActivityIcon} delay={0.04} />
        <StatCard label="本周平均评分" value={weekly?.posture_avg} unit="分" color="#2196F3" icon={BarChart2Icon} delay={0.08} />
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

      {/* Bottom: 2x2 grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.18 }}
          style={{ background: '#fff', borderRadius: 14, padding: '20px 24px', boxShadow: '0 1px 8px rgba(0,0,0,0.06)', display: 'flex', alignItems: 'center', gap: 20 }}
        >
          <ScoreGauge score={summary?.today_avg ?? 0} size={80} hasData={summary?.today_avg !== undefined} />
          <div style={{ flex: 1 }}>
            <p style={{ fontSize: 14, fontWeight: 600, color: '#333', marginBottom: 10 }}>健康指数</p>
            <HealthBar label="头部" value={85} color="#4CAF50" />
            <HealthBar label="肩部" value={summary?.today_avg ? Math.min(100, summary.today_avg + 5) : 0} color="#2196F3" />
            <HealthBar label="脊柱" value={summary?.today_avg ?? 0} color="#FF9800" />
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

  const scoreColor = activity.avg_score >= 80 ? '#4CAF50' : activity.avg_score >= 60 ? '#FF9800' : '#EF5350'

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
      <div style={{
        padding: '4px 12px', borderRadius: 20,
        background: activity.avg_score >= 80 ? '#E8F5E9' : activity.avg_score >= 60 ? '#FFF3E0' : '#FFEBEE',
        fontWeight: 700, fontSize: 15,
        color: scoreColor,
      }}>
        {activity.avg_score}分
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

function HealthBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ fontSize: 11, color: '#999', width: 28 }}>{label}</span>
      <div style={{ flex: 1, height: 6, background: '#f0f0f0', borderRadius: 3, overflow: 'hidden' }}>
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.8, delay: 0.3 }}
          style={{ height: '100%', borderRadius: 3, background: color }}
        />
      </div>
      <span style={{ fontSize: 11, color: '#999', width: 32, textAlign: 'right' }}>{pct}%</span>
    </div>
  )
}
