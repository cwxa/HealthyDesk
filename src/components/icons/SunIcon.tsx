import { Sun } from 'lucide-react'

interface SunIconProps {
  size?: number
  color?: string
  className?: string
}

export default function SunIcon({ size = 24, color = 'currentColor', className = '' }: SunIconProps) {
  return <Sun size={size} color={color} className={className} />
}