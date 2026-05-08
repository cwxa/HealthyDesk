import { Calendar } from 'lucide-react'

interface CalendarIconProps {
  size?: number
  color?: string
  className?: string
}

export default function CalendarIcon({ size = 24, color = 'currentColor', className = '' }: CalendarIconProps) {
  return <Calendar size={size} color={color} className={className} />
}