// SalesDashboardPage -- Sales Intelligence Phase 19 (ADR-054). The
// landing screen for /platform/sales: summary stats, funnel, by-source
// breakdown, and pending follow-ups. Matches the established
// PlatformOverviewPage-style dashboard-card layout, extended with the
// isError/ErrorState pattern the app's own prior remediation
// established as the app-wide standard for financial/admin screens.
//
// REP-1 fix (owner brief, 2026-09-21): every reporting RPC here was
// previously all-time cumulative only -- a Platform Owner asking "how
// did we do this month" had no way to answer that. get_sales_funnel_
// stats()/get_sales_dashboard_summary() now accept an optional
// p_start_date/p_end_date (the same pattern already proven in the Shop
// module's own reports), wired to a simple local date-range filter
// (DateRangeFilter is the existing shared component, reused as-is --
// its props are plain strings, not club-scoped, so it composes cleanly
// here despite Sales Intelligence having no club/tenant concept). Also
// closed: do_not_contact leads were silently counted in total_leads/
// the 'discovered' funnel stage but invisible everywhere else --
// suppressed_count now surfaces that number honestly instead, and
// get_sales_stats_by_dimension() (fully built server-side, zero prior
// frontend call sites -- confirmed via repo-wide grep) is wired up as a
// country/city/business_type breakdown card with CSV export, reusing
// this project's own established src/lib/csv.ts utility (already used
// on 11 other report pages) rather than inventing a new one.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Download } from 'lucide-react'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import { FormattedDate } from '@/components/ui/formatted-date'
import { SALES_DISPLAY_TIMEZONE } from './salesTimeZone'
import { ListLoadingSkeleton } from './ListLoadingSkeleton'
import { DateRangeFilter } from '@/features/reports/components/DateRangeFilter'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

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
  suppressed_count: number
}

