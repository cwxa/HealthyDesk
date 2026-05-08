import { Circle } from 'lucide-react'

interface SpineIconProps {
  size?: number
  color?: string
  className?: string
}

export default function SpineIcon({ size = 24, color = '#FF9800', className = '' }: SpineIconProps) {
  const strokeWidth = 2
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className}>
      <Circle cx="12" cy="4" r="2" stroke={color} strokeWidth={strokeWidth} />
      <line x1="12" y1="6" x2="12" y2="8" stroke={color} strokeWidth={strokeWidth} />
      <Circle cx="12" cy="10" r="2" stroke={color} strokeWidth={strokeWidth} />
      <line x1="12" y1="12" x2="12" y2="14" stroke={color} strokeWidth={strokeWidth} />
      <Circle cx="12" cy="16" r="2" stroke={color} strokeWidth={strokeWidth} />
      <line x1="12" y1="18" x2="12" y2="20" stroke={color} strokeWidth={strokeWidth} />
    </svg>
  )
}