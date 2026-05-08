import { Pause } from 'lucide-react'

interface PauseIconProps {
  size?: number
  color?: string
  className?: string
}

export default function PauseIcon({ size = 24, color = 'currentColor', className = '' }: PauseIconProps) {
  return <Pause size={size} color={color} className={className} />
}