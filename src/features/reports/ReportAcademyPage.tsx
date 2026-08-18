import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { GraduationCap } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's AcademyReportTab.
interface AcademyReport {
  active_enrollments: number
  attendance_rate: number | null
  by_group: { group_id: string; group_name: string; active_enrollments: number; capacity: number }[]
  expiring_subscriptions: { subscription_id: string; player_name: string; effective_end_date: string }[]
}

export function ReportAcademyPage() {
  const { t } = useTranslation()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading } = useDateRangeReport<AcademyReport>('get_academy_report', startDate, endDate)

  return (
    <div>
      <PageHeader title={t('reports.title')} description={t('reports.academy.description')} />
      <ReportsNav />
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
            <StatCard label={t('reports.academy.activeEnrollments')} value={data.active_enrollments} icon={GraduationCap} to="/app/academy" />
            <StatCard label={t('reports.academy.attendanceRate')} value={data.attendance_rate !== null ? `${data.attendance_rate}%` : '—'} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 font-medium">{t('reports.academy.byGroup')}</p>
              {data.by_group.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('reports.academy.noGroups')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_group.map((g) => (
                    <li key={g.group_id} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{g.group_name}</span>
                      <span className="tabular-nums"><bdi>{g.active_enrollments} / {g.capacity}</bdi></span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">{t('reports.academy.expiringSubscriptions')}</p>
                {/* Master IA/UX audit: link to the enrollment/renewal
                    workflow instead of a dead-end list. */}
                <Button asChild size="sm" variant="ghost">
                  <Link to="/app/academy">{t('reports.academy.manageSubscriptions')}</Link>
                </Button>
              </div>
              {data.expiring_subscriptions.length === 0 ? (
                <p className="text-sm text-text-secondary">{t('reports.academy.none')}</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.expiring_subscriptions.map((s) => (
                    <li key={s.subscription_id} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{s.player_name}</span>
                      <span className="tabular-nums text-status-warning">{s.effective_end_date}</span>
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
