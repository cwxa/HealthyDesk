import { Zap } from 'lucide-react'

interface ZapIconProps {
  size?: number
  color?: string
  className?: string
}

export default function ZapIcon({ size = 24, color = 'currentColor', className = '' }: ZapIconProps) {
  return <Zap size={size} color={color} className={className} />
}