import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { StatusBadge } from '@/components/ui/status-badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { formatMoney } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'
import { useAuth } from '@/app/providers/AuthProvider'
import { supabase } from '@/lib/supabase/client'
import { ShieldCheck, Download, AlertTriangle } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Government / Ministry Collection Compliance directive, sections 39-42:
// "Official Collection Receipts" report, following the exact same
// rpc_name(p_club_id, p_start_date, p_end_date, ...) convention every
// other report in this module already uses -- reuses useDateRangeReport
// and DateRangeFilter rather than a bespoke fetch pattern.

interface ReceiptRow {
  id: string
  receipt_book: string | null
  receipt_series: string | null
  receipt_serial: string
  receipt_date: string
  receipt_amount: number
  payment_method: string
  status: string
  branch_name: string | null
  field_name: string | null
  customer_name: string | null
  entered_by_name: string | null
  booking_id: string | null
  reversed_at: string | null
  reversal_reason: string | null
}

interface ReceiptsReport {
  receipts: ReceiptRow[]
  total_count: number
  active_count: number
  reversed_count: number
  total_collected_amount: number
}

// Finance IA consolidation directive: split into a header/nav-free
// content component (reused verbatim by /app/finance/invoices'
// "Official Receipts" sub-tab) plus the original standalone routed page
// (kept for old bookmarks/deep links, directive section 32) which just
// wraps the content with this module's own PageHeader/ReportsNav. No
// duplicated fetch/render logic between the two entry points.
export function ReportOfficialReceiptsContent() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { currentClubId } = useAuth()
  const navigate = useNavigate()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const [serialSearch, setSerialSearch] = useState('')

  const { data, isLoading, isError, error, refetch } = useDateRangeReport<ReceiptsReport>(
    'get_official_receipts_report',
    startDate,
    endDate,
    { p_receipt_serial: serialSearch.trim() || undefined },
  )

  // Directive section 29/43: surface compliance exceptions (missing
  // receipt, reversal awaiting review) to authorized users -- reuses
  // the report's own RLS/permission boundary via the RPC.
  const { data: exceptions } = useQuery({
    queryKey: ['government-compliance-exceptions', currentClubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_government_compliance_exceptions', {
        p_club_id: currentClubId as string,
      })
      if (error) throw error
      return data?.[0] ?? null
    },
    enabled: !!currentClubId,
  })

  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-3">
        <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
        <Input
          placeholder={t('reports.officialReceipts.searchSerialPlaceholder')}
          value={serialSearch}
          onChange={(e) => setSerialSearch(e.target.value)}
          className="max-w-xs"
        />
      </div>

      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {isError && <ErrorState message={translateSupabaseError(error, t('reports.loadError'))} onRetry={() => void refetch()} />}

      {exceptions && (exceptions.missing_receipt_payment_count > 0 || exceptions.reversed_awaiting_review_count > 0) && (
        <div className="mb-6 flex flex-col gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-4">
          <div className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4 text-status-warning" />
            {t('reports.officialReceipts.exceptions.title')}
          </div>
          {exceptions.missing_receipt_payment_count > 0 && (
            <p className="text-sm">
              {t('reports.officialReceipts.exceptions.missingReceipt')}: <span className="font-medium tabular-nums">{exceptions.missing_receipt_payment_count}</span>
            </p>
          )}
          {exceptions.reversed_awaiting_review_count > 0 && (
            <p className="text-sm">
              {t('reports.officialReceipts.exceptions.reversedAwaitingReview')}: <span className="font-medium tabular-nums">{exceptions.reversed_awaiting_review_count}</span>
            </p>
          )}
        </div>
      )}

      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label={t('reports.officialReceipts.totalCount')} value={String(data.total_count)} icon={ShieldCheck} />
            <StatCard label={t('reports.officialReceipts.activeCount')} value={String(data.active_count)} />
            <StatCard label={t('reports.officialReceipts.reversedCount')} value={String(data.reversed_count)} tone={data.reversed_count > 0 ? 'warning' : undefined} />
            {/* Directive section 41: reversed receipts are excluded from
                this total server-side -- this is the collected amount
                from ACTIVE receipts only. */}
            <StatCard label={t('reports.officialReceipts.totalCollected')} value={formatMoney(data.total_collected_amount, 'EGP', locale)} />
          </div>

          <div className="mb-2 flex items-center justify-between">
            <p className="font-medium">{t('reports.officialReceipts.listTitle')}</p>
            {data.receipts.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadCsv(
                    `official-receipts-${startDate}-${endDate}.csv`,
                    rowsToCsv(data.receipts as unknown as Record<string, unknown>[], {
                      receipt_serial: t('reports.officialReceipts.csvHeader.serial'),
                      receipt_book: t('reports.officialReceipts.csvHeader.book'),
                      receipt_series: t('reports.officialReceipts.csvHeader.series'),
                      receipt_date: t('reports.officialReceipts.csvHeader.date'),
                      receipt_amount: t('reports.officialReceipts.csvHeader.amount'),
                      payment_method: t('reports.officialReceipts.csvHeader.method'),
                      status: t('reports.officialReceipts.csvHeader.status'),
                      customer_name: t('reports.officialReceipts.csvHeader.customer'),
                      entered_by_name: t('reports.officialReceipts.csvHeader.enteredBy'),
                    }),
                  )
                }
              >
                <Download className="me-1 size-4" />
                {t('reports.exportCsv')}
              </Button>
            )}
          </div>

          {data.receipts.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {data.receipts.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium tabular-nums">
                        <bdi>{r.receipt_serial}</bdi>
                      </span>
                      {(r.receipt_book || r.receipt_series) && (
                        <span className="text-xs text-text-secondary">
                          {[r.receipt_book, r.receipt_series].filter(Boolean).join(' / ')}
                        </span>
                      )}
                      <StatusBadge
                        tone={r.status === 'active' ? 'success' : 'neutral'}
                        label={t(`reports.officialReceipts.statusLabels.${r.status}`)}
                      />
                    </div>
                    <p className="text-xs text-text-secondary">
                      {new Date(r.receipt_date).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG')}
                      {r.field_name && ` · ${r.field_name}`}
                      {r.customer_name && ` · ${r.customer_name}`}
                      {r.entered_by_name && ` · ${t('reports.officialReceipts.enteredByPrefix')} ${r.entered_by_name}`}
                    </p>
                    {r.status === 'reversed' && r.reversal_reason && (
                      <p className="text-xs text-status-danger">{t('reports.officialReceipts.reversalReasonPrefix')} {r.reversal_reason}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-medium">{formatMoney(r.receipt_amount, 'EGP', locale)}</span>
                    {r.booking_id && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => navigate(`/app/bookings?booking=${r.booking_id}`)}
                      >
                        {t('reports.officialReceipts.viewBooking', { defaultValue: 'View booking' })}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function ReportOfficialReceiptsPage() {
  const { t } = useTranslation()
  return (
    <div>
      <PageHeader title={t('reports.title')} description={t('reports.officialReceipts.description')} />
      <ReportsNav />
      <ReportOfficialReceiptsContent />
    </div>
  )
}
