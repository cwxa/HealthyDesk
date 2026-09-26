import { motion } from 'framer-motion'
import type { Exercise, GuideArrow, GuideMotion } from '../data/exercises'

interface Props {
  /** 要演示的动作。引导完全由它的 `guide` 参数决定 —— 组件里不再认识任何具体动作。 */
  exercise: Exercise
  size?: number
}

/**
 * 肩颈活动动画引导（SVG + Framer Motion）。
 *
 * 🔴 **这个组件不认识任何具体动作**：头部运动由 `exercise.guide.motion` 的关键帧算出，
 * 方向箭头由 `exercise.guide.arrow` 选图元。此前这里是两个按**下标** `switch` 的函数
 * （`getHeadMotion` / `DirectionArrow`），加一个动作必须回来加 `case` ——
 * S7 把它们改成了「数据选参数、组件会画图」。
 *
 * ⚠️ 搬家时**逐参数保真**：`StraightArrow` 里的坐标含少量绝对像素（如 `-6` / `+8`），
 * 与尺寸不成比例，是改造前就有的写法。这里刻意**原样保留**，因为 S7 的硬约束是
 * 「重构不改行为」；要调视觉应在 S8 里单独做并重新核对。等价性由
 * `scripts/verify-exercises.mjs` 的参数快照断言（`cycleSec` / 关键帧 / 图元分配）。
 */
export default function ExerciseGuide({ exercise, size = 160 }: Props) {
  const color = exercise.color
  const c = size / 2
  const headR = size * 0.16
  const bodyW = size * 0.22
  const shoulderY = c + size * 0.05

  // 头部基础位置（颈部上方）
  const headBaseX = c
  const headBaseY = c - size * 0.18

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

        {/* 动态头部 - 使用motion.g实现平滑动画
            key 用 id 而不是下标：换动作时强制重挂载，让动画从头开始（与改造前同义）。 */}
        <AnimatedHead
          key={`head-${exercise.id}`}
          motionSpec={exercise.guide.motion}
          baseX={headBaseX}
          baseY={headBaseY}
          headR={headR}
          fillColor={fillColor}
          strokeColor={strokeColor}
        />

        {/* 方向指示箭头 */}
        <DirectionArrow key={`arrow-${exercise.id}`} arrow={exercise.guide.arrow} c={c} size={size} color={color} />
      </svg>
    </div>
  )
}

type HeadMotionProps = {
  initial: { x: number; y: number; rotate?: number }
  animate: { x: number | number[]; y: number | number[]; rotate?: number[] }
  transition: { duration: number; repeat: number; ease: 'easeInOut' }
}

/**
 * 把数据的**无量纲关键帧**换算成画布坐标。
 *
 * 关键帧单位是 `offset = headR * 0.6`：`0` = 基准位、`±k` = 偏移 k 个 offset。
 * 长度为 1 的关键帧输出**标量**（而不是单元素数组）—— 与改造前逐条手写的写法一致，
 * `animate` 里「标量 = 不动」和「数组 = 来回动」是两种不同的动画语义。
 */
function buildHeadMotion(spec: GuideMotion, baseX: number, baseY: number, headR: number): HeadMotionProps {
  const offset = headR * 0.6
  const axis = (frames: readonly number[], base: number) =>
    frames.length === 1 ? base + frames[0] * offset : frames.map((k) => base + k * offset)

  const initial: HeadMotionProps['initial'] = { x: baseX, y: baseY }
  if (spec.rotate) initial.rotate = 0

  const animate: HeadMotionProps['animate'] = {
    x: axis(spec.x, baseX),
    y: axis(spec.y, baseY),
  }
  if (spec.rotate) animate.rotate = [...spec.rotate]

  return { initial, animate, transition: { duration: spec.cycleSec, repeat: Infinity, ease: 'easeInOut' } }
}

