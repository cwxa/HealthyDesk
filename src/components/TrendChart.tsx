import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

interface Props {
  data: { day: string; avg_score: number }[]
}

export default function TrendChart({ data }: Props) {
  if (data.length === 0) {
    return (
      <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: 14 }}>暂无数据</p>
      </div>
    )
  }

  const formatted = data.map((d) => ({
    ...d,
    day: d.day.slice(5),
  }))

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={formatted} margin={{ top: 12, right: 12, bottom: 12, left: 12 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
        <XAxis dataKey="day" fontSize={12} tick={{ fill: '#607D8B' }} />
        <YAxis domain={[0, 100]} fontSize={12} tick={{ fill: '#607D8B' }} />
        <Tooltip
          contentStyle={{ borderRadius: 8, border: '1px solid #e0e0e0' }}
          formatter={(value: number) => [`${value} 分`, '平均评分']}
          labelFormatter={(label: string) => `日期: ${label}`}
        />
        <Line
          type="monotone"
          dataKey="avg_score"
          stroke="#4CAF50"
          strokeWidth={2}
          dot={{ fill: '#4CAF50', r: 4 }}
          activeDot={{ r: 6 }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
