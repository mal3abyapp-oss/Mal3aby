import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { formatMoney } from '@/lib/domain/billing'
import { BOOKING_STATUS_LABELS } from '@/lib/domain/booking'
import { useDirection } from '@/app/providers/DirectionProvider'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's BookingReportTab. Reused the CANONICAL
// BOOKING_STATUS_LABELS from src/lib/domain/booking.ts instead of the
// local duplicate the old tab file had (confirmed byte-identical to
// the canonical map -- the duplication was pure drift risk, no
// intentional difference).
interface BookingReport {
  by_status: { status: string; count: number }[]
  by_branch: { branch_id: string; branch_name: string; booking_count: number }[]
  cancellation_rate: number | null
  average_booking_value: number | null
}

export function ReportBookingsPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading } = useDateRangeReport<BookingReport>('get_booking_report', startDate, endDate)

  return (
    <div>
      <PageHeader title={t('reports.title')} description={t('reports.bookings.description')} />
      <ReportsNav />
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
            <StatCard
              label={t('reports.bookings.cancellationRate')}
              value={data.cancellation_rate !== null ? `${data.cancellation_rate}%` : '—'}
              tone={data.cancellation_rate !== null && data.cancellation_rate > 15 ? 'danger' : undefined}
            />
            <StatCard label={t('reports.bookings.averageBookingValue')} value={data.average_booking_value !== null ? formatMoney(data.average_booking_value, 'EGP', locale) : '—'} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">{t('reports.bookings.byStatus')}</p>
                {data.by_status.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadCsv(
                        `bookings-by-status-${startDate}-${endDate}.csv`,
                        rowsToCsv(
                          data.by_status.map((s) => ({ status: BOOKING_STATUS_LABELS[s.status] ?? s.status, count: s.count })),
                          { status: t('reports.bookings.csvHeader.status'), count: t('reports.bookings.csvHeader.count') },
                        ),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    {t('reports.exportCsv')}
                  </Button>
                )}
              </div>
              {data.by_status.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('reports.noData')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_status.map((s) => (
                    <li key={s.status} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                      <span>{BOOKING_STATUS_LABELS[s.status] ?? s.status}</span>
                      <span className="flex items-center gap-2">
                        <span className="tabular-nums">{s.count}</span>
                        {/* Master IA/UX audit: Reports must not be a
                            dead end -- from a status breakdown row a
                            manager can jump straight to those bookings
                            on the operational calendar. */}
                        <Button asChild size="sm" variant="ghost">
                          <Link to="/app/bookings">{t('reports.bookings.viewBookings')}</Link>
                        </Button>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-2 font-medium">{t('reports.bookings.byBranch')}</p>
              {data.by_branch.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('reports.bookings.noBranches')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_branch.map((b) => (
                    <li key={b.branch_id} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{b.branch_name}</span>
                      <span className="tabular-nums">{t('reports.bookings.bookingsCountSuffix', { count: b.booking_count })}</span>
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
