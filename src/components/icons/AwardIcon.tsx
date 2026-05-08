import { Award } from 'lucide-react'

interface AwardIconProps {
  size?: number
  color?: string
  className?: string
}

export default function AwardIcon({ size = 24, color = 'currentColor', className = '' }: AwardIconProps) {
  return <Award size={size} color={color} className={className} />
}