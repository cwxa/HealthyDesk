import { Plus } from 'lucide-react'

interface PlusIconProps {
  size?: number
  color?: string
  className?: string
}

export default function PlusIcon({ size = 24, color = 'currentColor', className = '' }: PlusIconProps) {
  return <Plus size={size} color={color} className={className} />
}