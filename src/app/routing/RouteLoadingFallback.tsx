import { Skeleton } from '@/components/ui/skeleton'

// Controlled-scale readiness SP-004: shown briefly while a lazy-loaded
// route chunk downloads (see router.tsx). Route chunks are small
// (typically well under 100kB gzipped) and usually already cached after
// first visit, so this is a sub-second flash on a fast connection, not a
// full loading screen -- deliberately minimal rather than a fully
// decorated skeleton of the destination page, since we don't know what
// that page looks like generically.
export function RouteLoadingFallback() {
  return (
    <div className="flex flex-col gap-3 p-4">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-32 w-full" />
    </div>
  )
}
