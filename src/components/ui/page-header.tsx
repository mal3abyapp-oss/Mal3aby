import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface PageHeaderProps {
  title: string
  // RTL sweep finding: widened from `string` to `ReactNode` so callers
  // rendering a Latin-only value here (e.g. a club code) can wrap it in
  // <bdi> -- a plain string forced every caller into either skipping
  // isolation or pre-formatting a JSX-in-string hack. Every existing
  // plain-string caller stays valid unchanged.
  description?: ReactNode
  actions?: ReactNode
  className?: string
}

export function PageHeader({ title, description, actions, className }: PageHeaderProps) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 pb-4', className)}>
      <div>
        <h1 className="text-xl font-bold text-text-primary">{title}</h1>
        {description && <p className="mt-1 text-sm text-text-secondary">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}
