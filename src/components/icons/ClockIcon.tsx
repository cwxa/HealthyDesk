import { Clock } from 'lucide-react'

interface ClockIconProps {
  size?: number
  color?: string
  className?: string
}

export default function ClockIcon({ size = 24, color = 'currentColor', className = '' }: ClockIconProps) {
  return <Clock size={size} color={color} className={className} />
}