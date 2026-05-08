import { Target } from 'lucide-react'

interface TargetIconProps {
  size?: number
  color?: string
  className?: string
}

export default function TargetIcon({ size = 24, color = 'currentColor', className = '' }: TargetIconProps) {
  return <Target size={size} color={color} className={className} />
}