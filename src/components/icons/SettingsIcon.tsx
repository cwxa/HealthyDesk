import { Settings } from 'lucide-react'

interface SettingsIconProps {
  size?: number
  color?: string
  className?: string
}

export default function SettingsIcon({ size = 24, color = 'currentColor', className = '' }: SettingsIconProps) {
  return <Settings size={size} color={color} className={className} />
}