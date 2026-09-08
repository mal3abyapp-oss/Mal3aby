import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { ErrorState } from '@/components/ui/error-state'
import { EmptyState } from '@/components/ui/empty-state'
import { translateSupabaseError } from '@/lib/errors'
import { isSubscriptionExpiringSoon } from './labels'

// Platform Overview dashboard — real aggregate counts from clubs +
// platform_subscriptions, computed client-side from RLS-scoped
// (platform-owner-only) reads. No scheduled job / stored aggregate table —
// consistent with the zero-cost, derived-not-materialized approach used by
// get_club_platform_access() itself.
interface OverviewData {
  totalClubs: number
  activeClubs: number
  adminSuspendedClubs: number
  blockedAccessClubs: number
  trialCount: number
  expiringSoonCount: number
  revenueThisMonth: number
  newClubsThisMonth: number
  newLeads: number
}

async function fetchOverview(): Promise<OverviewData> {
  const [
    { data: clubs, error: clubsError },
    { data: subs, error: subsError },
    { data: payments, error: paymentsError },
    { count: newLeads, error: leadsError },
  ] = await Promise.all([
    // Controlled Commercial Launch Gate, Phase 6 follow-up: exclude QA/
    // test/demo tenant fixtures from platform-level aggregate counts by
    // default, so this dashboard reflects real business activity once
    // real tenants exist rather than being permanently inflated/skewed
    // by disposable fixtures. See QA_DATA_ISOLATION.md.
    supabase.from('clubs').select('id, status, created_at, flagged_duplicate, is_test_fixture').eq('is_test_fixture', false),
    // Production audit remediation (M-2): subscriptions and payments
    // below were the two portions of this fetch that stayed unfiltered
    // -- now both read through the same QA-fixture-excluded
    // (clubs.is_test_fixture) RPCs PlatformReportsPage uses
    // (get_platform_subscription_report / get_platform_revenue_report),
    // one reliable source of truth instead of a third, separately
    // ad hoc filtered query here.
    supabase.rpc('get_platform_subscription_report'),
    supabase.rpc('get_platform_revenue_report'),
    // contact_requests has NO club_id / club association at all (it is
    // an anonymous, pre-signup, insert-only public inbox -- see its own
    // table comment: "not a CRM") -- there is structurally no fixture to
    // exclude here, so no filter is added. Not part of the per-tenant
    // Attention Center below (Phase 7) for the same reason -- it cannot
    // be expressed as a (club, problem) row -- and stays its own
    // platform-wide card here.
    supabase.from('contact_requests').select('id', { count: 'exact', head: true }).eq('status', 'new'),
  ])

  if (clubsError) throw clubsError
  if (subsError) throw subsError
  if (paymentsError) throw paymentsError
  if (leadsError) throw leadsError

  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

  const totalClubs = clubs?.length ?? 0
  const activeClubs = clubs?.filter((c) => c.status === 'active').length ?? 0
  // Owner-level review finding (P2, terminology): this counts
  // clubs.status = 'suspended' -- an ADMINISTRATIVE action (Platform
  // Owner manually disabled the club). PlatformClubsPage separately
  // shows "حالة الاشتراك" (subscription/billing access, from
  // get_club_platform_access(): full/grace/blocked) using the SAME
  // Arabic word "موقوف" for its own 'blocked' state -- a genuinely
  // different concept computed from a different source, but
  // indistinguishable by label alone. Renamed both this field and its
  // on-screen label to "موقوفة إداريًا" to disambiguate, and added
  // blockedAccessClubs below (via the same get_club_platform_access()
  // RPC PlatformClubsPage already uses) so subscription-blocked clubs
  // -- a real "needs attention" signal -- are no longer invisible from
  // the landing dashboard.
  const adminSuspendedClubs = clubs?.filter((c) => c.status === 'suspended').length ?? 0
  const newClubsThisMonth = clubs?.filter((c) => new Date(c.created_at) >= monthStart).length ?? 0

  // Production audit remediation (M-2): get_platform_subscription_report()
  // returns full lifecycle history (Reports' Subscription tab needs
  // cancelled rows too), so the neq('cancelled') this fetch always
  // applied is now done here, client-side, on the filtered rows --
  // same as Reports' Renewal tab does for the same RPC.
  const activeSubs = subs?.filter((s) => s.lifecycle_status !== 'cancelled') ?? []
  const trialCount = activeSubs.filter((s) => s.subscription_kind === 'trial').length
  // Master IA/UX audit (Platform Owner phase): was a flat 7-day window
  // regardless of subscription kind -- now uses the same canonical
  // definition Alerts and Reports' Renewal tab both use (3 days for
  // trials, 7 for paid), so this count and those screens' lists always
  // agree on which subscriptions count as "expiring soon". See
  // isSubscriptionExpiringSoon()'s own comment in labels.ts for the
  // full audit citation.
  const expiringSoonCount = activeSubs.filter((s) => isSubscriptionExpiringSoon(s.subscription_kind, s.end_at, now)).length

  const revenueThisMonth =
    payments
      ?.filter((p) => new Date(p.recorded_at) >= monthStart)
      .reduce((sum, p) => sum + Number(p.amount), 0) ?? 0

  // Phase A directive (A3): this used to call get_club_platform_access()
  // once PER CLUB via Promise.all -- N sequential RPC round-trips on every
  // Overview load, unbounded by the (also unpaginated here) clubs query.
  // Replaced with a single batched RPC that resolves access for every club
  // ID in one round-trip. See PlatformClubsPage.tsx for the same fix.
  const clubIds = (clubs ?? []).map((c) => c.id)
  const { data: accessRows, error: accessError } =
    clubIds.length > 0
      ? await supabase.rpc('get_platform_clubs_access', { p_club_ids: clubIds })
      : { data: [] as { club_id: string; access: string; reason: string }[], error: null }
  if (accessError) throw accessError
  const blockedAccessClubs = (accessRows ?? []).filter((r) => r.access === 'blocked').length

  return {
    totalClubs,
    activeClubs,
    adminSuspendedClubs,
    blockedAccessClubs,
    trialCount,
    expiringSoonCount,
    revenueThisMonth,
    newClubsThisMonth,
    newLeads: newLeads ?? 0,
  }
}

