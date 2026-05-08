import { Activity } from 'lucide-react'

interface ActivityIconProps {
  size?: number
  color?: string
  className?: string
}

export default function ActivityIcon({ size = 24, color = 'currentColor', className = '' }: ActivityIconProps) {
  return <Activity size={size} color={color} className={className} />
}