// 动画头部组件
// ⚠️ prop 名**不能**叫 `motion`：那会遮蔽 framer-motion 的 `motion`，
//   于是 `<motion.g>` 会被当成"读取 prop 上的 g 属性"而报 TS2339（实测踩到）。
function AnimatedHead({ motionSpec, baseX, baseY, headR, fillColor, strokeColor }: {
  motionSpec: GuideMotion
  baseX: number
  baseY: number
  headR: number
  fillColor: string
  strokeColor: string
}) {
  const motionProps = buildHeadMotion(motionSpec, baseX, baseY, headR)

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

// 方向指示箭头：按数据选中的**图元**分发（不再是按动作下标）
function DirectionArrow({ arrow, c, size, color }: {
  arrow: GuideArrow
  c: number
  size: number
  color: string
}) {
  const r = size * 0.38
  const arrowColor = hexToRgba(color, 0.6)

  const renderArrow = () => {
    switch (arrow.kind) {
      case 'straight':
        return <StraightArrow dir={arrow.dir} c={c} r={r} color={arrowColor} />
      case 'arc':
        return (
          <ArcArrow
            c={c} r={r * 0.7}
            startAngle={arrow.from} endAngle={arrow.to}
            color={arrowColor} direction={arrow.dir}
          />
        )
      case 'ring':
        return (
          <circle
            cx={c} cy={c - r * 0.1} r={r * 0.5}
            fill="none" stroke={arrowColor} strokeWidth={1.5}
            strokeDasharray="4 3"
          />
        )
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

/**
 * 直线箭头（左 / 右 / 上 / 下）。
 *
 * 🔴 坐标**原样**取自改造前 `DirectionArrow` 的 4 个 `case`，含绝对像素常量：
 * 左右箭头在 `c ± r ± 6`、上下箭头在 `c ∓ r ∓ 4`，横向基准分别取 `c - r*0.2`（左右）
 * 与 `c`（上下），向下箭头的半径是 `r * 0.3`。这些不一致是历史写法，
 * 搬家时**保真优先**（S7 不改行为），要统一到 S8 再说。
 */
function StraightArrow({ dir, c, r, color }: {
  dir: 'left' | 'right' | 'up' | 'down'
  c: number
  r: number
  color: string
}) {
  const head = 5 // 箭头两撇的张口半径（像素）

  switch (dir) {
    case 'left': {
      const y = c - r * 0.2
      return (
        <g>
          <line x1={c - r - 6} y1={y} x2={c - r + 8} y2={y} stroke={color} strokeWidth={2} strokeLinecap="round" />
          <line x1={c - r - 6} y1={y} x2={c - r + 2} y2={y - head} stroke={color} strokeWidth={2} strokeLinecap="round" />
          <line x1={c - r - 6} y1={y} x2={c - r + 2} y2={y + head} stroke={color} strokeWidth={2} strokeLinecap="round" />
        </g>
      )
    }
    case 'right': {
      const y = c - r * 0.2
      return (
        <g>
          <line x1={c + r + 6} y1={y} x2={c + r - 8} y2={y} stroke={color} strokeWidth={2} strokeLinecap="round" />
          <line x1={c + r + 6} y1={y} x2={c + r - 2} y2={y - head} stroke={color} strokeWidth={2} strokeLinecap="round" />
          <line x1={c + r + 6} y1={y} x2={c + r - 2} y2={y + head} stroke={color} strokeWidth={2} strokeLinecap="round" />
        </g>
      )
    }
    case 'up': {
      const tip = c - r - 4
      return (
        <g>
          <line x1={c} y1={tip} x2={c} y2={c - r + 10} stroke={color} strokeWidth={2} strokeLinecap="round" />
          <line x1={c} y1={tip} x2={c - head} y2={c - r + 4} stroke={color} strokeWidth={2} strokeLinecap="round" />
          <line x1={c} y1={tip} x2={c + head} y2={c - r + 4} stroke={color} strokeWidth={2} strokeLinecap="round" />
        </g>
      )
    }
    case 'down': {
      const tip = c + r * 0.3 + 8
      return (
        <g>
          <line x1={c} y1={tip} x2={c} y2={c + r * 0.3 - 6} stroke={color} strokeWidth={2} strokeLinecap="round" />
          <line x1={c} y1={tip} x2={c - head} y2={c + r * 0.3 + 2} stroke={color} strokeWidth={2} strokeLinecap="round" />
          <line x1={c} y1={tip} x2={c + head} y2={c + r * 0.3 + 2} stroke={color} strokeWidth={2} strokeLinecap="round" />
        </g>
      )
    }
  }
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

/** 将hex颜色转为rgba（原先在组件里定义了两份，这里合一）。 */
function hexToRgba(hex: string, alpha: number) {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