// Platform Owner Control Plane V1, Phase 7 -- Attention Center. One row
// per (club, problem) pair from get_platform_attention_items() (see its
// own migration comment for the full architecture rationale: a single
// server-side RPC, deterministic rules, no scoring engine, QA/test-
// fixture clubs excluded throughout). Every item links DIRECTLY to that
// specific club's Tenant 360 page -- never the generic unfiltered
// /platform/clubs list the deep dive flagged as a real anti-pattern on
// the previous aggregate-card version of this panel.
interface AttentionItem {
  clubId: string
  clubName: string
  problemType: string
  severity: 'danger' | 'warning'
  detail: string | null
  contextAt: string | null
}

async function fetchAttentionItems(): Promise<AttentionItem[]> {
  const { data, error } = await supabase.rpc('get_platform_attention_items')
  if (error) throw error
  return (data ?? []).map((r) => ({
    clubId: r.club_id ?? '',
    clubName: r.club_name ?? '—',
    problemType: r.problem_type ?? '',
    severity: r.severity === 'danger' ? 'danger' : 'warning',
    detail: r.detail,
    contextAt: r.context_at,
  }))
}

// Fixed severity ordering (danger before warning) -- deliberately not a
// weighted/scored ranking, per the mission's explicit "not a
// complicated scoring engine yet" instruction. Ties within a severity
// keep the RPC's own context_at desc ordering.
const SEVERITY_ORDER: Record<AttentionItem['severity'], number> = { danger: 0, warning: 1 }

