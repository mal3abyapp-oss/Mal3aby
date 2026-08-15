import { cn } from '@/lib/utils'
import { CheckCircle2, Clock, XCircle, Info, Circle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Semantic status system — see docs/DESIGN_SYSTEM.md. Status is never
// color-only: every badge pairs color + icon + text label.
export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

const toneConfig: Record<StatusTone, { icon: LucideIcon; className: string }> = {
  success: { icon: CheckCircle2, className: 'bg-status-success/10 text-status-success border-status-success/20' },
  warning: { icon: Clock, className: 'bg-status-warning/10 text-status-warning border-status-warning/20' },
  danger: { icon: XCircle, className: 'bg-status-danger/10 text-status-danger border-status-danger/20' },
  info: { icon: Info, className: 'bg-status-info/10 text-status-info border-status-info/20' },
  neutral: { icon: Circle, className: 'bg-status-neutral/10 text-status-neutral border-status-neutral/20' },
}

export interface StatusBadgeProps {
  tone: StatusTone
  label: string
  className?: string
}

export function StatusBadge({ tone, label, className }: StatusBadgeProps) {
  const { icon: Icon, className: toneClassName } = toneConfig[tone]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium',
        toneClassName,
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  )
}
