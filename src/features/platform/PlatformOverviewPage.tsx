import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  noSubscriptionClubs: number
  trialCount: number
  expiringSoonCount: number
  revenueThisMonth: number
  newClubsThisMonth: number
  pendingUpgradeRequests: number
  newLeads: number
}

async function fetchOverview(): Promise<OverviewData> {
  const [
    { data: clubs, error: clubsError },
    { data: subs, error: subsError },
    { data: payments, error: paymentsError },
    { count: pendingUpgradeRequests, error: upgradeError },
    { count: newLeads, error: leadsError },
  ] = await Promise.all([
    supabase.from('clubs').select('id, status, created_at'),
    supabase
      .from('platform_subscriptions')
      .select('id, club_id, subscription_kind, lifecycle_status, end_at')
      .neq('lifecycle_status', 'cancelled'),
    supabase
      .from('platform_payments')
      .select('amount, recorded_at')
      .is('reversed_at', null),
    supabase.from('commercial_upgrade_requests').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('contact_requests').select('id', { count: 'exact', head: true }).eq('status', 'new'),
  ])

  if (clubsError) throw clubsError
  if (subsError) throw subsError
  if (paymentsError) throw paymentsError
  if (upgradeError) throw upgradeError
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

  const trialCount = subs?.filter((s) => s.subscription_kind === 'trial').length ?? 0
  // Master IA/UX audit (Platform Owner phase): was a flat 7-day window
  // regardless of subscription kind -- now uses the same canonical
  // definition Alerts and Reports' Renewal tab both use (3 days for
  // trials, 7 for paid), so this count and those screens' lists always
  // agree on which subscriptions count as "expiring soon". See
  // isSubscriptionExpiringSoon()'s own comment in labels.ts for the
  // full audit citation.
  const expiringSoonCount =
    subs?.filter((s) => isSubscriptionExpiringSoon(s.subscription_kind, s.end_at, now)).length ?? 0

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
  const noSubscriptionClubs = (accessRows ?? []).filter((r) => r.reason === 'no_subscription').length

  return {
    totalClubs,
    activeClubs,
    adminSuspendedClubs,
    blockedAccessClubs,
    noSubscriptionClubs,
    trialCount,
    expiringSoonCount,
    revenueThisMonth,
    newClubsThisMonth,
    pendingUpgradeRequests: pendingUpgradeRequests ?? 0,
    newLeads: newLeads ?? 0,
  }
}

export function PlatformOverviewPage() {
  const { t } = useTranslation()
  const { data, isLoading } = useQuery({ queryKey: ['platform-overview'], queryFn: fetchOverview })

  return (
    <div>
      <PageHeader title={t('platform.overviewPage.title')} description={t('platform.overviewPage.description')} />
      {/* Master IA/UX audit (Platform Owner phase, Audit 5) confirmed all 7
          cards here were dead-ends -- every card linked to the same
          unfiltered /platform/clubs list regardless of which was clicked.
          Phase B directive (B1): PlatformClubsPage now reads status/access/
          created query params (see its own header comment for the
          contract) -- each card below links to a genuinely filtered view
          instead of the same undifferentiated list. */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label={t('platform.overviewPage.cards.totalClubs')} value={isLoading ? '—' : String(data?.totalClubs ?? 0)} to="/platform/clubs" />
        <StatCard label={t('platform.overviewPage.cards.activeClubs')} value={isLoading ? '—' : String(data?.activeClubs ?? 0)} to="/platform/clubs?status=active" />
        {/* Renamed from "أندية موقوفة" -- that label was ambiguous with
            "حالة الاشتراك: موقوف" on PlatformClubsPage, a different
            concept (subscription/billing access, not admin status).
            See blockedAccessClubs card below for that other signal. */}
        <StatCard label={t('platform.overviewPage.cards.adminSuspendedClubs')} value={isLoading ? '—' : String(data?.adminSuspendedClubs ?? 0)} to="/platform/clubs?status=suspended" />
        <StatCard
          label={t('platform.overviewPage.cards.blockedAccessClubs')}
          value={isLoading ? '—' : String(data?.blockedAccessClubs ?? 0)}
          to="/platform/clubs?access=blocked"
        />
        <StatCard label={t('platform.overviewPage.cards.trialCount')} value={isLoading ? '—' : String(data?.trialCount ?? 0)} to="/platform/trials" />
        {/* Label no longer says "(7 أيام)" -- the underlying threshold is
            now isSubscriptionExpiringSoon() (3d trial / 7d paid), not a
            flat 7 days; see labels.ts. */}
        <StatCard
          label={t('platform.overviewPage.cards.expiringSoonCount')}
          value={isLoading ? '—' : String(data?.expiringSoonCount ?? 0)}
          to="/platform/alerts"
        />
        <StatCard label={t('platform.overviewPage.cards.newClubsThisMonth')} value={isLoading ? '—' : String(data?.newClubsThisMonth ?? 0)} to="/platform/clubs?created=this_month" />
      </div>

      {/* Gate 13 #56: pending action items were invisible platform-wide --
          an upgrade request only surfaced by opening that exact club's
          detail page, and new leads only by opening the Leads page. Both
          need a single glance from the landing dashboard, so they're
          shown here as actionable links, not duplicated lists. */}
      {!isLoading &&
        ((data?.pendingUpgradeRequests ?? 0) > 0 ||
          (data?.newLeads ?? 0) > 0 ||
          (data?.noSubscriptionClubs ?? 0) > 0) && (
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          {/* Phase A/B directive: the audit found a real club with zero
              platform_subscriptions rows -- get_club_platform_access()
              correctly failed closed to 'blocked', but that state was
              indistinguishable from any other blocked club (grace expired,
              cancelled, etc). get_platform_clubs_access() now returns a
              machine-readable `reason`, so this real data-integrity gap is
              a distinct, actionable exception instead of an invisible one. */}
          {(data?.noSubscriptionClubs ?? 0) > 0 && (
            <Link to="/platform/clubs?reason=no_subscription" className="block">
              <Card className="border-danger/40 bg-danger/5 transition-colors hover:bg-danger/10">
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="font-medium text-text-primary">{t('platform.overviewPage.noSubscriptionClubs.title')}</p>
                    <p className="text-sm text-text-secondary">{t('platform.overviewPage.noSubscriptionClubs.description')}</p>
                  </div>
                  <span className="text-2xl font-semibold text-danger">{data?.noSubscriptionClubs}</span>
                </CardContent>
              </Card>
            </Link>
          )}
          {(data?.pendingUpgradeRequests ?? 0) > 0 && (
            <Link to="/platform/clubs" className="block">
              <Card className="border-warning/40 bg-warning/5 transition-colors hover:bg-warning/10">
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="font-medium text-text-primary">{t('platform.overviewPage.pendingUpgradeRequests.title')}</p>
                    <p className="text-sm text-text-secondary">{t('platform.overviewPage.pendingUpgradeRequests.description')}</p>
                  </div>
                  <span className="text-2xl font-semibold text-warning">{data?.pendingUpgradeRequests}</span>
                </CardContent>
              </Card>
            </Link>
          )}
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
        </div>
      )}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">{t('platform.overviewPage.revenueThisMonth')}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? '—' : <MoneyDisplay amount={data?.revenueThisMonth ?? 0} size="lg" />}
        </CardContent>
      </Card>
    </div>
  )
}
