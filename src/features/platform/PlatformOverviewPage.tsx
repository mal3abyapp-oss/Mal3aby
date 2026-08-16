import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

// Platform Overview dashboard — real aggregate counts from clubs +
// platform_subscriptions, computed client-side from RLS-scoped
// (platform-owner-only) reads. No scheduled job / stored aggregate table —
// consistent with the zero-cost, derived-not-materialized approach used by
// get_club_platform_access() itself.
interface OverviewData {
  totalClubs: number
  activeClubs: number
  suspendedClubs: number
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
  const soon = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)

  const totalClubs = clubs?.length ?? 0
  const activeClubs = clubs?.filter((c) => c.status === 'active').length ?? 0
  const suspendedClubs = clubs?.filter((c) => c.status === 'suspended').length ?? 0
  const newClubsThisMonth = clubs?.filter((c) => new Date(c.created_at) >= monthStart).length ?? 0

  const trialCount = subs?.filter((s) => s.subscription_kind === 'trial').length ?? 0
  const expiringSoonCount =
    subs?.filter((s) => {
      const end = new Date(s.end_at)
      return end >= now && end <= soon
    }).length ?? 0

  const revenueThisMonth =
    payments
      ?.filter((p) => new Date(p.recorded_at) >= monthStart)
      .reduce((sum, p) => sum + Number(p.amount), 0) ?? 0

  return {
    totalClubs,
    activeClubs,
    suspendedClubs,
    trialCount,
    expiringSoonCount,
    revenueThisMonth,
    newClubsThisMonth,
    pendingUpgradeRequests: pendingUpgradeRequests ?? 0,
    newLeads: newLeads ?? 0,
  }
}

export function PlatformOverviewPage() {
  const { data, isLoading } = useQuery({ queryKey: ['platform-overview'], queryFn: fetchOverview })

  return (
    <div>
      <PageHeader title="نظرة عامة" description="ملخص أداء المنصة" />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard label="إجمالي الأندية" value={isLoading ? '—' : String(data?.totalClubs ?? 0)} />
        <StatCard label="أندية نشطة" value={isLoading ? '—' : String(data?.activeClubs ?? 0)} />
        <StatCard label="أندية موقوفة" value={isLoading ? '—' : String(data?.suspendedClubs ?? 0)} />
        <StatCard label="تجارب مجانية نشطة" value={isLoading ? '—' : String(data?.trialCount ?? 0)} />
        <StatCard label="اشتراكات تنتهي قريبًا (7 أيام)" value={isLoading ? '—' : String(data?.expiringSoonCount ?? 0)} />
        <StatCard label="أندية جديدة هذا الشهر" value={isLoading ? '—' : String(data?.newClubsThisMonth ?? 0)} />
      </div>

      {/* Gate 13 #56: pending action items were invisible platform-wide --
          an upgrade request only surfaced by opening that exact club's
          detail page, and new leads only by opening the Leads page. Both
          need a single glance from the landing dashboard, so they're
          shown here as actionable links, not duplicated lists. */}
      {!isLoading && ((data?.pendingUpgradeRequests ?? 0) > 0 || (data?.newLeads ?? 0) > 0) && (
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          {(data?.pendingUpgradeRequests ?? 0) > 0 && (
            <Link to="/platform/clubs" className="block">
              <Card className="border-warning/40 bg-warning/5 transition-colors hover:bg-warning/10">
                <CardContent className="flex items-center justify-between p-4">
                  <div>
                    <p className="font-medium text-text-primary">طلبات ترقية بانتظار المراجعة</p>
                    <p className="text-sm text-text-secondary">افتح صفحة النادي المعني من قائمة الأندية لمراجعتها</p>
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
                    <p className="font-medium text-text-primary">طلبات تواصل جديدة</p>
                    <p className="text-sm text-text-secondary">انتقل إلى طلبات التواصل لمتابعتها</p>
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
          <CardTitle className="text-base">الإيرادات المحصّلة هذا الشهر</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? '—' : <MoneyDisplay amount={data?.revenueThisMonth ?? 0} size="lg" />}
        </CardContent>
      </Card>
    </div>
  )
}
