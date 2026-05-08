import { VolumeX } from 'lucide-react'

interface VolumeXIconProps {
  size?: number
  color?: string
  className?: string
}

export default function VolumeXIcon({ size = 24, color = 'currentColor', className = '' }: VolumeXIconProps) {
  return <VolumeX size={size} color={color} className={className} />
}