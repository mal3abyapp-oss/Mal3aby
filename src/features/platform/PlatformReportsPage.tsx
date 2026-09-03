import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { MoneyDisplay } from '@/components/ui/money-display'
import { StatusBadge } from '@/components/ui/status-badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LIFECYCLE_STATUS_LABELS, CLUB_STATUS_LABELS, isSubscriptionExpiringSoon } from './labels'

// Five report types per IMPLEMENTATION_PLAN.md Phase 3c: Subscription,
// Revenue, Renewal, Growth, Usage. All read live from Phase 3b/2 tables --
// no stored aggregate, no mock data.
//
// IA restructuring (Phase 3): two real findings from
// MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md fixed here --
// (1) Growth tab rendered clubs.status completely raw ("active"/
// "suspended"/"closed") instead of through a label map, the only tab
// in this file that skipped that step; (2) zero row-to-club links
// existed across all 5 tabs despite every tab being club-keyed --
// "the single largest dead-end in the Platform Owner tier" per the
// audit. Club name is now a link into PlatformClubDetailPage on every
// tab where a club_id is actually available (Subscription/Renewal/
// Growth/Usage -- Revenue is payment-level with no club_id in its
// current query, a separate, real gap logged in the target IA's
// out-of-scope list rather than papered over here).

interface SubRow {
  club_id: string
  club_name: string
  plan_name_snapshot: string | null
  lifecycle_status: string
  start_at: string
  end_at: string
  price_snapshot: number
}

async function fetchSubscriptionReport(): Promise<SubRow[]> {
  // Production audit remediation (M-2): now reads through
  // get_platform_subscription_report(), a QA-fixture-excluded
  // (clubs.is_test_fixture) server-side RPC, instead of an unfiltered
  // direct platform_subscriptions query.
  const { data, error } = await supabase.rpc('get_platform_subscription_report')
  if (error) throw error
  return (data ?? []).map((r) => ({
    club_id: r.club_id,
    club_name: r.club_name ?? '—',
    plan_name_snapshot: r.plan_name_snapshot,
    lifecycle_status: r.lifecycle_status,
    start_at: r.start_at,
    end_at: r.end_at,
    price_snapshot: Number(r.price_snapshot),
  }))
}

interface RevenueRow {
  month: string
  method: string
  amount: number
  clubId: string | null
  clubName: string | null
}

interface RevenueMonthTotal {
  monthKey: string
  monthLabel: string
  total: number
}

