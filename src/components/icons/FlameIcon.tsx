import { Flame } from 'lucide-react'

interface FlameIconProps {
  size?: number
  color?: string
  className?: string
}

export default function FlameIcon({ size = 24, color = 'currentColor', className = '' }: FlameIconProps) {
  return <Flame size={size} color={color} className={className} />
}