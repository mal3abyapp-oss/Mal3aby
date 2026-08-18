import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's OccupancyReportTab.
interface OccupancyReport {
  by_field: { field_id: string; field_name: string; booked_hours: number; booking_count: number }[]
}

export function ReportOccupancyPage() {
  const { t } = useTranslation()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading } = useDateRangeReport<OccupancyReport>('get_field_occupancy_report', startDate, endDate)

  return (
    <div>
      <PageHeader title={t('reports.title')} description={t('reports.occupancy.description')} />
      <ReportsNav />
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {data && (
        data.by_field.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('reports.occupancy.noFields')}</p>
        ) : (
          <>
            <div className="mb-2 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadCsv(
                    `occupancy-${startDate}-${endDate}.csv`,
                    rowsToCsv(data.by_field, { field_name: t('reports.occupancy.csvHeader.field'), booked_hours: t('reports.occupancy.csvHeader.bookedHours'), booking_count: t('reports.occupancy.csvHeader.bookingCount') }),
                  )
                }
              >
                <Download className="me-1 size-4" />
                {t('reports.exportCsv')}
              </Button>
            </div>
            <ul className="flex flex-col gap-2">
              {data.by_field.map((f) => (
                <li key={f.field_id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                  <span className="font-medium">{f.field_name}</span>
                  <span className="flex items-center gap-3 text-text-secondary">
                    {t('reports.occupancy.hoursAndBookingsSuffix', { hours: f.booked_hours, count: f.booking_count })}
                    {/* Master IA/UX audit: link out to the field's own
                        management screen instead of a dead-end row. */}
                    <Button asChild size="sm" variant="ghost">
                      <Link to="/app/fields">{t('reports.occupancy.manageField')}</Link>
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </div>
  )
}
