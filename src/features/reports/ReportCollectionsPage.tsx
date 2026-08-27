import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { ErrorState } from '@/components/ui/error-state'
import { formatMoney } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'
import { HandCoins, Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'
import { ReportPrintButton, ReportPrintHeader } from '@/components/ui/report-print-header'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's CollectionsReportTab. Same RPC (get_collections_report)
// is also called by OwnerFinanceTransparency.tsx's TodayPage widget
// (scoped to today) -- legitimate reuse of the same source of truth,
// not duplicated logic.
interface CollectionsReport {
  total_collected: number
  by_employee: { user_id: string | null; full_name: string; amount: number; payment_count: number }[]
  by_branch: { branch_id: string; branch_name: string; amount: number; payment_count: number }[]
}

export function ReportCollectionsContent() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading, isError, error, refetch } = useDateRangeReport<CollectionsReport>('get_collections_report', startDate, endDate)

  const filterSummary = `${startDate} → ${endDate}`

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
          <ReportPrintHeader reportName={t('reports.collections.description')} filterSummary={filterSummary} />
          <div className="mb-6">
            <StatCard label={t('reports.collections.totalCollected')} value={formatMoney(data.total_collected, 'EGP', locale)} icon={HandCoins} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">{t('reports.collections.byEmployee')}</p>
                {data.by_employee.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="print:hidden"
                    onClick={() =>
                      downloadCsv(
                        `collections-by-employee-${startDate}-${endDate}.csv`,
                        rowsToCsv(
                          data.by_employee.map((e) => ({ full_name: e.full_name, amount: e.amount, payment_count: e.payment_count })),
                          { full_name: t('reports.collections.csvHeader.employee'), amount: t('reports.collections.csvHeader.amountCollected'), payment_count: t('reports.collections.csvHeader.paymentCount') },
                        ),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    {t('reports.exportCsv')}
                  </Button>
                )}
              </div>
              {data.by_employee.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_employee.map((e) => (
                    <li key={e.user_id ?? 'unknown'} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{e.full_name}</span>
                      <span>{formatMoney(e.amount, 'EGP', locale)} — {t('reports.collections.paymentCountSuffix', { count: e.payment_count })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">{t('reports.collections.byBranch')}</p>
                {data.by_branch.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="print:hidden"
                    onClick={() =>
                      downloadCsv(
                        `collections-by-branch-${startDate}-${endDate}.csv`,
                        rowsToCsv(
                          data.by_branch.map((b) => ({ branch_name: b.branch_name, amount: b.amount, payment_count: b.payment_count })),
                          { branch_name: t('reports.collections.csvHeader.branch'), amount: t('reports.collections.csvHeader.amountCollected'), payment_count: t('reports.collections.csvHeader.paymentCount') },
                        ),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    {t('reports.exportCsv')}
                  </Button>
                )}
              </div>
              {data.by_branch.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_branch.map((b) => (
                    <li key={b.branch_id} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{b.branch_name}</span>
                      <span>{formatMoney(b.amount, 'EGP', locale)} — {t('reports.collections.paymentCountSuffix', { count: b.payment_count })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export function ReportCollectionsPage() {
  const { t } = useTranslation()
  return (
    <div>
      <div className="print:hidden">
        <PageHeader title={t('reports.title')} description={t('reports.collections.description')} />
        <ReportsNav />
      </div>
      <ReportCollectionsContent />
    </div>
  )
}
