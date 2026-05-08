import { Eye } from 'lucide-react'

interface EyeIconProps {
  size?: number
  color?: string
  className?: string
}

export default function EyeIcon({ size = 24, color = 'currentColor', className = '' }: EyeIconProps) {
  return <Eye size={size} color={color} className={className} />
}