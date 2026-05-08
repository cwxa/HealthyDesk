import { Minus } from 'lucide-react'

interface MinusIconProps {
  size?: number
  color?: string
  className?: string
}

export default function MinusIcon({ size = 24, color = 'currentColor', className = '' }: MinusIconProps) {
  return <Minus size={size} color={color} className={className} />
}