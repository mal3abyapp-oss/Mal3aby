import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { FormattedDate } from '@/components/ui/formatted-date'
import { Printer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { supabase } from '@/lib/supabase/client'

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
  timeZone,
}: {
  reportName: string
  filterSummary?: string
  /** IANA timezone for the "Generated At" stamp. Optional -- when a
   *  caller doesn't already have the club's timezone at hand, this
   *  component fetches it itself (same clubs.timezone column/fallback
   *  as BillingPage's "Collected Today" fix and useDateRangeReport's
   *  useDateRange() -- see report-print-header.tsx's own history). Pass
   *  it explicitly only when a caller already has the value in scope,
   *  to avoid a redundant fetch. */
  timeZone?: string
}) {
  const { t } = useTranslation()
  const { currentMembership, currentClubId } = useAuth()
  const { locale } = useDirection()
  const clubLabel = locale === 'ar' ? currentMembership?.clubNameAr : currentMembership?.clubName

  // TIMEZONE FIX (2026-09-14): "Generated At" was hardcoded to
  // Africa/Cairo for every club regardless of the club's actual
  // timezone -- wrong for any club outside Egypt. Every report page
  // renders this component while a club is already selected, so the
  // club's real timezone is fetched here directly (same query shape as
  // BillingPage.tsx / useDateRangeReport.ts's useDateRange()) rather
  // than threading a new required prop through all 23+ report call
  // sites. `enabled: !timeZone` skips the fetch entirely when a caller
  // already passed the value explicitly. The 'Africa/Cairo' fallback
  // only applies if the club genuinely has no timezone value or the
  // query hasn't resolved yet -- not a silent default for every club.
  const { data: fetchedTimeZone } = useQuery({
    queryKey: ['report-print-header-club-timezone', currentClubId],
    queryFn: async () => {
      const { data } = await supabase.from('clubs').select('timezone').eq('id', currentClubId!).maybeSingle()
      return data?.timezone ?? 'Africa/Cairo'
    },
    enabled: !timeZone && !!currentClubId,
    staleTime: Infinity,
  })
  const resolvedTimeZone = timeZone ?? fetchedTimeZone ?? 'Africa/Cairo'

  return (
    <div className="mb-4 hidden border-b border-border pb-3 print:block">
      <p className="text-lg font-bold">{reportName}</p>
      {clubLabel && <p className="text-sm text-text-secondary">{clubLabel}</p>}
      {filterSummary && <p className="text-xs text-text-secondary">{filterSummary}</p>}
      <p className="text-xs text-text-secondary">
        {t('reports.generatedAt')}: <FormattedDate value={new Date()} timeZone={resolvedTimeZone} options={{ day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }} />
      </p>
    </div>
  )
}
