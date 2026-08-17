import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { Card, CardContent } from '@/components/ui/card'
import type { LucideIcon } from 'lucide-react'

// Dashboard KPI card — see docs/DESIGN_SYSTEM.md#dashboard-hierarchy.
// Used for Level 1/2 dashboard tiles; not a decorative element.
//
// Master IA/UX audit (Reports decomposition phase): confirmed every
// StatCard usage across Reports/Dashboard/Platform Overview was a
// dead-end number -- this component never had an onClick/href prop at
// all. Added an optional `to` (drill-down route) -- when present the
// whole card becomes a Link with a hover affordance; omitted, it
// renders exactly as before (no visual/behavioral change for callers
// that don't pass it, so no other call site needed to change).
export interface StatCardProps {
  label: string
  value: string | number
  icon?: LucideIcon
  tone?: 'default' | 'danger' | 'success' | 'warning'
  className?: string
  to?: string
}

const toneClass = {
  default: 'text-text-primary',
  danger: 'text-status-danger',
  success: 'text-status-success',
  warning: 'text-status-warning',
} as const

export function StatCard({ label, value, icon: Icon, tone = 'default', className, to }: StatCardProps) {
  const content = (
    <CardContent className="flex items-center justify-between gap-3 p-0">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-text-secondary">{label}</p>
        {/* Owner-level review finding (P2, RTL): a composite numeric
            value like "0 / 4" has no defined Unicode bidi direction
            of its own -- inside an RTL page it can render with the
            two numbers visually swapped ("4 / 0") even though the
            DOM text and underlying data are correct, exactly what
            was found live on TodayPage's "الملاعب المشغولة الآن"
            tile. <bdi> is the correct HTML element for isolating
            directionally-ambiguous embedded content from its
            surrounding text -- fixes every StatCard value at once
            rather than patching each call site with composite
            values individually. */}
        <p className={cn('mt-1 break-words text-2xl font-bold tabular-nums', toneClass[tone])}>
          <bdi>{value}</bdi>
        </p>
      </div>
      {Icon && <Icon className="size-8 shrink-0 text-text-secondary/50" aria-hidden="true" />}
    </CardContent>
  )

  if (to) {
    return (
      <Link to={to}>
        <Card className={cn('p-4 transition hover:border-accent-foreground/40 hover:bg-muted/40', className)}>
          {content}
        </Card>
      </Link>
    )
  }

  return (
    <Card className={cn('p-4', className)}>
      {content}
    </Card>
  )
}
