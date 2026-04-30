interface Props {
  score: number
  size?: number
  hasData?: boolean
}

export default function ScoreGauge({ score, size = 80, hasData = false }: Props) {
  const radius = size / 2 - 6
  const circumference = 2 * Math.PI * radius
  const safeScore = Math.max(0, Math.min(100, score))
  const offset = circumference * (1 - safeScore / 100)
  const color = safeScore >= 80 ? 'var(--success)' : safeScore >= 60 ? 'var(--warning)' : 'var(--danger)'
  const showValue = hasData || score > 0

  return (
    <div style={{ position: 'relative', width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--border)"
          strokeWidth={5}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={5}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
        />
      </svg>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <span style={{
          fontSize: score > 0 ? size * 0.28 : size * 0.24,
          fontWeight: 700,
          color: showValue ? color : '#ccc',
        }}>
          {showValue ? score : '--'}
        </span>
      </div>
    </div>
  )
}
