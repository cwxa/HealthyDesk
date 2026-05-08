import { RotateCcw } from 'lucide-react'

interface RotateCcwIconProps {
  size?: number
  color?: string
  className?: string
}

export default function RotateCcwIcon({ size = 24, color = 'currentColor', className = '' }: RotateCcwIconProps) {
  return <RotateCcw size={size} color={color} className={className} />
}