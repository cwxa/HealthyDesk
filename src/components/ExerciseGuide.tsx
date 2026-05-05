import { motion } from 'framer-motion'
import { useEffect } from 'react'

interface Props {
  exerciseIndex: number
  color: string
  size?: number
}

// 肩颈活动动画引导组件 - 使用SVG+Framer Motion直观展示每个动作
export default function ExerciseGuide({ exerciseIndex, color, size = 160 }: Props) {
  useEffect(() => {
    console.log(`[ExerciseGuide] Rendering exercise ${exerciseIndex}, color=${color}`)
  }, [exerciseIndex, color])

  const c = size / 2
  const headR = size * 0.16
  const bodyW = size * 0.22
  const shoulderY = c + size * 0.05

  // 头部基础位置（颈部上方）
  const headBaseX = c
  const headBaseY = c - size * 0.18

  // 将hex颜色转为rgba
  const hexToRgba = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  const fillColor = hexToRgba(color, 0.15)
  const strokeColor = hexToRgba(color, 1.0)
  const bgRingColor = hexToRgba(color, 0.2)

  return (
    <div
      style={{
        width: size,
        height: size,
        margin: '0 auto',
        border: '2px dashed ' + hexToRgba(color, 0.3),
        borderRadius: 12,
        background: hexToRgba(color, 0.05),
      }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* 背景圆环 */}
        <circle
          cx={c} cy={c} r={size * 0.44}
          fill="none" stroke={bgRingColor} strokeWidth={2}
        />

        {/* 身体轮廓 - 静态参照 */}
        <g opacity={0.3}>
          <line
            x1={c - bodyW} y1={shoulderY}
            x2={c + bodyW} y2={shoulderY}
            stroke={strokeColor} strokeWidth={3} strokeLinecap="round"
          />
          <line
            x1={c} y1={shoulderY}
            x2={c} y2={shoulderY + size * 0.18}
            stroke={strokeColor} strokeWidth={3} strokeLinecap="round"
          />
        </g>

        {/* 动态头部 - 使用motion.g实现平滑动画 */}
        <AnimatedHead
          key={`head-${exerciseIndex}`}
          index={exerciseIndex}
          baseX={headBaseX}
          baseY={headBaseY}
          headR={headR}
          color={color}
          fillColor={fillColor}
          strokeColor={strokeColor}
        />

        {/* 方向指示箭头 */}
        <DirectionArrow key={`arrow-${exerciseIndex}`} index={exerciseIndex} c={c} size={size} color={color} />
      </svg>
    </div>
  )
}

// 动画头部组件
function AnimatedHead({ index, baseX, baseY, headR, color, fillColor, strokeColor }: {
  index: number
  baseX: number
  baseY: number
  headR: number
  color: string
  fillColor: string
  strokeColor: string
}) {
  const motionProps = getHeadMotion(index, baseX, baseY, headR)

  return (
    <motion.g
      initial={motionProps.initial}
      animate={motionProps.animate}
      transition={motionProps.transition}
    >
      {/* 头部圆形 */}
      <circle
        cx={0} cy={0} r={headR}
        fill={fillColor}
        stroke={strokeColor} strokeWidth={2.5}
      />
      {/* 面部中线 */}
      <line
        x1={0} y1={-headR * 0.45}
        x2={0} y2={headR * 0.25}
        stroke={strokeColor} strokeWidth={2} opacity={0.6}
      />
      {/* 左眼 */}
      <circle cx={-headR * 0.3} cy={-headR * 0.1} r={2.5} fill={strokeColor} opacity={0.7} />
      {/* 右眼 */}
      <circle cx={headR * 0.3} cy={-headR * 0.1} r={2.5} fill={strokeColor} opacity={0.7} />
      {/* 嘴巴 - 微笑弧线 */}
      <path
        d={`M ${-headR * 0.2} ${headR * 0.25} Q 0 ${headR * 0.4} ${headR * 0.2} ${headR * 0.25}`}
        fill="none" stroke={strokeColor} strokeWidth={1.5} opacity={0.5} strokeLinecap="round"
      />
    </motion.g>
  )
}

