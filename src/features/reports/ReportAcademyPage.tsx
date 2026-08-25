import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
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

// Reports + Invoices + Universal Entity Drill-Down audit:
// expiring_subscriptions carries subscription_id, not player_id, so a
// row had no way to reach Player 360 (the player_id-based route
// already used everywhere else in the app). Rather than widen
// get_academy_report's return shape, batch-resolve
// subscription_id -> player_id via subscriptions.enrollment_id ->
// enrollments.player_id, a plain read no different from the
// club/branch-scoped joins this report page already relies on.
async function fetchSubscriptionPlayerIds(subscriptionIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (subscriptionIds.length === 0) return map
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, enrollments(player_id)')
    .in('id', subscriptionIds)
  if (error) return map
  for (const row of data ?? []) {
    const playerId = (row.enrollments as unknown as { player_id: string } | null)?.player_id
    if (playerId) map.set(row.id, playerId)
  }
  return map
}

export function ReportAcademyPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading, isError, error, refetch } = useDateRangeReport<AcademyReport>('get_academy_report', startDate, endDate)

  const subscriptionIds = data?.expiring_subscriptions.map((s) => s.subscription_id) ?? []
  const { data: subscriptionPlayerIds } = useQuery({
    queryKey: ['academy-report-subscription-player-ids', subscriptionIds.join(',')],
    queryFn: () => fetchSubscriptionPlayerIds(subscriptionIds),
    enabled: subscriptionIds.length > 0,
  })

  return (
    <div>
      <PageHeader title={t('reports.title')} description={t('reports.academy.description')} />
      <ReportsNav />
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {isError && <ErrorState message={translateSupabaseError(error, t('reports.loadError'))} onRetry={() => void refetch()} />}
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
                  {data.expiring_subscriptions.map((s) => {
                    const playerId = subscriptionPlayerIds?.get(s.subscription_id)
                    return (
                      <li key={s.subscription_id}>
                        {playerId ? (
                          <button
                            className="flex w-full justify-between rounded-md border border-border p-2 text-sm hover:bg-muted/50"
                            onClick={() => navigate(`/app/academy/players/${playerId}`)}
                          >
                            <span className="text-accent-foreground">{s.player_name}</span>
                            <span className="tabular-nums text-status-warning">{s.effective_end_date}</span>
                          </button>
                        ) : (
                          <div className="flex justify-between rounded-md border border-border p-2 text-sm">
                            <span>{s.player_name}</span>
                            <span className="tabular-nums text-status-warning">{s.effective_end_date}</span>
                          </div>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
