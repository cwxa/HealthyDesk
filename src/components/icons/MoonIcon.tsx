import { Moon } from 'lucide-react'

interface MoonIconProps {
  size?: number
  color?: string
  className?: string
}

export default function MoonIcon({ size = 24, color = 'currentColor', className = '' }: MoonIconProps) {
  return <Moon size={size} color={color} className={className} />
}