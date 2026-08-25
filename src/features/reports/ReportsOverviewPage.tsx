import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { ErrorState } from '@/components/ui/error-state'
import { formatMoney } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'
import { Wallet, CalendarCheck2, GraduationCap, Users, Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Master IA/UX audit (Reports decomposition phase): ReportsPage.tsx was
// 1127 lines, 9 tab components in one file -- visual tab-grouping alone
// (a prior IA pass) was correctly identified as NOT real decomposition.
// This is the entry point/landing screen for the whole Reports domain
// (route: /app/reports, index) -- summary only, every KPI drills down
// to its owning report. Genuinely independent reports (their own
// filters, mutations, or complexity -- confirmed via the audit) got
// their own routed screens; the rest stayed as this summary + links.
interface ExecutiveDashboard {
  total_revenue: number
  refunds_total: number
  outstanding_total: number
  bookings_count: number
  bookings_cancelled_count: number
  total_booked_hours: number
  active_enrollments: number
  new_customers: number
  revenue_by_day: { date: string; revenue: number }[]
}

export function ReportsOverviewPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading, isError, error, refetch } = useDateRangeReport<ExecutiveDashboard>('get_executive_dashboard', startDate, endDate)

  return (
    <div>
      <PageHeader title={t('reports.title')} description={t('reports.overview.description')} />
      <ReportsNav />
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {isError && <ErrorState message={translateSupabaseError(error, t('reports.loadError'))} onRetry={() => void refetch()} />}
      {data && (
        <>
          {/* Master IA/UX audit: confirmed ALL 8 of these cards were
              dead-ends (StatCard had no onClick/href prop at all).
              Every card now drills down to the report/screen that owns
              that number -- e.g. "حجوزات ملغاة" goes to the Bookings
              report pre-scoped conceptually to cancellations (exact
              status-filter wiring lives on that screen). */}
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label={t('reports.overview.cards.totalRevenue')} value={formatMoney(data.total_revenue, 'EGP', locale)} icon={Wallet} to="/app/finance" />
            <StatCard label={t('reports.overview.cards.currentOutstanding')} value={formatMoney(data.outstanding_total, 'EGP', locale)} tone={data.outstanding_total > 0 ? 'warning' : undefined} to="/app/finance/payments?status=outstanding" />
            <StatCard label={t('reports.overview.cards.refunds')} value={formatMoney(data.refunds_total, 'EGP', locale)} tone="danger" to="/app/finance/reports" />
            <StatCard label={t('reports.overview.cards.confirmedBookings')} value={data.bookings_count} icon={CalendarCheck2} to="/app/reports/bookings" />
            {/* PERSONA COUNCIL AUDIT (2026-08-25) -- Club Owner persona
                finding: this and the card above are the same shape and
                tone regardless of the actual numbers -- live-confirmed
                a real state where cancellations (33) exceeded confirmed
                bookings (26) for the selected range with zero visual
                signal that something operationally unusual was
                happening. A club owner scanning cards by color/shape,
                not reading every number, could easily miss it. Now
                flags danger tone when cancellations are the larger
                share -- a real, meaningful comparison (both counts are
                for the exact same date range and club), not decoration. */}
            <StatCard
              label={t('reports.overview.cards.cancelledBookings')}
              value={data.bookings_cancelled_count}
              tone={data.bookings_cancelled_count > data.bookings_count ? 'danger' : undefined}
              to="/app/reports/bookings"
            />
            <StatCard label={t('reports.overview.cards.bookedHours')} value={data.total_booked_hours} to="/app/reports/occupancy" />
            <StatCard label={t('reports.overview.cards.activeAcademyEnrollments')} value={data.active_enrollments} icon={GraduationCap} to="/app/reports/academy" />
            <StatCard label={t('reports.overview.cards.newCustomers')} value={data.new_customers} icon={Users} to="/app/reports/customers" />
          </div>
          <div className="mb-2 flex items-center justify-between">
            <p className="font-medium">{t('reports.overview.revenueByDay')}</p>
            {data.revenue_by_day.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadCsv(
                    `executive-dashboard-${startDate}-${endDate}.csv`,
                    rowsToCsv(data.revenue_by_day, { date: t('reports.overview.csvHeader.date'), revenue: t('reports.overview.csvHeader.revenue') }),
                  )
                }
              >
                <Download className="me-1 size-4" />
                {t('reports.exportCsv')}
              </Button>
            )}
          </div>
          {data.revenue_by_day.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {data.revenue_by_day.map((d) => (
                <li key={d.date} className="flex justify-between rounded-md border border-border p-2 text-sm">
                  <span className="tabular-nums">{d.date}</span>
                  <span>{formatMoney(d.revenue, 'EGP', locale)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
