import { Play } from 'lucide-react'

interface PlayIconProps {
  size?: number
  color?: string
  className?: string
}

export default function PlayIcon({ size = 24, color = 'currentColor', className = '' }: PlayIconProps) {
  return <Play size={size} color={color} className={className} />
}