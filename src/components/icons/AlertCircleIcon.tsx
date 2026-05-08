import { AlertCircle } from 'lucide-react'

interface AlertCircleIconProps {
  size?: number
  color?: string
  className?: string
}

export default function AlertCircleIcon({ size = 24, color = 'currentColor', className = '' }: AlertCircleIconProps) {
  return <AlertCircle size={size} color={color} className={className} />
}