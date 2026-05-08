import { Check } from 'lucide-react'

interface CheckIconProps {
  size?: number
  color?: string
  className?: string
}

export default function CheckIcon({ size = 24, color = 'currentColor', className = '' }: CheckIconProps) {
  return <Check size={size} color={color} className={className} />
}