// Platform Owner Control Plane V1, Phase 6 -- Commercial Snapshot. One
// SECURITY DEFINER RPC (get_platform_commercial_snapshot(), see its own
// migration comment for the exact per-metric derivation and every
// reliability decision) returning a single row. Any metric the RPC could
// not reliably compute comes back as a real SQL NULL, never a fabricated
// 0 -- rendered here as an explicit "not yet available" state, never as
// "0", per the mission's explicit "do not fake it" constraint. Kept as
// its own query/section, deliberately not merged into fetchOverview()
// above or the Attention Center query -- this is snapshot-shaped data
// (a handful of point-in-time numbers), not a list, and the mission
// directive requires collected revenue (fetchOverview's revenueThisMonth,
// unchanged above) to stay conceptually and mechanically separate from
// MRR/ARR/outstanding here, not quietly blended into one query result.
interface CommercialSnapshot {
  payingTenants: number
  activeTrials: number
  trialsEndingSoon: number
  expiredActionRequired: number
  mrr: number
  arr: number
  outstandingAmount: number
  trialToPaidConversionRate: number | null
  trialToPaidConversionRateUnavailable: boolean
}

async function fetchCommercialSnapshot(): Promise<CommercialSnapshot | null> {
  const { data, error } = await supabase.rpc('get_platform_commercial_snapshot')
  if (error) throw error
  const row = data?.[0]
  if (!row) return null
  return {
    payingTenants: row.paying_tenants ?? 0,
    activeTrials: row.active_trials ?? 0,
    trialsEndingSoon: row.trials_ending_soon ?? 0,
    expiredActionRequired: row.expired_action_required ?? 0,
    mrr: Number(row.mrr ?? 0),
    arr: Number(row.arr ?? 0),
    outstandingAmount: Number(row.outstanding_amount ?? 0),
    trialToPaidConversionRate: row.trial_to_paid_conversion_rate === null ? null : Number(row.trial_to_paid_conversion_rate),
    trialToPaidConversionRateUnavailable: row.trial_to_paid_conversion_rate_unavailable ?? true,
  }
}