interface DimensionStat {
  dimension_value: string
  lead_count: number
  won_count: number
  [key: string]: unknown
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

interface UpcomingDemo {
  demo_id: string
  lead_id: string
  business_name: string
  scheduled_at: string
  notes: string | null
}

async function fetchSummary(startDate: string, endDate: string): Promise<DashboardSummary> {
  const { data, error } = await supabase.rpc('get_sales_dashboard_summary', { p_start_date: startDate || undefined, p_end_date: endDate || undefined })
  if (error) throw error
  return data?.[0] ?? {
    total_leads: 0, hot_leads: 0, warm_leads: 0, cold_leads: 0, contact_ready: 0,
    contacted: 0, demos_scheduled: 0, converted: 0, reply_rate: null, demo_rate: null,
    win_rate: null, avg_days_to_conversion: null, suppressed_count: 0,
  }
}

async function fetchFunnel(startDate: string, endDate: string): Promise<FunnelStage[]> {
  const { data, error } = await supabase.rpc('get_sales_funnel_stats', { p_start_date: startDate || undefined, p_end_date: endDate || undefined })
  if (error) throw error
  return data ?? []
}

async function fetchByDimension(dimension: 'country' | 'city' | 'business_type'): Promise<DimensionStat[]> {
  const { data, error } = await supabase.rpc('get_sales_stats_by_dimension', { p_dimension: dimension })
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

// PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Workstream 2 (2026-09-09):
// "Which demos are scheduled?" is one of the mission's explicit daily-
// queue questions. get_sales_dashboard_summary()'s demos_scheduled is
// only a COUNT -- this narrow read-only RPC returns the actionable list.
async function fetchUpcomingDemos(): Promise<UpcomingDemo[]> {
  const { data, error } = await supabase.rpc('get_sales_upcoming_demos', { p_limit: 10 })
  if (error) throw error
  return data ?? []
}

export function SalesDashboardPage() {
  const { t } = useTranslation()
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [dimension, setDimension] = useState<'country' | 'city' | 'business_type'>('country')

  const summaryQuery = useQuery({ queryKey: ['sales-dashboard-summary', startDate, endDate], queryFn: () => fetchSummary(startDate, endDate) })
  const funnelQuery = useQuery({ queryKey: ['sales-funnel-stats', startDate, endDate], queryFn: () => fetchFunnel(startDate, endDate) })
  const sourceQuery = useQuery({ queryKey: ['sales-stats-by-source'], queryFn: fetchBySource })
  const dimensionQuery = useQuery({ queryKey: ['sales-stats-by-dimension', dimension], queryFn: () => fetchByDimension(dimension) })
  const followupsQuery = useQuery({ queryKey: ['sales-pending-followups'], queryFn: fetchFollowups })
  const upcomingDemosQuery = useQuery({ queryKey: ['sales-upcoming-demos'], queryFn: fetchUpcomingDemos })

  const summary = summaryQuery.data

  return (
    <div className="space-y-6">
      <PageHeader title={t('platform.sales.dashboard.title')} description={t('platform.sales.dashboard.description')} />

      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />

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
          {/* REP-1 fix: do_not_contact leads were silently counted in
              total_leads but invisible everywhere else -- now excluded
              from total_leads and shown honestly as their own stat. */}
          <StatCard label={t('platform.sales.dashboard.suppressed')} value={summary?.suppressed_count} loading={summaryQuery.isLoading} tone="neutral" />
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t('platform.sales.dashboard.funnelTitle')}</CardTitle></CardHeader>
          <CardContent>
            {funnelQuery.isError ? (
              <ErrorState message={translateSupabaseError(funnelQuery.error, t('platform.sales.dashboard.loadError'))} onRetry={() => funnelQuery.refetch()} />
            ) : funnelQuery.isLoading ? (
              <ListLoadingSkeleton />
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
              <ListLoadingSkeleton />
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

      {/* REP-1 fix: get_sales_stats_by_dimension() was fully built
          server-side (permission-gated, SQL-injection-safe via a
          whitelisted format(%I) call) but had zero frontend call sites
          anywhere in this codebase -- confirmed by repo-wide grep. */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>{t('platform.sales.dashboard.byDimensionTitle')}</CardTitle>
          <div className="flex items-center gap-2">
            <Select value={dimension} onValueChange={(v) => setDimension(v as typeof dimension)}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="country">{t('platform.sales.dashboard.dimension.country')}</SelectItem>
                <SelectItem value="city">{t('platform.sales.dashboard.dimension.city')}</SelectItem>
                <SelectItem value="business_type">{t('platform.sales.dashboard.dimension.business_type')}</SelectItem>
              </SelectContent>
            </Select>
            {(dimensionQuery.data ?? []).length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadCsv(
                    `sales-by-${dimension}.csv`,
                    rowsToCsv(dimensionQuery.data ?? [], {
                      dimension_value: t(`platform.sales.dashboard.dimension.${dimension}`),
                      lead_count: t('platform.sales.dashboard.leadCount'),
                      won_count: t('platform.sales.dashboard.won'),
                    }),
                  )
                }
              >
                <Download className="me-1 size-4" />
                {t('platform.sales.dashboard.exportCsv')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {dimensionQuery.isError ? (
            <ErrorState message={translateSupabaseError(dimensionQuery.error, t('platform.sales.dashboard.loadError'))} onRetry={() => dimensionQuery.refetch()} />
          ) : dimensionQuery.isLoading ? (
            <ListLoadingSkeleton />
          ) : (dimensionQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.dashboard.noData')}</p>
          ) : (
            <ul className="space-y-2">
              {(dimensionQuery.data ?? []).map((s) => (
                <li key={s.dimension_value} className="flex items-center justify-between">
                  <span className="text-sm text-text-secondary">{s.dimension_value}</span>
                  <span className="text-sm tabular-nums">{s.lead_count} ({s.won_count} {t('platform.sales.dashboard.won')})</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.dashboard.followupsTitle')}</CardTitle></CardHeader>
        <CardContent>
          {followupsQuery.isError ? (
            <ErrorState message={translateSupabaseError(followupsQuery.error, t('platform.sales.dashboard.loadError'))} onRetry={() => followupsQuery.refetch()} />
          ) : followupsQuery.isLoading ? (
            <ListLoadingSkeleton />
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

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.dashboard.upcomingDemosTitle')}</CardTitle></CardHeader>
        <CardContent>
          {upcomingDemosQuery.isError ? (
            <ErrorState message={translateSupabaseError(upcomingDemosQuery.error, t('platform.sales.dashboard.loadError'))} onRetry={() => upcomingDemosQuery.refetch()} />
          ) : upcomingDemosQuery.isLoading ? (
            <ListLoadingSkeleton />
          ) : (upcomingDemosQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.dashboard.noUpcomingDemos')}</p>
          ) : (
            <ul className="space-y-2">
              {(upcomingDemosQuery.data ?? []).map((d) => (
                <li key={d.demo_id} className="flex items-center justify-between border-b border-border-subtle pb-2 last:border-0">
                  <div>
                    <Link to={`/platform/sales/leads/${d.lead_id}`} className="font-medium text-accent-foreground hover:underline">
                      {d.business_name}
                    </Link>
                    {d.notes && <p className="text-sm text-text-secondary">{d.notes}</p>}
                  </div>
                  <FormattedDate value={d.scheduled_at} timeZone={SALES_DISPLAY_TIMEZONE} className="text-sm" />
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