// 根据动作类型返回对应的运动参数
function getHeadMotion(index: number, baseX: number, baseY: number, headR: number) {
  const offset = headR * 0.6

  switch (index) {
    case 0: // 颈部左侧屈
      return {
        initial: { x: baseX, y: baseY },
        animate: { x: [baseX, baseX - offset, baseX], y: baseY },
        transition: { duration: 2, repeat: Infinity, ease: 'easeInOut' },
      }
    case 1: // 颈部右侧屈
      return {
        initial: { x: baseX, y: baseY },
        animate: { x: [baseX, baseX + offset, baseX], y: baseY },
        transition: { duration: 2, repeat: Infinity, ease: 'easeInOut' },
      }
    case 2: // 颈部左转
      return {
        initial: { x: baseX, y: baseY, rotate: 0 },
        animate: { x: baseX, y: baseY, rotate: [-18, 18, -18] },
        transition: { duration: 2.2, repeat: Infinity, ease: 'easeInOut' },
      }
    case 3: // 颈部右转
      return {
        initial: { x: baseX, y: baseY, rotate: 0 },
        animate: { x: baseX, y: baseY, rotate: [18, -18, 18] },
        transition: { duration: 2.2, repeat: Infinity, ease: 'easeInOut' },
      }
    case 4: // 肩部环绕
      return {
        initial: { x: baseX, y: baseY },
        animate: {
          x: [baseX, baseX + offset * 0.5, baseX - offset * 0.5, baseX],
          y: [baseY, baseY - offset * 0.3, baseY - offset * 0.3, baseY],
        },
        transition: { duration: 2.5, repeat: Infinity, ease: 'easeInOut' },
      }
    case 5: // 扩胸运动
      return {
        initial: { x: baseX, y: baseY, rotate: 0 },
        animate: {
          x: baseX,
          y: [baseY, baseY - offset * 0.5, baseY],
          rotate: [0, -8, 0],
        },
        transition: { duration: 2.4, repeat: Infinity, ease: 'easeInOut' },
      }
    case 6: // 头部后缩
      return {
        initial: { x: baseX, y: baseY },
        animate: { x: baseX, y: [baseY, baseY + offset * 0.4, baseY] },
        transition: { duration: 1.8, repeat: Infinity, ease: 'easeInOut' },
      }
    default:
      return {
        initial: { x: baseX, y: baseY },
        animate: { x: baseX, y: baseY },
        transition: { duration: 1 },
      }
  }
}

