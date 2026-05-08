import { Monitor } from 'lucide-react'

interface MonitorIconProps {
  size?: number
  color?: string
  className?: string
}

export default function MonitorIcon({ size = 24, color = 'currentColor', className = '' }: MonitorIconProps) {
  return <Monitor size={size} color={color} className={className} />
}