import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
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
  // Mobile card mode only (see `variant` below). A column with
  // `cardPriority: 'primary'` becomes the card's title line; everything
  // else renders as a label/value row inside the card body, in column
  // order, UNLESS `hideOnCard` is set -- for columns that are redundant
  // or too dense for a narrow card (e.g. a "quick actions" icon button
  // column that's better placed once, big, at the card's own action
  // row via `renderCardActions` instead of repeated per-field). Purely
  // additive: omitted on every existing caller, so nothing about the
  // classic table rendering below changes for them.
  cardPriority?: 'primary' | 'secondary'
  hideOnCard?: boolean
  // Override how this column's value reads inside a mobile card (e.g.
  // drop a redundant repeated label). Falls back to `header` + render().
  cardLabel?: string
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  isLoading?: boolean
  emptyTitle?: string
  emptyDescription?: string
  className?: string
  // Opt-in, systemic responsive mode (design-remediation/premium-ui-ux-audit
  // mobile brief): 'table' (default, unchanged) always renders the
  // classic overflow-x-auto table -- every existing caller (Booking,
  // Finance, Staff, Platform, etc.) keeps its exact current behavior
  // with zero changes required. 'cards-on-mobile' additionally renders
  // a card-per-row layout, shown only below the `sm` breakpoint (pure
  // CSS via Tailwind's `hidden sm:block` / `sm:hidden` -- no JS
  // viewport detection, so no hydration/SSR mismatch and nothing to
  // recompute on resize); the table itself still renders at `sm:` and
  // above, unchanged. This replaces forced horizontal scroll on narrow
  // viewports with a readable stacked card while preserving every
  // existing column's data/behavior -- presentation only, per the
  // brief's "preserve all existing data/columns/actions" constraint.
  variant?: 'table' | 'cards-on-mobile'
  // Optional trailing actions rendered once per card (e.g. a single
  // "quick actions" button) instead of repeating an actions column as a
  // label/value row. Ignored in 'table' variant.
  renderCardActions?: (row: T, index: number, rows: T[]) => ReactNode
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  isLoading,
  emptyTitle,
  emptyDescription,
  className,
  variant = 'table',
  renderCardActions,
}: DataTableProps<T>) {
  const { t } = useTranslation()
  const resolvedEmptyTitle = emptyTitle ?? t('common.noData')
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
    return <EmptyState title={resolvedEmptyTitle} description={emptyDescription} />
  }

  const isResponsiveCards = variant === 'cards-on-mobile'

  return (
    <div className={cn('w-full', className)}>
      {isResponsiveCards && (
        <DataTableCardList
          columns={columns}
          rows={rows}
          rowKey={rowKey}
          renderCardActions={renderCardActions}
        />
      )}

      <div
        className={cn(
          'w-full overflow-x-auto rounded-md border border-border',
          // Below `sm`, the card list above takes over; at `sm:` and up
          // the classic table returns exactly as before.
          isResponsiveCards && 'hidden sm:block',
        )}
      >
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
    </div>
  )
}

// Card-per-row rendering for narrow viewports. Kept as a separate
// component (rather than inlined) so its own layout logic doesn't
// complicate the always-safe classic-table branch above.
function DataTableCardList<T>({
  columns,
  rows,
  rowKey,
  renderCardActions,
}: {
  columns: DataTableColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string
  renderCardActions?: (row: T, index: number, rows: T[]) => ReactNode
}) {
  const primaryCol = columns.find((c) => c.cardPriority === 'primary') ?? columns[0]
  const bodyCols = columns.filter((c) => c !== primaryCol && !c.hideOnCard)

  return (
    <div className="flex flex-col gap-2 sm:hidden">
      {rows.map((row, index) => (
        <div
          key={rowKey(row)}
          className="rounded-md border border-border bg-surface p-3 text-sm"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1 font-medium text-text-primary">
              {primaryCol?.render(row, index, rows)}
            </div>
            {renderCardActions && (
              <div className="shrink-0">{renderCardActions(row, index, rows)}</div>
            )}
          </div>

          {bodyCols.length > 0 && (
            <dl className="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
              {bodyCols.map((col) => (
                <div key={col.key} className="flex items-center justify-between gap-3">
                  <dt className="shrink-0 text-text-secondary">{col.cardLabel ?? col.header}</dt>
                  <dd className="min-w-0 text-end text-text-primary">{col.render(row, index, rows)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ))}
    </div>
  )
}
