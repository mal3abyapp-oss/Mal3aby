// SalesDashboardPage -- Sales Intelligence Phase 19 (ADR-054). The
// landing screen for /platform/sales: summary stats, funnel, by-source
// breakdown, and pending follow-ups. Matches the established
// PlatformOverviewPage-style dashboard-card layout, extended with the
// isError/ErrorState pattern the app's own prior remediation
// established as the app-wide standard for financial/admin screens.
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { FormattedDate } from '@/components/ui/formatted-date'
import { SALES_DISPLAY_TIMEZONE } from './salesTimeZone'

interface DashboardSummary {
  total_leads: number
  hot_leads: number
  warm_leads: number
  cold_leads: number
  contact_ready: number
  contacted: number
  demos_scheduled: number
  converted: number
  reply_rate: number | null
  demo_rate: number | null
  win_rate: number | null
  avg_days_to_conversion: number | null
}

interface FunnelStage {
  stage: string
  lead_count: number
}

interface SourceStat {
  source_key: string
  source_name_en: string
  lead_count: number
  won_count: number
}

interface PendingFollowup {
  followup_id: string
  lead_id: string
  business_name: string
  reason: string
  scheduled_at: string
  is_overdue: boolean
}

async function fetchSummary(): Promise<DashboardSummary> {
  const { data, error } = await supabase.rpc('get_sales_dashboard_summary')
  if (error) throw error
  return data?.[0] ?? {
    total_leads: 0, hot_leads: 0, warm_leads: 0, cold_leads: 0, contact_ready: 0,
    contacted: 0, demos_scheduled: 0, converted: 0, reply_rate: null, demo_rate: null,
    win_rate: null, avg_days_to_conversion: null,
  }
}

async function fetchFunnel(): Promise<FunnelStage[]> {
  const { data, error } = await supabase.rpc('get_sales_funnel_stats')
  if (error) throw error
  return data ?? []
}

async function fetchBySource(): Promise<SourceStat[]> {
  const { data, error } = await supabase.rpc('get_sales_stats_by_source')
  if (error) throw error
  return data ?? []
}

async function fetchFollowups(): Promise<PendingFollowup[]> {
  const { data, error } = await supabase.rpc('get_pending_followups', { p_limit: 10 })
  if (error) throw error
  return data ?? []
}

