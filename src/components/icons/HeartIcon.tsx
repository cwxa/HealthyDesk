import { Heart } from 'lucide-react'

interface HeartIconProps {
  size?: number
  color?: string
  className?: string
}

export default function HeartIcon({ size = 24, color = 'currentColor', className = '' }: HeartIconProps) {
  return <Heart size={size} color={color} className={className} />
}