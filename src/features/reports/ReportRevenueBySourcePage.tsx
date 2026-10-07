import { useTranslation } from 'react-i18next'
import { Download, Wallet } from 'lucide-react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { ErrorState } from '@/components/ui/error-state'
import { formatMoney } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'
import { ReportPrintButton, ReportPrintHeader } from '@/components/ui/report-print-header'

// Revenue split by source (bookings / academy / memberships / shop /
// rentals / other) via get_revenue_by_source_report(). Totals reconcile
// with get_revenue_report() -- same payments, same date/branch scope --
// each payment is classified by the invoice line(s) it settled.
interface RevenueBySourceReport {
  total_collected: number
  total_refunded: number
  by_source: { source: string; collected: number; payment_count: number; refunded: number; net: number }[]
}

export function ReportRevenueBySourceContent() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading, isError, error, refetch } = useDateRangeReport<RevenueBySourceReport>('get_revenue_by_source_report', startDate, endDate)
  const money = (n: number) => formatMoney(Number(n), 'EGP', locale)
  const total = Number(data?.total_collected ?? 0)

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
        {data && <ReportPrintButton />}
      </div>
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {isError && <ErrorState message={translateSupabaseError(error, t('reports.loadError'))} onRetry={() => void refetch()} />}
      {data && (
        <div className="print-target visible-for-print">
          <ReportPrintHeader reportName={t('reports.bySource.description')} filterSummary={`${startDate} → ${endDate}`} />
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
            <StatCard label={t('reports.bySource.totalCollected')} value={money(data.total_collected)} icon={Wallet} />
            <StatCard label={t('reports.bySource.totalRefunded')} value={money(data.total_refunded)} tone="danger" />
            <StatCard label={t('reports.bySource.net')} value={money(Number(data.total_collected) - Number(data.total_refunded))} tone="success" />
          </div>
          <div className="mb-2 flex items-center justify-between">
            <p className="font-medium">{t('reports.bySource.title')}</p>
            {data.by_source.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                className="print:hidden"
                onClick={() =>
                  downloadCsv(
                    `revenue-by-source-${startDate}-${endDate}.csv`,
                    rowsToCsv(
                      data.by_source.map((s) => ({ source: t(`reports.bySource.sources.${s.source}`), collected: s.collected, refunded: s.refunded, net: s.net })),
                      { source: t('reports.bySource.source'), collected: t('reports.bySource.totalCollected'), refunded: t('reports.bySource.totalRefunded'), net: t('reports.bySource.net') },
                    ),
                  )
                }
              >
                <Download className="me-1 size-4" />
                {t('reports.exportCsv')}
              </Button>
            )}
          </div>
          {data.by_source.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {data.by_source.map((s) => {
                const share = total > 0 ? Math.round((100 * Number(s.collected)) / total) : 0
                return (
                  <li key={s.source} className="rounded-md border border-border p-2 text-sm">
                    <div className="flex justify-between gap-2">
                      <span className="font-medium">{t(`reports.bySource.sources.${s.source}`, { defaultValue: s.source })}</span>
                      <span>{money(s.collected)} <span className="text-xs text-text-secondary">({share}%)</span></span>
                    </div>
                    <div className="mt-1 h-1.5 w-full rounded bg-muted">
                      <div className="h-1.5 rounded bg-primary" style={{ width: `${share}%` }} />
                    </div>
                    <div className="mt-1 flex justify-between text-xs text-text-secondary">
                      <span>{t('reports.bySource.payments', { count: s.payment_count })}</span>
                      {Number(s.refunded) > 0 && <span>{t('reports.bySource.totalRefunded')}: {money(s.refunded)} · {t('reports.bySource.net')}: {money(s.net)}</span>}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

export function ReportRevenueBySourcePage() {
  const { t } = useTranslation()
  return (
    <div>
      <div className="print:hidden">
        <PageHeader title={t('reports.title')} description={t('reports.bySource.description')} />
        <ReportsNav />
      </div>
      <ReportRevenueBySourceContent />
    </div>
  )
}
