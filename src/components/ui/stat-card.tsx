import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import type { LucideIcon } from 'lucide-react'

// Dashboard KPI card — see docs/DESIGN_SYSTEM.md#dashboard-hierarchy.
// Used for Level 1/2 dashboard tiles; not a decorative element.
export interface StatCardProps {
  label: string
  value: string | number
  icon?: LucideIcon
  tone?: 'default' | 'danger' | 'success' | 'warning'
  className?: string
}

const toneClass = {
  default: 'text-text-primary',
  danger: 'text-status-danger',
  success: 'text-status-success',
  warning: 'text-status-warning',
} as const

export function StatCard({ label, value, icon: Icon, tone = 'default', className }: StatCardProps) {
  return (
    <Card className={cn('p-4', className)}>
      <CardContent className="flex items-center justify-between gap-3 p-0">
        <div>
          <p className="text-sm text-text-secondary">{label}</p>
          <p className={cn('mt-1 text-2xl font-bold tabular-nums', toneClass[tone])}>{value}</p>
        </div>
        {Icon && <Icon className="size-8 shrink-0 text-text-secondary/50" aria-hidden="true" />}
      </CardContent>
    </Card>
  )
}
