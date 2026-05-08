import { SkipForward } from 'lucide-react'

interface SkipIconProps {
  size?: number
  color?: string
  className?: string
}

export default function SkipIcon({ size = 24, color = 'currentColor', className = '' }: SkipIconProps) {
  return <SkipForward size={size} color={color} className={className} />
}