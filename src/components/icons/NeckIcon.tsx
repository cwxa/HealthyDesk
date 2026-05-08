import { Circle } from 'lucide-react'

interface NeckIconProps {
  size?: number
  color?: string
  className?: string
}

export default function NeckIcon({ size = 24, color = '#4CAF50', className = '' }: NeckIconProps) {
  const strokeWidth = 2
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <Circle cx="12" cy="6" r="3" stroke={color} strokeWidth={strokeWidth} />
      <line x1="12" y1="9" x2="12" y2="18" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Circle cx="6" cy="20" r="2" stroke={color} strokeWidth={strokeWidth} />
      <Circle cx="18" cy="20" r="2" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  )
}