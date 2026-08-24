import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { ErrorState } from '@/components/ui/error-state'
import { formatMoney, PAYMENT_METHOD_LABELS } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { translateSupabaseError } from '@/lib/errors'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useDirection } from '@/app/providers/DirectionProvider'
import { Wallet, Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's RevenueReportTab -- this is the "financial source"
// most other numbers (Dashboard's total_revenue, Overview's revenue
// card) point back to. get_executive_dashboard's total_revenue/
// refunds_total previously duplicated this RPC's SQL body independently;
// that drift risk is now closed at the SQL level -- get_executive_dashboard
// calls get_revenue_report() internally for those fields (see migration
// 20260824100000_consolidate_executive_dashboard_revenue_predicate.sql),
// so there is exactly one SQL body computing total_revenue/refunds_total
// for both Finance Overview and this Revenue report/tab. (The other
// duplicate-predicate pairs noted in
// 20260818110000_document_duplicate_metric_predicates.sql --
// outstanding_total, active_enrollments, new_customers -- are unrelated
// to this component and remain tracked separately.)
interface RevenueReport {
  total_revenue: number
  by_day: { date: string; revenue: number }[]
  by_method: { method: string; revenue: number }[]
  refunds_total: number
}

// Finance IA consolidation directive: content split out so
// /app/finance/reports can embed it without dragging in the Reports
// module's own PageHeader/ReportsNav (directive section 43). Original
// routed page kept below for old bookmarks (section 32).
export function ReportRevenueContent() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const [method, setMethod] = useState<string>('all')
  const { data, isLoading, isError, error, refetch } = useDateRangeReport<RevenueReport>(
    'get_revenue_report',
    startDate,
    endDate,
    { p_method: method !== 'all' ? method : undefined },
  )

  return (
    <div>
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      <div className="mb-4 w-48">
        <Select value={method} onValueChange={setMethod}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('reports.revenue.allMethods')}</SelectItem>
            <SelectItem value="cash">{t('billing.paymentMethods.underlyingMethodLabels.cash')}</SelectItem>
            <SelectItem value="card">{t('billing.paymentMethods.underlyingMethodLabels.card')}</SelectItem>
            <SelectItem value="bank_transfer">{t('billing.paymentMethods.underlyingMethodLabels.bank_transfer')}</SelectItem>
            <SelectItem value="wallet">{t('billing.paymentMethods.underlyingMethodLabels.wallet')}</SelectItem>
            <SelectItem value="other">{t('billing.paymentMethods.underlyingMethodLabels.other')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {isError && <ErrorState message={translateSupabaseError(error, t('reports.loadError'))} onRetry={() => void refetch()} />}
      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
            <StatCard label={t('reports.revenue.totalRevenue')} value={formatMoney(data.total_revenue, 'EGP', locale)} icon={Wallet} />
            <StatCard label={t('reports.revenue.totalRefunds')} value={formatMoney(data.refunds_total, 'EGP', locale)} tone="danger" />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 font-medium">{t('reports.revenue.byMethod')}</p>
              {data.by_method.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_method.map((m) => (
                    <li key={m.method} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{t(`common.paymentMethodLabels.${m.method}`, { defaultValue: PAYMENT_METHOD_LABELS[m.method] ?? m.method })}</span>
                      <span>{formatMoney(m.revenue, 'EGP', locale)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">{t('reports.revenue.byDay')}</p>
                {data.by_day.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadCsv(
                        `revenue-${startDate}-${endDate}.csv`,
                        rowsToCsv(data.by_day, { date: t('reports.revenue.csvHeader.date'), revenue: t('reports.revenue.csvHeader.revenue') }),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    {t('reports.exportCsv')}
                  </Button>
                )}
              </div>
              {data.by_day.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_day.map((d) => (
                    <li key={d.date} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span className="tabular-nums">{d.date}</span>
                      <span>{formatMoney(d.revenue, 'EGP', locale)}</span>
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

export function ReportRevenuePage() {
  const { t } = useTranslation()
  return (
    <div>
      <PageHeader title={t('reports.title')} description={t('reports.revenue.description')} />
      <ReportsNav />
      <ReportRevenueContent />
    </div>
  )
}
