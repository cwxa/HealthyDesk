import { BarChart2 } from 'lucide-react'

interface BarChart2IconProps {
  size?: number
  color?: string
  className?: string
}

export default function BarChart2Icon({ size = 24, color = 'currentColor', className = '' }: BarChart2IconProps) {
  return <BarChart2 size={size} color={color} className={className} />
}