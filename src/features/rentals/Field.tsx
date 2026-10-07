import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label className="text-sm font-medium text-text-secondary">{label}</label>
      {children}
    </div>
  )
}
