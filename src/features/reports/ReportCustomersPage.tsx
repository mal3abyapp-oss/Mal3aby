import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { ErrorState } from '@/components/ui/error-state'
import { formatMoney } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'
import { Users, Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's CustomerReportTab. Drill-down added: each top-
// spender row links directly to Customer 360 (/app/customers/:id).
//
// Reports + Invoices + Universal Entity Drill-Down audit: previously
// linked via /app/customers?q=<name> (name-search) even though
// customer_id was already present in the row -- ambiguous with
// duplicate/similar names and one extra click. customer_id is the
// real primary key everywhere else in the app (CustomersPage,
// BillingPage, BookingDetailSheet, etc.), so this now matches.
interface CustomerReport {
  new_customers: number
  top_customers: { customer_id: string; customer_name: string; total_spend: number; booking_count: number }[]
}

export function ReportCustomersPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading, isError, error, refetch } = useDateRangeReport<CustomerReport>('get_customer_activity_report', startDate, endDate)

  return (
    <div>
      <PageHeader title={t('reports.title')} description={t('reports.customers.description')} />
      <ReportsNav />
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {isError && <ErrorState message={translateSupabaseError(error, t('reports.loadError'))} onRetry={() => void refetch()} />}
      {data && (
        <>
          <div className="mb-6">
            <StatCard label={t('reports.customers.newCustomers')} value={data.new_customers} icon={Users} to="/app/customers" />
          </div>
          <div className="mb-2 flex items-center justify-between">
            <p className="font-medium">{t('reports.customers.topSpenders')}</p>
            {data.top_customers.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadCsv(
                    `customers-${startDate}-${endDate}.csv`,
                    rowsToCsv(data.top_customers, { customer_name: t('reports.customers.csvHeader.customer'), total_spend: t('reports.customers.csvHeader.totalSpend'), booking_count: t('reports.customers.csvHeader.bookingCount') }),
                  )
                }
              >
                <Download className="me-1 size-4" />
                {t('reports.exportCsv')}
              </Button>
            )}
          </div>
          {data.top_customers.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {data.top_customers.map((c) => (
                <li key={c.customer_id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                  <Link to={`/app/customers/${c.customer_id}`} className="font-medium text-accent-foreground hover:underline">
                    {c.customer_name}
                  </Link>
                  <span>{formatMoney(c.total_spend, 'EGP', locale)} — {t('reports.customers.bookingCountSuffix', { count: c.booking_count })}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
