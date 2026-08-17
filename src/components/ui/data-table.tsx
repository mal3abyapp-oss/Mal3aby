import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'

// Simple, bounded table — no client-side fetching-all-rows pattern.
// Callers are responsible for passing already-paginated `rows`, per
// docs/ARCHITECTURE.md#performance-principles (no unbounded lists).
export interface DataTableColumn<T> {
  key: string
  header: string
  // index/rows are optional, additive params (PlatformOwnersPage needs
  // them to detect "first row of this owner" for grouped-row rendering)
  // -- every existing single-arg render callback stays valid as-is.
  render: (row: T, index: number, rows: T[]) => ReactNode
  className?: string
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  isLoading?: boolean
  emptyTitle?: string
  emptyDescription?: string
  className?: string
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  isLoading,
  emptyTitle = 'لا توجد بيانات',
  emptyDescription,
  className,
}: DataTableProps<T>) {
  if (isLoading) {
    return (
      <div className={cn('space-y-2', className)}>
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} description={emptyDescription} />
  }

  return (
    <div className={cn('w-full overflow-x-auto rounded-md border border-border', className)}>
      {/* min-w-max + whitespace-nowrap on cells: on a narrow viewport,
          without this the browser shrinks/wraps each cell to fit instead
          of triggering this container's own overflow-x-auto, producing
          multi-line wrapped cells (e.g. a long invoice number breaking
          across 4 lines) instead of a clean horizontal scroll -- found
          during the stabilization pass's mobile responsive check. */}
      <table className="w-full min-w-max text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-start">
            {columns.map((col) => (
              <th
                key={col.key}
                className={cn('whitespace-nowrap px-3 py-2 text-start font-medium text-text-secondary', col.className)}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={rowKey(row)} className="border-b border-border last:border-0 hover:bg-muted/30">
              {columns.map((col) => (
                <td key={col.key} className={cn('whitespace-nowrap px-3 py-2', col.className)}>
                  {col.render(row, index, rows)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
