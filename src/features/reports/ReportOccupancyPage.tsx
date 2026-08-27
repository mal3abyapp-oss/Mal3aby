import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { translateSupabaseError } from '@/lib/errors'
import { Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'
import { ReportPrintButton, ReportPrintHeader } from '@/components/ui/report-print-header'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's OccupancyReportTab.
interface OccupancyReport {
  by_field: { field_id: string; field_name: string; booked_hours: number; booking_count: number }[]
}

export function ReportOccupancyPage() {
  const { t } = useTranslation()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading, isError, error, refetch } = useDateRangeReport<OccupancyReport>('get_field_occupancy_report', startDate, endDate)

  const filterSummary = `${startDate} → ${endDate}`

  return (
    <div>
      <div className="print:hidden">
        <PageHeader title={t('reports.title')} description={t('reports.occupancy.description')} />
        <ReportsNav />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 print:hidden">
        <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
        {data && data.by_field.length > 0 && <ReportPrintButton />}
      </div>
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {isError && <ErrorState message={translateSupabaseError(error, t('reports.loadError'))} onRetry={() => void refetch()} />}
      {data && (
        data.by_field.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('reports.occupancy.noFields')}</p>
        ) : (
          <div className="print-target visible-for-print">
            <ReportPrintHeader reportName={t('reports.occupancy.description')} filterSummary={filterSummary} />
            <div className="mb-2 flex justify-end print:hidden">
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
                    <Button asChild size="sm" variant="ghost" className="print:hidden">
                      <Link to="/app/fields">{t('reports.occupancy.manageField')}</Link>
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )
      )}
    </div>
  )
}