// FINAL PRODUCT COMPLETENESS ROUND (2026-08-25) -- Platform Owner
// persona: the earlier persona council report found this tab had "no
// club_id in its query" and no per-club drill-down. Confirmed live
// against the real schema that platform_payments genuinely has no
// club_id column, but it does carry platform_invoice_id, and
// platform_invoices genuinely has club_id -- a real, safe join, not an
// invented one. No new financial subsystem, no accounting-semantics
// change: same rows, same amounts, same reversed_at filter as before,
// just with club identity attached via the join Postgres/PostgREST
// already supports for a real FK. (Production currently has 0 real
// platform_payments rows -- this fix is correct-by-construction for
// when real platform billing starts, not something that changes
// today's empty state.)
async function fetchRevenueReport(locale: 'ar' | 'en'): Promise<{ rows: RevenueRow[]; monthlyTotals: RevenueMonthTotal[] }> {
  // Production audit remediation (M-2): now reads through
  // get_platform_revenue_report(), a QA-fixture-excluded
  // (clubs.is_test_fixture) server-side RPC, instead of an unfiltered
  // direct platform_payments -> platform_invoices -> clubs embed (a
  // client-side filter could not have excluded fixtures here anyway --
  // PostgREST embed filters shape the embedded object, not the outer
  // row).
  const { data, error } = await supabase.rpc('get_platform_revenue_report')
  if (error) throw error

  const rows = (data ?? []).map((r) => {
    return {
      month: new Date(r.recorded_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG', { year: 'numeric', month: 'long' }),
      method: r.method,
      amount: Number(r.amount),
      clubId: r.club_id ?? null,
      clubName: r.club_name ?? null,
    }
  })

  // Phase G directive (G1): the Revenue tab showed raw per-payment rows
  // with no actual monthly aggregate, despite implying one -- a real gap
  // confirmed by the live audit. Definition: sum of non-reversed
  // platform_payments.amount, grouped by calendar month of recorded_at
  // (the same non-reversed filter Overview's revenueThisMonth already
  // uses, just bucketed across all months instead of only the current
  // one). No fake/derived metric invented -- this is exactly the same
  // underlying rows, just grouped.
  const totalsByKey = new Map<string, { label: string; total: number; sortKey: string }>()
  for (const r of data ?? []) {
    const d = new Date(r.recorded_at)
    const sortKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG', { year: 'numeric', month: 'long' })
    const existing = totalsByKey.get(sortKey)
    totalsByKey.set(sortKey, { label, sortKey, total: (existing?.total ?? 0) + Number(r.amount) })
  }
  const monthlyTotals = Array.from(totalsByKey.values())
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .map((v) => ({ monthKey: v.sortKey, monthLabel: v.label, total: v.total }))

  return { rows, monthlyTotals }
}

async function fetchRenewalReport() {
  // Production audit remediation (M-2): now reads through the same
  // get_platform_subscription_report() RPC the Subscription tab uses
  // (QA-fixture-excluded via clubs.is_test_fixture), instead of an
  // unfiltered direct platform_subscriptions query. The RPC returns all
  // lifecycle statuses (Subscription tab needs full history including
  // cancelled); the neq('cancelled') and order-by-end_at this tab
  // always applied are kept here, client-side, on the filtered rows.
  const { data, error } = await supabase.rpc('get_platform_subscription_report')
  if (error) throw error
  const now = new Date()
  return (data ?? [])
    .filter((r) => r.lifecycle_status !== 'cancelled')
    .sort((a, b) => new Date(a.end_at).getTime() - new Date(b.end_at).getTime())
    .map((r) => {
      const end = new Date(r.end_at)
      const daysLeft = Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
      return {
        club_id: r.club_id,
        club_name: r.club_name ?? '—',
        subscription_kind: r.subscription_kind,
        end_at: r.end_at,
        daysLeft,
        // Master IA/UX audit (Platform Owner phase): now uses the same
        // canonical isSubscriptionExpiringSoon() Overview and Alerts use
        // (trial:3d / paid:7d), instead of this tab's own flat 7-day
        // bucketing with no trial distinction -- so a subscription never
        // shows "expiring soon" here while Alerts/Overview disagree.
        expiringSoon: isSubscriptionExpiringSoon(r.subscription_kind, r.end_at, now),
      }
    })
}

async function fetchGrowthReport(locale: 'ar' | 'en') {
  // Production audit remediation (M-2): now reads through
  // get_platform_growth_report(), a QA-fixture-excluded
  // (clubs.is_test_fixture) server-side RPC, instead of an unfiltered
  // direct clubs query.
  const { data, error } = await supabase.rpc('get_platform_growth_report')
  if (error) throw error
  const rows = (data ?? []).map((r) => ({ id: r.club_id, name_ar: r.club_name, status: r.status, created_at: r.created_at }))

  // Phase G directive (G3): Growth tab was just a raw club list with no
  // actual growth/trend metric -- add real time-grouping (new clubs per
  // calendar month of created_at) above the existing raw list.
  const countsByKey = new Map<string, { label: string; count: number; sortKey: string }>()
  for (const c of rows) {
    const d = new Date(c.created_at)
    const sortKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    const label = d.toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG', { year: 'numeric', month: 'long' })
    const existing = countsByKey.get(sortKey)
    countsByKey.set(sortKey, { label, sortKey, count: (existing?.count ?? 0) + 1 })
  }
  const monthlyNewClubs = Array.from(countsByKey.values())
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .map((v) => ({ monthKey: v.sortKey, monthLabel: v.label, count: v.count }))

  return { rows, monthlyNewClubs }
}

async function fetchUsageReport() {
  // Production audit remediation (M-2): now reads through
  // get_platform_usage_report(), a QA-fixture-excluded
  // (clubs.is_test_fixture) server-side RPC that aggregates
  // branch/staff counts server-side, instead of three unfiltered
  // direct queries (clubs, branches, club_memberships) aggregated
  // client-side.
  const { data, error } = await supabase.rpc('get_platform_usage_report')
  if (error) throw error

  return (data ?? []).map((c) => ({
    club_id: c.club_id,
    club_name: c.club_name,
    branchCount: Number(c.branch_count ?? 0),
    staffCount: Number(c.staff_count ?? 0),
  }))
}

export function PlatformReportsPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { data: subReport = [], isLoading: subLoading } = useQuery({ queryKey: ['report-subscriptions'], queryFn: fetchSubscriptionReport })
  const { data: revenueReport, isLoading: revenueLoading } = useQuery({ queryKey: ['report-revenue', locale], queryFn: () => fetchRevenueReport(locale) })
  const revenueRows = revenueReport?.rows ?? []
  const monthlyTotals = revenueReport?.monthlyTotals ?? []
  const { data: renewalReport = [], isLoading: renewalLoading } = useQuery({ queryKey: ['report-renewals'], queryFn: fetchRenewalReport })
  const { data: growthReport, isLoading: growthLoading } = useQuery({ queryKey: ['report-growth', locale], queryFn: () => fetchGrowthReport(locale) })
  const growthRows = growthReport?.rows ?? []
  const monthlyNewClubs = growthReport?.monthlyNewClubs ?? []
  const { data: usageReport = [], isLoading: usageLoading } = useQuery({ queryKey: ['report-usage'], queryFn: fetchUsageReport })

  const subColumns: DataTableColumn<SubRow>[] = [
    {
      key: 'club',
      header: t('platform.reportsPage.subscriptionColumns.club'),
      render: (r) => (
        <Link to={`/platform/clubs/${r.club_id}`} className="text-accent-foreground hover:underline">
          {r.club_name}
        </Link>
      ),
    },
    { key: 'plan', header: t('platform.reportsPage.subscriptionColumns.plan'), render: (r) => r.plan_name_snapshot ?? '—' },
    {
      key: 'status',
      header: t('platform.reportsPage.subscriptionColumns.status'),
      render: (r) =>
        t(`platform.reportsPage.lifecycleStatusLabels.${r.lifecycle_status}`, {
          defaultValue: LIFECYCLE_STATUS_LABELS[r.lifecycle_status] ?? r.lifecycle_status,
        }),
    },
    { key: 'start', header: t('platform.reportsPage.subscriptionColumns.start'), render: (r) => new Date(r.start_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
    { key: 'end', header: t('platform.reportsPage.subscriptionColumns.end'), render: (r) => new Date(r.end_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
    { key: 'price', header: t('platform.reportsPage.subscriptionColumns.price'), render: (r) => <MoneyDisplay amount={r.price_snapshot} size="sm" /> },
  ]

  const revenueColumns: DataTableColumn<RevenueRow>[] = [
    { key: 'month', header: t('platform.reportsPage.revenueColumns.month'), render: (r) => r.month },
    {
      key: 'club',
      header: t('platform.reportsPage.revenueColumns.club'),
      render: (r) =>
        r.clubId ? (
          <Link to={`/platform/clubs/${r.clubId}`} className="text-accent-foreground hover:underline">
            {r.clubName ?? r.clubId}
          </Link>
        ) : (
          '—'
        ),
    },
    { key: 'method', header: t('platform.reportsPage.revenueColumns.method'), render: (r) => t(`common.paymentMethodLabels.${r.method}`, { defaultValue: r.method }) },
    { key: 'amount', header: t('platform.reportsPage.revenueColumns.amount'), render: (r) => <MoneyDisplay amount={r.amount} size="sm" /> },
  ]

  const renewalColumns: DataTableColumn<(typeof renewalReport)[number]>[] = [
    {
      key: 'club',
      header: t('platform.reportsPage.renewalColumns.club'),
      render: (r) => (
        <Link to={`/platform/clubs/${r.club_id}`} className="text-accent-foreground hover:underline">
          {r.club_name}
        </Link>
      ),
    },
    { key: 'end', header: t('platform.reportsPage.renewalColumns.end'), render: (r) => new Date(r.end_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
    {
      key: 'status',
      header: t('platform.reportsPage.renewalColumns.status'),
      render: (r) =>
        r.daysLeft < 0 ? (
          <StatusBadge tone="danger" label={t('platform.reportsPage.statusExpired')} />
        ) : r.expiringSoon ? (
          <StatusBadge tone="warning" label={t('platform.reportsPage.daysLeftPlural', { count: r.daysLeft })} />
        ) : (
          <StatusBadge tone="success" label={t('platform.reportsPage.daysLeftSingular', { count: r.daysLeft })} />
        ),
    },
  ]

  const growthColumns: DataTableColumn<(typeof growthRows)[number]>[] = [
    {
      key: 'club',
      header: t('platform.reportsPage.growthColumns.club'),
      render: (r) => (
        <Link to={`/platform/clubs/${r.id}`} className="text-accent-foreground hover:underline">
          {r.name_ar}
        </Link>
      ),
    },
    {
      key: 'status',
      header: t('platform.reportsPage.growthColumns.status'),
      render: (r) =>
        t(`platform.ownersPage.clubStatusLabels.${r.status}`, { defaultValue: CLUB_STATUS_LABELS[r.status] ?? r.status }),
    },
    { key: 'created', header: t('platform.reportsPage.growthColumns.created'), render: (r) => new Date(r.created_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
  ]

  const usageColumns: DataTableColumn<(typeof usageReport)[number]>[] = [
    {
      key: 'club',
      header: t('platform.reportsPage.usageColumns.club'),
      render: (r) => (
        <Link to={`/platform/clubs/${r.club_id}`} className="text-accent-foreground hover:underline">
          {r.club_name}
        </Link>
      ),
    },
    { key: 'branches', header: t('platform.reportsPage.usageColumns.branches'), render: (r) => r.branchCount },
    { key: 'staff', header: t('platform.reportsPage.usageColumns.staff'), render: (r) => r.staffCount },
  ]

  return (
    <div>
      <PageHeader title={t('platform.reportsPage.title')} description={t('platform.reportsPage.description')} />
      <Tabs defaultValue="subscription">
        <TabsList>
          <TabsTrigger value="subscription">{t('platform.reportsPage.tabs.subscription')}</TabsTrigger>
          <TabsTrigger value="revenue">{t('platform.reportsPage.tabs.revenue')}</TabsTrigger>
          <TabsTrigger value="renewal">{t('platform.reportsPage.tabs.renewal')}</TabsTrigger>
          <TabsTrigger value="growth">{t('platform.reportsPage.tabs.growth')}</TabsTrigger>
          <TabsTrigger value="usage">{t('platform.reportsPage.tabs.usage')}</TabsTrigger>
        </TabsList>
        <TabsContent value="subscription">
          <DataTable columns={subColumns} rows={subReport} rowKey={(r) => `${r.club_id}-${r.start_at}`} isLoading={subLoading} emptyTitle={t('platform.reportsPage.emptyTitle')} />
        </TabsContent>
        <TabsContent value="revenue">
          {/* Phase G directive (G1): real monthly aggregation, added
              above the existing raw-payment table (kept for
              transaction-level detail/audit) rather than replacing it. */}
          {monthlyTotals.length > 0 && (
            <div className="mb-4 grid gap-3 sm:grid-cols-2 md:grid-cols-3">
              {monthlyTotals.map((m) => (
                <div key={m.monthKey} className="rounded-lg border border-border p-3">
                  <p className="text-sm text-text-secondary">{m.monthLabel}</p>
                  <MoneyDisplay amount={m.total} size="md" />
                </div>
              ))}
            </div>
          )}
          <DataTable
            columns={revenueColumns}
            rows={revenueRows}
            rowKey={(r) => `${r.month}-${r.method}-${r.amount}`}
            isLoading={revenueLoading}
            emptyTitle={t('platform.reportsPage.emptyTitle')}
          />
        </TabsContent>
        <TabsContent value="renewal">
          <DataTable columns={renewalColumns} rows={renewalReport} rowKey={(r) => `${r.club_id}-${r.end_at}`} isLoading={renewalLoading} emptyTitle={t('platform.reportsPage.emptyTitle')} />
        </TabsContent>
        <TabsContent value="growth">
          {monthlyNewClubs.length > 0 && (
            <div className="mb-4 grid gap-3 sm:grid-cols-2 md:grid-cols-3">
              {monthlyNewClubs.map((m) => (
                <div key={m.monthKey} className="rounded-lg border border-border p-3">
                  <p className="text-sm text-text-secondary">{m.monthLabel}</p>
                  <p className="text-lg font-semibold tabular-nums">{t('platform.reportsPage.newClubsCount', { count: m.count })}</p>
                </div>
              ))}
            </div>
          )}
          <DataTable columns={growthColumns} rows={growthRows} rowKey={(r) => r.id} isLoading={growthLoading} emptyTitle={t('platform.reportsPage.emptyTitle')} />
        </TabsContent>
        <TabsContent value="usage">
          <DataTable columns={usageColumns} rows={usageReport} rowKey={(r) => r.club_id} isLoading={usageLoading} emptyTitle={t('platform.reportsPage.emptyTitle')} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
