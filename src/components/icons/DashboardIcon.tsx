import { LayoutDashboard } from 'lucide-react'

interface DashboardIconProps {
  size?: number
  color?: string
  className?: string
}

export default function DashboardIcon({ size = 24, color = 'currentColor', className = '' }: DashboardIconProps) {
  return <LayoutDashboard size={size} color={color} className={className} />
}