import { useTranslation } from 'react-i18next'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatDate } from '@/lib/i18n/config'
import { Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'

// PRINTING & DOCUMENT OUTPUT (2026-08-27) -- shared report print
// primitives (directive Sections 23-30/67). Reuses the EXACT same
// print mechanism already shipped for invoices/receipts in
// BillingPage.tsx / src/index.css (.print-target / .visible-for-print
// isolation + window.print(), A4 @page) -- not a second print system.
// A report page wraps its printable content in <div className="print-target
// visible-for-print"> and renders <ReportPrintHeader> as the first
// child, then <ReportPrintButton> alongside its other print:hidden
// actions. Screen totals and printed totals are structurally identical
// because both read from the SAME already-fetched report data --
// nothing is recalculated for print.
//
// Scope note (updated 2026-08-30, PRINTING PRODUCTION ACCEPTANCE):
// this pattern was originally wired into Revenue (Finance) and Shop
// (Commercial) reports as the two representative implementations.
// It has since been adopted by all other report pages (Bookings,
// Collections, Payment Methods, Academy, Occupancy, Exceptions,
// Reconciliation, Employee Liability, Official Receipts, Customers,
// Gateway Health) -- confirmed via source sweep: every ReportXPage.tsx
// under src/features/reports/ imports and renders all three of
// ReportPrintButton, ReportPrintHeader, and .print-target. No report
// page is missing this pattern any more.

export function ReportPrintButton() {
  const { t } = useTranslation()
  return (
    <Button variant="outline" size="sm" className="print:hidden" onClick={() => window.print()}>
      <Printer className="me-1 size-4" />
      {t('reports.print')}
    </Button>
  )
}

export function ReportPrintHeader({
  reportName,
  filterSummary,
}: {
  reportName: string
  filterSummary?: string
}) {
  const { t } = useTranslation()
  const { currentMembership } = useAuth()
  const { locale } = useDirection()
  const clubLabel = locale === 'ar' ? currentMembership?.clubNameAr : currentMembership?.clubName

  return (
    <div className="mb-4 hidden border-b border-border pb-3 print:block">
      <p className="text-lg font-bold">{reportName}</p>
      {clubLabel && <p className="text-sm text-text-secondary">{clubLabel}</p>}
      {filterSummary && <p className="text-xs text-text-secondary">{filterSummary}</p>}
      <p className="text-xs text-text-secondary">
        {t('reports.generatedAt')}: {formatDate(new Date().toISOString(), locale, 'Africa/Cairo', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </p>
    </div>
  )
}