export function SalesDashboardPage() {
  const { t } = useTranslation()

  const summaryQuery = useQuery({ queryKey: ['sales-dashboard-summary'], queryFn: fetchSummary })
  const funnelQuery = useQuery({ queryKey: ['sales-funnel-stats'], queryFn: fetchFunnel })
  const sourceQuery = useQuery({ queryKey: ['sales-stats-by-source'], queryFn: fetchBySource })
  const followupsQuery = useQuery({ queryKey: ['sales-pending-followups'], queryFn: fetchFollowups })

  const summary = summaryQuery.data

  return (
    <div className="space-y-6">
      <PageHeader title={t('platform.sales.dashboard.title')} description={t('platform.sales.dashboard.description')} />

      {summaryQuery.isError ? (
        <ErrorState message={translateSupabaseError(summaryQuery.error, t('platform.sales.dashboard.loadError'))} onRetry={() => summaryQuery.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          <StatCard label={t('platform.sales.dashboard.totalLeads')} value={summary?.total_leads} loading={summaryQuery.isLoading} />
          <StatCard label={t('platform.sales.dashboard.hotLeads')} value={summary?.hot_leads} loading={summaryQuery.isLoading} tone="danger" />
          <StatCard label={t('platform.sales.dashboard.warmLeads')} value={summary?.warm_leads} loading={summaryQuery.isLoading} tone="warning" />
          <StatCard label={t('platform.sales.dashboard.coldLeads')} value={summary?.cold_leads} loading={summaryQuery.isLoading} tone="neutral" />
          <StatCard label={t('platform.sales.dashboard.contactReady')} value={summary?.contact_ready} loading={summaryQuery.isLoading} />
          <StatCard label={t('platform.sales.dashboard.demosScheduled')} value={summary?.demos_scheduled} loading={summaryQuery.isLoading} />
          <StatCard label={t('platform.sales.dashboard.converted')} value={summary?.converted} loading={summaryQuery.isLoading} tone="success" />
          <StatCard
            label={t('platform.sales.dashboard.winRate')}
            value={summary?.win_rate != null ? `${summary.win_rate}%` : undefined}
            loading={summaryQuery.isLoading}
          />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t('platform.sales.dashboard.funnelTitle')}</CardTitle></CardHeader>
          <CardContent>
            {funnelQuery.isError ? (
              <ErrorState message={translateSupabaseError(funnelQuery.error, t('platform.sales.dashboard.loadError'))} onRetry={() => funnelQuery.refetch()} />
            ) : funnelQuery.isLoading ? (
              <p className="text-sm text-text-secondary">{t('common.loading')}</p>
            ) : (
              <ul className="space-y-2">
                {(funnelQuery.data ?? []).map((s) => (
                  <li key={s.stage} className="flex items-center justify-between">
                    <span className="text-sm text-text-secondary">{t(`platform.sales.pipeline.stage.${s.stage}`)}</span>
                    <span className="font-semibold tabular-nums">{s.lead_count}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t('platform.sales.dashboard.bySourceTitle')}</CardTitle></CardHeader>
          <CardContent>
            {sourceQuery.isError ? (
              <ErrorState message={translateSupabaseError(sourceQuery.error, t('platform.sales.dashboard.loadError'))} onRetry={() => sourceQuery.refetch()} />
            ) : sourceQuery.isLoading ? (
              <p className="text-sm text-text-secondary">{t('common.loading')}</p>
            ) : (sourceQuery.data ?? []).length === 0 ? (
              <p className="text-sm text-text-secondary">{t('platform.sales.dashboard.noData')}</p>
            ) : (
              <ul className="space-y-2">
                {(sourceQuery.data ?? []).map((s) => (
                  <li key={s.source_key} className="flex items-center justify-between">
                    <span className="text-sm text-text-secondary">{s.source_name_en}</span>
                    <span className="text-sm tabular-nums">{s.lead_count} ({s.won_count} {t('platform.sales.dashboard.won')})</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.dashboard.followupsTitle')}</CardTitle></CardHeader>
        <CardContent>
          {followupsQuery.isError ? (
            <ErrorState message={translateSupabaseError(followupsQuery.error, t('platform.sales.dashboard.loadError'))} onRetry={() => followupsQuery.refetch()} />
          ) : followupsQuery.isLoading ? (
            <p className="text-sm text-text-secondary">{t('common.loading')}</p>
          ) : (followupsQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.dashboard.noFollowups')}</p>
          ) : (
            <ul className="space-y-2">
              {(followupsQuery.data ?? []).map((f) => (
                <li key={f.followup_id} className="flex items-center justify-between border-b border-border-subtle pb-2 last:border-0">
                  <div>
                    <Link to={`/platform/sales/leads/${f.lead_id}`} className="font-medium text-accent-foreground hover:underline">
                      {f.business_name}
                    </Link>
                    <p className="text-sm text-text-secondary">{f.reason}</p>
                  </div>
                  <div className="text-end">
                    <FormattedDate value={f.scheduled_at} timeZone={SALES_DISPLAY_TIMEZONE} className="text-sm" />
                    {f.is_overdue && <StatusBadge tone="danger" label={t('platform.sales.dashboard.overdue')} className="mt-1" />}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function StatCard({ label, value, loading, tone }: { label: string; value?: number | string; loading: boolean; tone?: 'success' | 'warning' | 'danger' | 'neutral' }) {
  const toneClass = tone === 'danger' ? 'text-status-danger' : tone === 'warning' ? 'text-status-warning' : tone === 'success' ? 'text-status-success' : 'text-text-primary'
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-text-secondary">{label}</p>
        <p className={`text-2xl font-bold tabular-nums ${toneClass}`}>{loading ? '—' : value ?? 0}</p>
      </CardContent>
    </Card>
  )
}
