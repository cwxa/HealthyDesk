import { EyeOff } from 'lucide-react'

interface EyeOffIconProps {
  size?: number
  color?: string
  className?: string
}

export default function EyeOffIcon({ size = 24, color = 'currentColor', className = '' }: EyeOffIconProps) {
  return <EyeOff size={size} color={color} className={className} />
}