export function PlatformOverviewPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ['platform-overview'], queryFn: fetchOverview })
  const {
    data: attentionItems = [],
    isLoading: attentionLoading,
    isError: attentionIsError,
    error: attentionError,
    refetch: refetchAttention,
  } = useQuery({ queryKey: ['platform-attention-items'], queryFn: fetchAttentionItems })
  const sortedAttentionItems = [...attentionItems].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  const {
    data: snapshot,
    isLoading: snapshotLoading,
    isError: snapshotIsError,
    error: snapshotError,
    refetch: refetchSnapshot,
  } = useQuery({ queryKey: ['platform-commercial-snapshot'], queryFn: fetchCommercialSnapshot })
  const snapshotUnavailable = (v: number | null | undefined) => snapshotLoading || snapshotIsError || v === null || v === undefined
  const fmtSnapshotValue = (v: number | null | undefined) => (snapshotUnavailable(v) ? '—' : String(v))

  return (
    <div>
      <PageHeader title={t('platform.overviewPage.title')} description={t('platform.overviewPage.description')} />
      {/* PERSONA COUNCIL AUDIT (2026-08-25) -- Platform Owner persona
          finding: this query threw on any real failure inside
          fetchOverview() itself, but the render only ever destructured
          {data, isLoading} -- on a genuine error, every card silently
          fell through to its `?? 0` default and showed "0", visually
          identical to a genuinely healthy, empty platform. A Platform
          Owner reading "0 clubs need attention" had no way to tell that
          apart from "the query failed, I don't actually know." Every
          card below now also renders "—" (not "0") while isError is
          true, and this banner surfaces the real failure with a retry. */}
      {isError && (
        <ErrorState
          message={translateSupabaseError(error, t('platform.overviewPage.loadError', { defaultValue: 'Could not load the dashboard. The numbers below may be wrong or missing.' }))}
          onRetry={() => void refetch()}
          className="mb-4"
        />
      )}
      {/* Master IA/UX audit (Platform Owner phase, Audit 5) confirmed all 7
          cards here were dead-ends -- every card linked to the same
          unfiltered /platform/clubs list regardless of which was clicked.
          Phase B directive (B1): PlatformClubsPage now reads status/access/
          created query params (see its own header comment for the
          contract) -- each card below links to a genuinely filtered view
          instead of the same undifferentiated list.

          Design remediation (premium-ui-ux-audit, Platform Owner phase):
          the 7 cards previously rendered as one flat, unlabeled grid --
          a SaaS control plane's landing dashboard reads at a glance as
          "what's my tenant base, what needs commercial attention, what's
          growing", not an alphabet-soup of same-weight tiles. Split into
          two labeled groups using the exact same cards/values/links/data
          (no new fetch, no renamed field) -- Tenant Health (admin status +
          subscription access, the two genuinely different "is this club
          okay" signals per this file's own P2 comment above) and
          Commercial Signals (trials/renewals/growth, the business-motion
          numbers a platform owner reviews for growth). Pure grouping +
          heading, zero behavior change. */}
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
        {t('platform.overviewPage.groups.tenantHealth', { defaultValue: 'Tenant health' })}
      </p>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label={t('platform.overviewPage.cards.totalClubs')} value={isLoading || isError ? '—' : String(data?.totalClubs ?? 0)} to="/platform/clubs" />
        <StatCard label={t('platform.overviewPage.cards.activeClubs')} value={isLoading || isError ? '—' : String(data?.activeClubs ?? 0)} to="/platform/clubs?status=active" tone="success" />
        {/* Renamed from "أندية موقوفة" -- that label was ambiguous with
            "حالة الاشتراك: موقوف" on PlatformClubsPage, a different
            concept (subscription/billing access, not admin status).
            See blockedAccessClubs card below for that other signal. */}
        <StatCard label={t('platform.overviewPage.cards.adminSuspendedClubs')} value={isLoading || isError ? '—' : String(data?.adminSuspendedClubs ?? 0)} to="/platform/clubs?status=suspended" tone={(data?.adminSuspendedClubs ?? 0) > 0 ? 'warning' : 'default'} />
        <StatCard
          label={t('platform.overviewPage.cards.blockedAccessClubs')}
          value={isLoading || isError ? '—' : String(data?.blockedAccessClubs ?? 0)}
          to="/platform/clubs?access=blocked"
          tone={(data?.blockedAccessClubs ?? 0) > 0 ? 'danger' : 'default'}
        />
      </div>

      <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
        {t('platform.overviewPage.groups.commercialSignals', { defaultValue: 'Commercial signals' })}
      </p>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label={t('platform.overviewPage.cards.trialCount')} value={isLoading || isError ? '—' : String(data?.trialCount ?? 0)} to="/platform/trials" />
        {/* Label no longer says "(7 أيام)" -- the underlying threshold is
            now isSubscriptionExpiringSoon() (3d trial / 7d paid), not a
            flat 7 days; see labels.ts. */}
        <StatCard
          label={t('platform.overviewPage.cards.expiringSoonCount')}
          value={isLoading || isError ? '—' : String(data?.expiringSoonCount ?? 0)}
          to="/platform/alerts"
          tone={(data?.expiringSoonCount ?? 0) > 0 ? 'warning' : 'default'}
        />
        <StatCard label={t('platform.overviewPage.cards.newClubsThisMonth')} value={isLoading || isError ? '—' : String(data?.newClubsThisMonth ?? 0)} to="/platform/clubs?created=this_month" tone="success" />
      </div>

      {/* Platform Owner Control Plane V1, Phase 7: upgraded from 6
          per-METRIC-TYPE aggregate cards (each linking to the same
          generic unfiltered /platform/clubs list -- a confirmed deep-
          dive finding, PLATFORM_OWNER_DEEP_DIVE_REPORT.md Section 13)
          into a genuine per-TENANT Attention Center: one row per
          (club, problem) pair from get_platform_attention_items(),
          each linking DIRECTLY to that club's Tenant 360 page. Still
          exception-first -- hidden entirely when the list is empty,
          same as before. New leads (contact_requests) has no club_id
          at all (confirmed via schema read -- an anonymous pre-signup
          inbox, not tenant-scoped) so it cannot be expressed as a
          (club, problem) row and stays its own small platform-wide
          card alongside this list rather than inside it. */}
      {attentionLoading || attentionIsError || sortedAttentionItems.length > 0 || (data?.newLeads ?? 0) > 0 ? (
        <>
          <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
            {t('platform.overviewPage.groups.needsAttention', { defaultValue: 'Needs attention' })}
          </p>
          {attentionIsError && (
            <ErrorState
              message={translateSupabaseError(attentionError, t('platform.overviewPage.attentionLoadError', { defaultValue: 'Could not load the attention list.' }))}
              onRetry={() => void refetchAttention()}
              className="mb-4"
            />
          )}
          {!attentionIsError && (
            <div className="space-y-2">
              {sortedAttentionItems.map((item) => (
                <Link key={`${item.clubId}-${item.problemType}`} to={`/platform/clubs/${item.clubId}`} className="block">
                  <Card
                    className={
                      item.severity === 'danger'
                        ? 'border-danger/40 bg-danger/5 transition-colors hover:bg-danger/10'
                        : 'border-warning/40 bg-warning/5 transition-colors hover:bg-warning/10'
                    }
                  >
                    <CardContent className="flex items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-text-primary">
                          <bdi>{item.clubName}</bdi>
                        </p>
                        <p className="text-sm text-text-secondary">
                          {item.problemType === 'whatsapp_failures'
                            ? t(`platform.overviewPage.attentionProblems.whatsapp_failures`, {
                                defaultValue: item.problemType,
                                // The RPC reports this condition's `detail` as a raw failed-message
                                // count (see get_platform_attention_items(), condition 2), not a
                                // resource-label key like every other condition below -- it needs
                                // real i18next plural interpolation (count), not the
                                // attentionResourceLabels lookup used for the rest.
                                count: Number(item.detail ?? 0),
                              })
                            : t(`platform.overviewPage.attentionProblems.${item.problemType}`, {
                                defaultValue: item.problemType,
                                detail: item.detail
                                  ? t(`platform.overviewPage.attentionResourceLabels.${item.detail}`, { defaultValue: item.detail })
                                  : '',
                              })}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        {item.contextAt && (
                          <span className="text-xs text-text-secondary">
                            <bdi>{new Date(item.contextAt).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi>
                          </span>
                        )}
                        <StatusBadge
                          tone={item.severity as StatusTone}
                          label={t(`platform.overviewPage.attentionSeverity.${item.severity}`, { defaultValue: item.severity })}
                        />
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              ))}
              {(data?.newLeads ?? 0) > 0 && (
                <Link to="/platform/leads" className="block">
                  <Card className="border-info/40 bg-info/5 transition-colors hover:bg-info/10">
                    <CardContent className="flex items-center justify-between p-4">
                      <div>
                        <p className="font-medium text-text-primary">{t('platform.overviewPage.newLeads.title')}</p>
                        <p className="text-sm text-text-secondary">{t('platform.overviewPage.newLeads.description')}</p>
                      </div>
                      <span className="text-2xl font-semibold text-info">{data?.newLeads}</span>
                    </CardContent>
                  </Card>
                </Link>
              )}
              {attentionLoading && sortedAttentionItems.length === 0 && (
                <EmptyState title={t('platform.overviewPage.attentionLoading', { defaultValue: 'Loading attention items…' })} />
              )}
            </div>
          )}
        </>
      ) : null}

      {/* Platform Owner Control Plane V1, Phase 6 -- Commercial Snapshot.
          Plain numbers, no charts, matching the existing StatCard pattern
          used throughout this console (per the mission directive's
          explicit "no charts/graphs" instruction). Every value that came
          back null from get_platform_commercial_snapshot() renders as
          "—" via fmtSnapshotValue/snapshotUnavailable, with a one-line
          note explaining why -- never a fabricated 0. Currently only
          trial-to-paid conversion is null in practice (see the RPC's own
          migration comment for the exact schema-derived reason); every
          other metric here is reliably computable and always populated. */}
      <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
        {t('platform.overviewPage.groups.commercialSnapshot', { defaultValue: 'Commercial snapshot' })}
      </p>
      {snapshotIsError && (
        <ErrorState
          message={translateSupabaseError(snapshotError, t('platform.overviewPage.snapshotLoadError', { defaultValue: 'Could not load the commercial snapshot.' }))}
          onRetry={() => void refetchSnapshot()}
          className="mb-4"
        />
      )}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label={t('platform.overviewPage.cards.payingTenants', { defaultValue: 'Paying tenants' })}
          value={fmtSnapshotValue(snapshot?.payingTenants)}
          to="/platform/clubs"
          tone="success"
        />
        <StatCard
          label={t('platform.overviewPage.cards.activeTrials', { defaultValue: 'Active trials' })}
          value={fmtSnapshotValue(snapshot?.activeTrials)}
          to="/platform/trials"
        />
        <StatCard
          label={t('platform.overviewPage.cards.trialsEndingSoon', { defaultValue: 'Trials ending soon' })}
          value={fmtSnapshotValue(snapshot?.trialsEndingSoon)}
          to="/platform/alerts"
          tone={(snapshot?.trialsEndingSoon ?? 0) > 0 ? 'warning' : 'default'}
        />
        <StatCard
          label={t('platform.overviewPage.cards.expiredActionRequired', { defaultValue: 'Expired / action required' })}
          value={fmtSnapshotValue(snapshot?.expiredActionRequired)}
          to="/platform/clubs?access=blocked"
          tone={(snapshot?.expiredActionRequired ?? 0) > 0 ? 'danger' : 'default'}
        />
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader><CardTitle className="text-base">{t('platform.overviewPage.cards.mrr', { defaultValue: 'MRR' })}</CardTitle></CardHeader>
          <CardContent>
            {snapshotUnavailable(snapshot?.mrr) ? '—' : <MoneyDisplay amount={snapshot?.mrr ?? 0} size="lg" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t('platform.overviewPage.cards.arr', { defaultValue: 'ARR' })}</CardTitle></CardHeader>
          <CardContent>
            {snapshotUnavailable(snapshot?.arr) ? '—' : <MoneyDisplay amount={snapshot?.arr ?? 0} size="lg" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">{t('platform.overviewPage.cards.outstandingAmount', { defaultValue: 'Outstanding amount' })}</CardTitle></CardHeader>
          <CardContent>
            {snapshotUnavailable(snapshot?.outstandingAmount) ? '—' : <MoneyDisplay amount={snapshot?.outstandingAmount ?? 0} size="lg" />}
          </CardContent>
        </Card>
      </div>
      {/* Trial -> paid conversion is a genuine, documented data-model
          limitation (see the RPC migration comment), not a loading state
          -- shown as its own explicit note rather than folded into a
          StatCard's "—", so a Platform Owner can tell "not computed yet"
          apart from "still loading" or "query failed". */}
      {!snapshotLoading && !snapshotIsError && snapshot?.trialToPaidConversionRateUnavailable && (
        <p className="mt-3 text-xs text-text-secondary">
          {t('platform.overviewPage.trialConversionUnavailable', {
            defaultValue: 'Trial → paid conversion rate: not yet available (no reliable link exists between a trial and its resulting paid subscription in the current data model).',
          })}
        </p>
      )}

      {/* Design remediation: grouped under the same "Commercial signals"
          framing as the trial/renewal/growth cards above -- a bare,
          unlabeled Card previously sat disconnected below the exception
          panel with no visual link to the KPI groups it actually belongs
          with. Same data/query, presentation only. */}
      <p className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-text-secondary">
        {t('platform.overviewPage.groups.revenue', { defaultValue: 'Revenue' })}
      </p>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('platform.overviewPage.revenueThisMonth')}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading || isError ? '—' : <MoneyDisplay amount={data?.revenueThisMonth ?? 0} size="lg" />}
        </CardContent>
      </Card>
    </div>
  )
}
