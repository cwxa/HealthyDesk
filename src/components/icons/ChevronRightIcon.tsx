import { ChevronRight } from 'lucide-react'

interface ChevronRightIconProps {
  size?: number
  color?: string
  className?: string
}

export default function ChevronRightIcon({ size = 24, color = 'currentColor', className = '' }: ChevronRightIconProps) {
  return <ChevronRight size={size} color={color} className={className} />
}