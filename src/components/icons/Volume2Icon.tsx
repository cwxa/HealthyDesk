import { Volume2 } from 'lucide-react'

interface Volume2IconProps {
  size?: number
  color?: string
  className?: string
}

export default function Volume2Icon({ size = 24, color = 'currentColor', className = '' }: Volume2IconProps) {
  return <Volume2 size={size} color={color} className={className} />
}