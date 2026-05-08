import { ChevronLeft } from 'lucide-react'

interface ChevronLeftIconProps {
  size?: number
  color?: string
  className?: string
}

export default function ChevronLeftIcon({ size = 24, color = 'currentColor', className = '' }: ChevronLeftIconProps) {
  return <ChevronLeft size={size} color={color} className={className} />
}