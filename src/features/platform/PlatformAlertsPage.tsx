import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { StatusBadge } from '@/components/ui/status-badge'
import { Card, CardContent } from '@/components/ui/card'
import { AlertTriangle, Clock, Sparkles, XCircle } from 'lucide-react'
import { isSubscriptionExpiringSoon } from './labels'

// Rule-based in-app alerts, computed live from platform_subscriptions --
// no external notification service (see IMPLEMENTATION_PLAN.md Phase 3c:
// "rule-based, no external notification service").
interface AlertItem {
  id: string
  clubId: string
  clubName: string
  kind: 'expiring_soon' | 'overdue_grace' | 'trial_ending' | 'no_subscription'
  daysLeft: number | null
}

async function fetchAlerts(): Promise<AlertItem[]> {
  const [{ data, error }, { data: clubs, error: clubsError }] = await Promise.all([
    supabase
      .from('platform_subscriptions')
      .select('id, club_id, subscription_kind, lifecycle_status, end_at, grace_period_days_snapshot, clubs(name_ar)')
      .neq('lifecycle_status', 'cancelled'),
    supabase.from('clubs').select('id, name_ar'),
  ])

  if (error) throw error
  if (clubsError) throw clubsError

  const now = new Date()
  const alerts: AlertItem[] = []

  for (const row of data ?? []) {
    const end = new Date(row.end_at)
    const graceEnd = new Date(end.getTime() + row.grace_period_days_snapshot * 24 * 60 * 60 * 1000)
    const clubName = (row.clubs as unknown as { name_ar: string } | null)?.name_ar ?? '—'
    const daysToEnd = Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))

    // Master IA/UX audit (Platform Owner phase): now calls the same
    // canonical isSubscriptionExpiringSoon() Overview and Reports' Renewal
    // tab use, instead of re-deriving the trial(3d)/paid(7d) split inline
    // here. This file's distinction was already the canonical one -- see
    // that function's comment in labels.ts for the full citation.
    if (now >= end && now < graceEnd) {
      alerts.push({ id: row.id, clubId: row.club_id, clubName, kind: 'overdue_grace', daysLeft: Math.ceil((graceEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) })
    } else if (isSubscriptionExpiringSoon(row.subscription_kind, row.end_at, now)) {
      alerts.push({
        id: row.id,
        clubId: row.club_id,
        clubName,
        kind: row.subscription_kind === 'trial' ? 'trial_ending' : 'expiring_soon',
        daysLeft: daysToEnd,
      })
    }
  }

  // Owner-level review finding (P2): a club with ZERO
  // platform_subscriptions rows at all (never had a trial/paid
  // subscription provisioned -- a real onboarding-failure shape, found
  // live during this review: 1 of 6 real clubs in this dataset has no
  // subscription row whatsoever) was completely invisible here, since
  // the loop above only ever iterates rows that already exist. It's
  // also the same club get_club_platform_access() correctly reports as
  // 'blocked' -- but until now, blocked-with-no-subscription-at-all had
  // no rule-based alert surfacing it, only the new Overview KPI card.
  const clubIdsWithSubscription = new Set((data ?? []).map((row) => row.club_id))
  for (const club of clubs ?? []) {
    if (!clubIdsWithSubscription.has(club.id)) {
      alerts.push({ id: `no-sub-${club.id}`, clubId: club.id, clubName: club.name_ar, kind: 'no_subscription', daysLeft: null })
    }
  }

  return alerts
}

const KIND_CONFIG = {
  expiring_soon: { icon: Clock, label: 'اشتراك ينتهي قريبًا', tone: 'warning' as const },
  overdue_grace: { icon: AlertTriangle, label: 'في فترة السماح', tone: 'danger' as const },
  trial_ending: { icon: Sparkles, label: 'تجربة مجانية تنتهي قريبًا', tone: 'info' as const },
  no_subscription: { icon: XCircle, label: 'لا يوجد اشتراك مسجّل — يحتاج مراجعة', tone: 'danger' as const },
}

export function PlatformAlertsPage() {
  const { data: alerts = [], isLoading } = useQuery({ queryKey: ['platform-alerts'], queryFn: fetchAlerts })

  return (
    <div>
      <PageHeader title="التنبيهات" description="تنبيهات تلقائية مبنية على قواعد -- بدون خدمة إشعارات خارجية" />
      {isLoading ? null : alerts.length === 0 ? (
        <EmptyState title="لا توجد تنبيهات حاليًا" />
      ) : (
        <div className="flex flex-col gap-2">
          {alerts.map((a) => {
            const config = KIND_CONFIG[a.kind]
            return (
              <Card key={a.id}>
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <div className="flex items-center gap-3">
                    <config.icon className="size-5 text-text-secondary" />
                    <div>
                      <Link to={`/platform/clubs/${a.clubId}`} className="font-medium hover:underline">
                        {a.clubName}
                      </Link>
                      <p className="text-sm text-text-secondary">
                        {config.label}
                        {a.daysLeft !== null ? ` — ${a.daysLeft} يوم متبقٍ` : ''}
                      </p>
                    </div>
                  </div>
                  <StatusBadge tone={config.tone} label={config.label} />
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
