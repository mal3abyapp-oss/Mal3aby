import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { UserPlus, ClipboardList, CheckSquare } from 'lucide-react'
import { fetchInvoicePaymentSummaries } from '@/lib/domain/billing'

// Section I1 — Academy Overview: the metrics a manager/academy_manager
// needs at a glance without opening Players/Structure/Enrollments
// individually -- sessions today, attendance incomplete, active
// players, active subscriptions, expiring soon, outstanding academy
// invoices, groups near capacity. Quick actions route straight into
// the relevant tab/flow.
interface OverviewData {
  sessionsToday: number
  sessionsUnmarked: number
  activePlayers: number
  activeSubscriptions: number
  expiringSoon: number
  outstandingCount: number
  groupsNearCapacity: { id: string; name: string; enrolled: number; capacity: number }[]
}

async function fetchOverview(clubId: string): Promise<OverviewData> {
  const today = new Date().toISOString().slice(0, 10)
  const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const [sessionsRes, activePlayersRes, activeSubsRes, expiringRes, groupsRes] = await Promise.all([
    supabase.from('training_sessions').select('id').eq('club_id', clubId).eq('session_date', today),
    supabase.from('players').select('id', { count: 'exact', head: true }).eq('club_id', clubId).eq('status', 'active'),
    supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('club_id', clubId).eq('status', 'active'),
    supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('club_id', clubId).eq('status', 'active').gte('end_date', today).lte('end_date', in3Days),
    supabase.from('groups').select('id, name, capacity').eq('club_id', clubId).eq('status', 'active'),
  ])

  const sessionIds = (sessionsRes.data ?? []).map((s) => s.id)
  let sessionsUnmarked = 0
  if (sessionIds.length > 0) {
    const { data: attendanceRows } = await supabase.from('attendance').select('session_id').in('session_id', sessionIds)
    const markedSessionIds = new Set((attendanceRows ?? []).map((a) => a.session_id))
    sessionsUnmarked = sessionIds.filter((id) => !markedSessionIds.has(id)).length
  }

  // Outstanding academy invoices: invoices whose items reference a
  // subscription and aren't fully paid. Master Payment Directive task
  // #81: was `paid < total` computed from a local payment_allocations
  // sum, missing refund netting -- a subscription invoice paid in full
  // then refunded was silently NOT counted as outstanding. Now reads
  // get_invoice_payment_summary(), the single source of truth (see
  // AUTONOMOUS_DECISION_LOG.md D-015).
  const { data: subInvoices } = await supabase
    .from('invoice_items')
    .select('invoice_id')
    .eq('reference_type', 'subscription')
  const subInvoiceIds = [...new Set((subInvoices ?? []).map((i) => i.invoice_id))]
  let outstandingCount = 0
  if (subInvoiceIds.length > 0) {
    const { data: invoices } = await supabase
      .from('invoices')
      .select('id')
      .eq('club_id', clubId)
      .in('id', subInvoiceIds)
    if (invoices && invoices.length > 0) {
      const summaries = await fetchInvoicePaymentSummaries(invoices.map((i) => i.id))
      outstandingCount = [...summaries.values()].filter((s) => s.outstanding > 0).length
    }
  }

  const groupIds = (groupsRes.data ?? []).map((g) => g.id)
  const enrolledCounts = new Map<string, number>()
  if (groupIds.length > 0) {
    const { data: enrollments } = await supabase.from('enrollments').select('group_id').in('group_id', groupIds).eq('status', 'active')
    for (const e of enrollments ?? []) {
      enrolledCounts.set(e.group_id, (enrolledCounts.get(e.group_id) ?? 0) + 1)
    }
  }
  const groupsNearCapacity = (groupsRes.data ?? [])
    .map((g) => ({ id: g.id, name: g.name, enrolled: enrolledCounts.get(g.id) ?? 0, capacity: g.capacity }))
    .filter((g) => g.capacity > 0 && g.enrolled / g.capacity >= 0.85)

  return {
    sessionsToday: sessionIds.length,
    sessionsUnmarked,
    activePlayers: activePlayersRes.count ?? 0,
    activeSubscriptions: activeSubsRes.count ?? 0,
    expiringSoon: expiringRes.count ?? 0,
    outstandingCount,
    groupsNearCapacity,
  }
}

export function AcademyOverview({ onNavigateTab }: { onNavigateTab: (tab: 'players' | 'memberships' | 'attendance') => void }) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()

  const { data, isLoading } = useQuery({
    queryKey: ['academy-overview', currentClubId],
    queryFn: () => fetchOverview(currentClubId!),
    enabled: !!currentClubId,
  })

  if (isLoading || !data) return <p className="mt-4 text-sm text-text-secondary">{t('academy.loading')}</p>

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onNavigateTab('players')}>
          <UserPlus className="size-4" /> {t('academy.overview.addPlayer')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onNavigateTab('memberships')}>
          <ClipboardList className="size-4" /> {t('academy.overview.enrollInGroup')}
        </Button>
        <Button size="sm" variant="outline" onClick={() => onNavigateTab('attendance')}>
          <CheckSquare className="size-4" /> {t('academy.overview.markAttendance')}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard label={t('academy.overview.sessionsToday')} value={data.sessionsToday} />
        <StatCard label={t('academy.overview.sessionsUnmarked')} value={data.sessionsUnmarked} tone={data.sessionsUnmarked > 0 ? 'warning' : 'default'} />
        <StatCard label={t('academy.overview.activePlayers')} value={data.activePlayers} />
        <StatCard label={t('academy.overview.activeSubscriptions')} value={data.activeSubscriptions} tone="success" />
        <StatCard label={t('academy.overview.expiringSoon')} value={data.expiringSoon} tone={data.expiringSoon > 0 ? 'warning' : 'default'} />
        <StatCard label={t('academy.overview.outstandingInvoices')} value={data.outstandingCount} tone={data.outstandingCount > 0 ? 'danger' : 'default'} />
      </div>

      {data.groupsNearCapacity.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">{t('academy.overview.groupsNearCapacity')}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2">
            {data.groupsNearCapacity.map((g) => (
              <button
                key={g.id}
                onClick={() => onNavigateTab('memberships')}
                className="flex items-center justify-between rounded-md border border-border p-2.5 text-start text-sm hover:bg-muted/40"
              >
                <span>{g.name}</span>
                {/* Same RTL digit-swap risk as StatCard's composite
                    values (owner-level review finding) -- isolates this
                    ratio's bidi direction from the surrounding Arabic
                    context. */}
                <span className="tabular-nums font-medium"><bdi>{g.enrolled}/{g.capacity}</bdi></span>
              </button>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
