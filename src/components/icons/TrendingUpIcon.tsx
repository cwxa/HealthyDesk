import { TrendingUp } from 'lucide-react'

interface TrendingUpIconProps {
  size?: number
  color?: string
  className?: string
}

export default function TrendingUpIcon({ size = 24, color = 'currentColor', className = '' }: TrendingUpIconProps) {
  return <TrendingUp size={size} color={color} className={className} />
}