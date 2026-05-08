import { Timer } from 'lucide-react'

interface TimerIconProps {
  size?: number
  color?: string
  className?: string
}

export default function TimerIcon({ size = 24, color = 'currentColor', className = '' }: TimerIconProps) {
  return <Timer size={size} color={color} className={className} />
}