// 方向指示箭头
function DirectionArrow({ index, c, size, color }: {
  index: number
  c: number
  size: number
  color: string
}) {
  const r = size * 0.38

  // 将hex颜色转为rgba
  const hexToRgba = (hex: string, alpha: number) => {
    const r = parseInt(hex.slice(1, 3), 16)
    const g = parseInt(hex.slice(3, 5), 16)
    const b = parseInt(hex.slice(5, 7), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  const arrowColor = hexToRgba(color, 0.6)

  // 根据动作生成对应的箭头或弧线
  const renderArrow = () => {
    switch (index) {
      case 0: // 左屈 - 左箭头
        return (
          <g>
            <line x1={c - r - 6} y1={c - r * 0.2} x2={c - r + 8} y2={c - r * 0.2} stroke={arrowColor} strokeWidth={2} strokeLinecap="round" />
            <line x1={c - r - 6} y1={c - r * 0.2} x2={c - r + 2} y2={c - r * 0.2 - 5} stroke={arrowColor} strokeWidth={2} strokeLinecap="round" />
            <line x1={c - r - 6} y1={c - r * 0.2} x2={c - r + 2} y2={c - r * 0.2 + 5} stroke={arrowColor} strokeWidth={2} strokeLinecap="round" />
          </g>
        )
      case 1: // 右屈 - 右箭头
        return (
          <g>
            <line x1={c + r + 6} y1={c - r * 0.2} x2={c + r - 8} y2={c - r * 0.2} stroke={arrowColor} strokeWidth={2} strokeLinecap="round" />
            <line x1={c + r + 6} y1={c - r * 0.2} x2={c + r - 2} y2={c - r * 0.2 - 5} stroke={arrowColor} strokeWidth={2} strokeLinecap="round" />
            <line x1={c + r + 6} y1={c - r * 0.2} x2={c + r - 2} y2={c - r * 0.2 + 5} stroke={arrowColor} strokeWidth={2} strokeLinecap="round" />
          </g>
        )
      case 2: // 左转 - 逆时针弧线箭头
        return <ArcArrow c={c} r={r * 0.7} startAngle={30} endAngle={150} color={arrowColor} direction="ccw" />
      case 3: // 右转 - 顺时针弧线箭头
        return <ArcArrow c={c} r={r * 0.7} startAngle={150} endAngle={30} color={arrowColor} direction="cw" />
      case 4: // 环绕 - 圆形虚线
        return (
          <circle
            cx={c} cy={c - r * 0.1} r={r * 0.5}
            fill="none" stroke={arrowColor} strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        )
      case 5: // 扩胸 - 向上箭头
        return (
          <g>
            <line x1={c} y1={c - r - 4} x2={c} y2={c - r + 10} stroke={arrowColor} strokeWidth={2} strokeLinecap="round" />
            <line x1={c} y1={c - r - 4} x2={c - 5} y2={c - r + 4} stroke={arrowColor} strokeWidth={2} strokeLinecap="round" />
            <line x1={c} y1={c - r - 4} x2={c + 5} y2={c - r + 4} stroke={arrowColor} strokeWidth={2} strokeLinecap="round" />
          </g>
        )
      case 6: // 后缩 - 向下箭头
        return (
          <g>
            <line x1={c} y1={c + r * 0.3 + 8} x2={c} y2={c + r * 0.3 - 6} stroke={arrowColor} strokeWidth={2} strokeLinecap="round" />
            <line x1={c} y1={c + r * 0.3 + 8} x2={c - 5} y2={c + r * 0.3 + 2} stroke={arrowColor} strokeWidth={2} strokeLinecap="round" />
            <line x1={c} y1={c + r * 0.3 + 8} x2={c + 5} y2={c + r * 0.3 + 2} stroke={arrowColor} strokeWidth={2} strokeLinecap="round" />
          </g>
        )
      default:
        return null
    }
  }

  return (
    <motion.g
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, delay: 0.2 }}
    >
      {renderArrow()}
    </motion.g>
  )
}

// 弧线箭头组件
function ArcArrow({ c, r, startAngle, endAngle, color, direction }: {
  c: number
  r: number
  startAngle: number
  endAngle: number
  color: string
  direction: 'cw' | 'ccw'
}) {
  const start = polarToCartesian(c, c - r * 0.1, r, startAngle)
  const end = polarToCartesian(c, c - r * 0.1, r, endAngle)
  const largeArc = Math.abs(endAngle - startAngle) > 180 ? 1 : 0
  const sweep = direction === 'cw' ? 1 : 0

  // 箭头方向计算
  const arrowAngle = direction === 'cw' ? endAngle - 15 : endAngle + 15
  const arrowTip = polarToCartesian(c, c - r * 0.1, r + 6, endAngle)
  const arrowLeft = polarToCartesian(c, c - r * 0.1, r - 2, arrowAngle - 8)
  const arrowRight = polarToCartesian(c, c - r * 0.1, r - 2, arrowAngle + 8)

  return (
    <g>
      <path
        d={`M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArc} ${sweep} ${end.x} ${end.y}`}
        fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round"
      />
      <line x1={arrowTip.x} y1={arrowTip.y} x2={arrowLeft.x} y2={arrowLeft.y} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
      <line x1={arrowTip.x} y1={arrowTip.y} x2={arrowRight.x} y2={arrowRight.y} stroke={color} strokeWidth={1.5} strokeLinecap="round" />
    </g>
  )
}

function polarToCartesian(cx: number, cy: number, r: number, angle: number) {
  const rad = (angle * Math.PI) / 180
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) }
}
