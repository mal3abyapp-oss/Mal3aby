import { Skeleton } from '@/components/ui/skeleton'

// FULL-PLATFORM AUDIT FIX (2026-09-14, loading-state-consistency
// finding): every core Platform Owner screen that lists data
// (Reports, Audit, Clubs, Trials, Support History) delegates to
// DataTable, which renders real Skeleton bars while loading. The
// entire Sales Intelligence module instead rendered a bare "جارٍ
// التحميل..." paragraph with no shape at all -- an inconsistent,
// lower-fidelity loading experience within the same console. This is
// the one shared skeleton shape all of Sales Intelligence's list-style
// panels now use (a small stack of bars roughly matching a few list
// rows) rather than 13 separate ad hoc fixes.
export function ListLoadingSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  )
}
