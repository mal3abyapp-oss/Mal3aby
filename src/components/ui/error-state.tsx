import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// Human-readable error states only — never raw DB/Postgres/HTTP errors
// shown to the user. See docs/DESIGN_SYSTEM.md#empty--error-states and
// docs/SECURITY_ANTI_FRAUD.md (error handling never leaks internals).
// Raw error detail belongs in development console logging only.
export interface ErrorStateProps {
  message?: string
  onRetry?: () => void
  className?: string
}

export function ErrorState({ message = 'حدث خطأ، حاول مرة أخرى', onRetry, className }: ErrorStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-3 py-12 text-center', className)}>
      <AlertTriangle className="size-10 text-status-danger" aria-hidden="true" />
      <p className="font-medium text-text-primary">{message}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          إعادة المحاولة
        </Button>
      )}
    </div>
  )
}
