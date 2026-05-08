import { X } from 'lucide-react'

interface XIconProps {
  size?: number
  color?: string
  className?: string
}

export default function XIcon({ size = 24, color = 'currentColor', className = '' }: XIconProps) {
  return <X size={size} color={color} className={className} />
}