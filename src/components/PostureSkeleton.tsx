import type { Landmarks } from '../types'

interface Props {
  landmarks: Landmarks
  width: number
  height: number
}

const CONNECTIONS: [keyof Landmarks, keyof Landmarks][] = [
  ['nose', 'left_ear'],
  ['nose', 'right_ear'],
  ['left_ear', 'right_ear'],
  ['left_ear', 'left_shoulder'],
  ['right_ear', 'right_shoulder'],
  ['left_shoulder', 'right_shoulder'],
]

export default function PostureSkeleton({ landmarks, width, height }: Props) {
  const hasPoints = Object.values(landmarks).some(p => p?.x)

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        display: 'block',
        pointerEvents: 'none',
      }}
    >
      {/* Glow filter */}
      <defs>
        <filter id="glow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="pointGlow" x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Connection lines */}
      {CONNECTIONS.map(([from, to], i) => {
        const p1 = landmarks[from]
        const p2 = landmarks[to]
        if (!p1?.x || !p2?.x) return null
        return (
          <line
            key={`line-${i}`}
            x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
            stroke="rgba(66,165,245,0.85)"
            strokeWidth={4}
            strokeLinecap="round"
            filter="url(#glow)"
          />
        )
      })}

      {/* Landmark points */}
      {Object.entries(landmarks).map(([key, point]) => {
        if (!point?.x) return null
        const isHead = key === 'nose' || key.includes('ear')
        const isShoulder = key.includes('shoulder')

        let fill: string
        let r: number
        if (isHead) {
          fill = 'rgba(255,235,59,0.95)'
          r = 6
        } else if (isShoulder) {
          fill = 'rgba(239,83,80,0.95)'
          r = 8
        } else {
          fill = 'rgba(66,165,245,0.9)'
          r = 5
        }

        return (
          <circle
            key={`pt-${key}`}
            cx={point.x} cy={point.y}
            r={r}
            fill={fill}
            stroke="rgba(255,255,255,0.9)"
            strokeWidth={2}
            filter="url(#pointGlow)"
          />
        )
      })}

      {/* No points detected */}
      {!hasPoints && (
        <text
          x={width / 2}
          y={height / 2}
          textAnchor="middle"
          fill="rgba(255,255,255,0.5)"
          fontSize={16}
          fontFamily="sans-serif"
        >
          未检测到姿态点
        </text>
      )}
    </svg>
  )
}
