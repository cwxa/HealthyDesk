interface Props {
  score: number
  size?: number
  hasData?: boolean
  /**
   * 守卫定位用的稳定锚点（渲染成最外层 `data-ng="<值>"`）。
   *
   * 🔴 存在的理由不是美观，是**踩过**：`verify:ui` 里那条「实时徽章与实时提示不矛盾」
   * 原来靠层级找（`p"实时动作达成度"` → `parentElement` → `span`）。移动端布局里
   * **根本没有那个 `<p>`**（练习条上的徽章没有标题），于是 `gauge` 恒为 `null`、
   * 循环整段 `continue` —— 断言一路"✓"着，却一次都没检查过任何东西，
   * 直到变异测试里那条 `activityScore` 变异漏网才暴露出来。
   * 凡是"守卫要读的数"，都挂一个不依赖布局层级的锚点。
   */
  ngId?: string
}

export default function ScoreGauge({ score, size = 80, hasData = false, ngId }: Props) {
  const radius = size / 2 - 6
  const circumference = 2 * Math.PI * radius
  const safeScore = Math.max(0, Math.min(100, score))
  const offset = circumference * (1 - safeScore / 100)
  const color = safeScore >= 80 ? 'var(--success)' : safeScore >= 60 ? 'var(--warning)' : 'var(--danger)'
  const showValue = hasData || score > 0

  return (
    <div data-ng={ngId} style={{ position: 'relative', width: size, height: size }}>
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
