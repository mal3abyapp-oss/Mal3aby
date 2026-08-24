import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { ErrorState } from '@/components/ui/error-state'
import { formatMoney } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'
import { Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's FinancialExceptionsReportTab. Also reused by
// OwnerFinanceTransparency.tsx's TodayPage widget (scoped to today) --
// legitimate reuse, not duplicated logic. RTL fix carried forward from
// the shared audit: invoice_number wrapped in <bdi> (was unprotected
// in the original tab).
interface FinancialExceptionsReport {
  total_discounts: number
  total_refunds: number
  void_invoice_count: number
  discounts: {
    booking_id: string
    invoice_number: string | null
    customer_name: string | null
    discount_amount: number
    total_price: number
    applied_by: string
    created_at: string
  }[]
  refunds: {
    refund_id: string
    amount: number
    reason: string | null
    refunded_by: string
    refunded_at: string
    customer_name: string
    payment_method: string
  }[]
}

export function ReportExceptionsContent() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading, isError, error, refetch } = useDateRangeReport<FinancialExceptionsReport>('get_financial_exceptions_report', startDate, endDate)
  const dateLocale = locale === 'en' ? 'en-US' : 'ar-EG'

  return (
    <div>
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {isError && <ErrorState message={translateSupabaseError(error, t('reports.loadError'))} onRetry={() => void refetch()} />}
      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
            <StatCard label={t('reports.exceptions.totalDiscounts')} value={formatMoney(data.total_discounts, 'EGP', locale)} tone={data.total_discounts > 0 ? 'warning' : undefined} />
            <StatCard label={t('reports.exceptions.totalRefunds')} value={formatMoney(data.total_refunds, 'EGP', locale)} tone="danger" />
            <StatCard label={t('reports.exceptions.voidedInvoices')} value={data.void_invoice_count} tone={data.void_invoice_count > 0 ? 'warning' : undefined} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">{t('reports.exceptions.discounts')}</p>
                {data.discounts.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadCsv(
                        `discounts-${startDate}-${endDate}.csv`,
                        rowsToCsv(
                          data.discounts.map((d) => ({
                            invoice_number: d.invoice_number ?? '—',
                            customer_name: d.customer_name ?? '—',
                            discount_amount: d.discount_amount,
                            total_price: d.total_price,
                            applied_by: d.applied_by,
                            created_at: d.created_at,
                          })),
                          {
                            invoice_number: t('reports.exceptions.csvHeader.invoiceNumber'),
                            customer_name: t('reports.exceptions.csvHeader.customer'),
                            discount_amount: t('reports.exceptions.csvHeader.discountAmount'),
                            total_price: t('reports.exceptions.csvHeader.totalPrice'),
                            applied_by: t('reports.exceptions.csvHeader.appliedBy'),
                            created_at: t('reports.exceptions.csvHeader.date'),
                          },
                        ),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    {t('reports.exportCsv')}
                  </Button>
                )}
              </div>
              {data.discounts.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('reports.exceptions.noDiscounts')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.discounts.map((d) => (
                    <li key={d.booking_id} className="rounded-md border border-border p-2 text-sm">
                      <div className="flex justify-between">
                        <span className="font-medium">{d.customer_name ?? '—'}</span>
                        <span className="tabular-nums text-status-warning">-{formatMoney(d.discount_amount, 'EGP', locale)}</span>
                      </div>
                      <p className="text-xs text-text-secondary">
                        <bdi>{d.invoice_number ?? '—'}</bdi> — {t('reports.exceptions.appliedBy', { name: d.applied_by })} — {new Date(d.created_at).toLocaleDateString(dateLocale)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">{t('reports.exceptions.refunds')}</p>
                {data.refunds.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadCsv(
                        `refunds-${startDate}-${endDate}.csv`,
                        rowsToCsv(
                          data.refunds.map((r) => ({
                            customer_name: r.customer_name,
                            amount: r.amount,
                            reason: r.reason ?? '—',
                            refunded_by: r.refunded_by,
                            refunded_at: r.refunded_at,
                          })),
                          {
                            customer_name: t('reports.exceptions.csvHeader.customer'),
                            amount: t('reports.exceptions.csvHeader.amount'),
                            reason: t('reports.exceptions.csvHeader.reason'),
                            refunded_by: t('reports.exceptions.csvHeader.refundedBy'),
                            refunded_at: t('reports.exceptions.csvHeader.date'),
                          },
                        ),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    {t('reports.exportCsv')}
                  </Button>
                )}
              </div>
              {data.refunds.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('reports.exceptions.noRefunds')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.refunds.map((r) => (
                    <li key={r.refund_id} className="rounded-md border border-border p-2 text-sm">
                      <div className="flex justify-between">
                        <span className="font-medium">{r.customer_name}</span>
                        <span className="tabular-nums text-status-danger">-{formatMoney(r.amount, 'EGP', locale)}</span>
                      </div>
                      <p className="text-xs text-text-secondary">
                        {r.reason ?? t('reports.exceptions.noReasonRecorded')} — {t('reports.exceptions.refundedBy', { name: r.refunded_by })} — {new Date(r.refunded_at).toLocaleDateString(dateLocale)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

export function ReportExceptionsPage() {
  const { t } = useTranslation()
  return (
    <div>
      <PageHeader title={t('reports.title')} description={t('reports.exceptions.description')} />
      <ReportsNav />
      <ReportExceptionsContent />
    </div>
  )
}
