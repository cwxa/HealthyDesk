interface ShoulderIconProps {
  size?: number
  color?: string
  className?: string
}

export default function ShoulderIcon({ size = 24, color = '#2196F3', className = '' }: ShoulderIconProps) {
  const strokeWidth = 2
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <line x1="4" y1="12" x2="20" y2="12" stroke={color} strokeWidth={strokeWidth} />
      <line x1="4" y1="12" x2="8" y2="18" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <line x1="20" y1="12" x2="16" y2="18" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </svg>
  )
}