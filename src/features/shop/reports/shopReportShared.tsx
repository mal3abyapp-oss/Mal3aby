import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { ChevronRight, ChevronLeft, Printer } from 'lucide-react'
import { useDirection } from '@/app/providers/DirectionProvider'
import { ReportPrintButton } from '@/components/ui/report-print-header'

// Commerce Pro C7: 16-report suite shared helpers. Every report in
// this module follows the identical shape ReportShopPage.tsx/
// ShopSalesPage.tsx already established: bounded screen query (server-
// side p_limit/p_offset), a "Print Full Report" action that pages
// through the SAME RPC via fetchFullReport.ts (never a second,
// unbounded query), and ReportPrintButton/ReportPrintHeader reuse for
// the print chrome. Centralizing the pager UI here once, instead of
// copy-pasting it into 16 files, mirrors this codebase's own stated
// reasoning for useDateRangeReport.ts existing in the first place.
export const REPORT_PAGE_SIZE = 50

export function useOffsetPager() {
  const [offset, setOffset] = useState(0)
  const reset = () => setOffset(0)
  return { offset, setOffset, reset }
}

export function PagerControls({
  offset,
  pageSize,
  rowCount,
  onPrev,
  onNext,
}: {
  offset: number
  pageSize: number
  rowCount: number
  onPrev: () => void
  onNext: () => void
}) {
  const { t } = useTranslation()
  const { direction } = useDirection()
  const Prev = direction === 'rtl' ? ChevronRight : ChevronLeft
  const Next = direction === 'rtl' ? ChevronLeft : ChevronRight
  const hasNext = rowCount === pageSize
  const hasPrev = offset > 0
  if (!hasNext && !hasPrev && rowCount <= pageSize) return null
  return (
    <div className="mt-2 flex items-center justify-between print:hidden">
      <p className="text-xs text-text-secondary">
        {t('shop.reports.pager.range', { from: offset + 1, to: offset + rowCount })}
      </p>
      <div className="flex gap-1">
        <Button variant="outline" size="sm" disabled={!hasPrev} onClick={onPrev}>
          <Prev className="size-4" aria-hidden="true" />
          {t('shop.reports.pager.prev')}
        </Button>
        <Button variant="outline" size="sm" disabled={!hasNext} onClick={onNext}>
          {t('shop.reports.pager.next')}
          <Next className="size-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  )
}

// Standard header row for every report content component: title/
// description on the left, print actions on the right -- print-full is
// optional (a report with no natural "can grow large" list, e.g. a
// single-row KPI summary, doesn't need one).
export function ReportHeaderActions({
  hasRows,
  onPrintFull,
  printFullPending,
}: {
  hasRows: boolean
  onPrintFull?: () => void
  printFullPending?: boolean
}) {
  const { t } = useTranslation()
  if (!hasRows) return null
  return (
    <div className="flex gap-2 print:hidden">
      <ReportPrintButton />
      {onPrintFull && (
        <Button variant="outline" size="sm" disabled={printFullPending} onClick={onPrintFull}>
          <Printer className="me-1 size-4" />
          {printFullPending ? t('reports.printFullPreparing') : t('reports.printFull')}
        </Button>
      )}
    </div>
  )
}

export function FullPrintNote({ fullCount, truncated, screenLimit }: { fullCount: number | null; truncated: boolean; screenLimit: number }) {
  const { t } = useTranslation()
  if (fullCount !== null) {
    return (
      <>
        <p className="mb-2 text-xs text-text-secondary">{t('reports.printFullRowCount', { count: fullCount })}</p>
        {truncated && <p className="mb-2 text-xs font-medium text-status-warning">{t('reports.printFullTruncated')}</p>}
      </>
    )
  }
  return <p className="mb-2 hidden text-xs text-text-secondary print:block">{t('shop.sales.printLimitNote', { count: screenLimit })}</p>
}
