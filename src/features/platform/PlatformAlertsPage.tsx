import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { StatusBadge } from '@/components/ui/status-badge'
import { Card, CardContent } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
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
  // Production audit remediation (M-2): now reads through
  // get_platform_alert_subscriptions(), a QA-fixture-excluded
  // (clubs.is_test_fixture) server-side RPC, instead of two unfiltered
  // direct queries (platform_subscriptions + clubs). One row per club,
  // with the latest non-cancelled subscription (if any) already joined
  // in -- has_subscription=false is the same "no subscription row at
  // all" signal the client used to derive itself from set-difference.
  const { data, error } = await supabase.rpc('get_platform_alert_subscriptions')
  if (error) throw error

  const now = new Date()
  const alerts: AlertItem[] = []

  for (const row of data ?? []) {
    // Owner-level review finding (P2): a club with ZERO
    // platform_subscriptions rows at all (never had a trial/paid
    // subscription provisioned) is a real onboarding-failure shape --
    // also the same club get_club_platform_access() correctly reports
    // as 'blocked'. Surfaced as its own alert kind rather than silently
    // skipped.
    if (!row.has_subscription || !row.end_at) {
      alerts.push({ id: `no-sub-${row.club_id}`, clubId: row.club_id, clubName: row.club_name, kind: 'no_subscription', daysLeft: null })
      continue
    }

    const end = new Date(row.end_at)
    const graceEnd = new Date(end.getTime() + (row.grace_period_days_snapshot ?? 0) * 24 * 60 * 60 * 1000)
    const daysToEnd = Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))

    // Master IA/UX audit (Platform Owner phase): now calls the same
    // canonical isSubscriptionExpiringSoon() Overview and Reports' Renewal
    // tab use, instead of re-deriving the trial(3d)/paid(7d) split inline
    // here. This file's distinction was already the canonical one -- see
    // that function's comment in labels.ts for the full citation.
    if (now >= end && now < graceEnd) {
      alerts.push({ id: row.subscription_id, clubId: row.club_id, clubName: row.club_name, kind: 'overdue_grace', daysLeft: Math.ceil((graceEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) })
    } else if (isSubscriptionExpiringSoon(row.subscription_kind, row.end_at, now)) {
      alerts.push({
        id: row.subscription_id,
        clubId: row.club_id,
        clubName: row.club_name,
        kind: row.subscription_kind === 'trial' ? 'trial_ending' : 'expiring_soon',
        daysLeft: daysToEnd,
      })
    }
  }

  return alerts
}

const KIND_ICON = {
  expiring_soon: { icon: Clock, tone: 'warning' as const },
  overdue_grace: { icon: AlertTriangle, tone: 'danger' as const },
  trial_ending: { icon: Sparkles, tone: 'info' as const },
  no_subscription: { icon: XCircle, tone: 'danger' as const },
}

export function PlatformAlertsPage() {
  const { t } = useTranslation()
  const { data: alerts = [], isLoading } = useQuery({ queryKey: ['platform-alerts'], queryFn: fetchAlerts })

  return (
    <div>
      <PageHeader title={t('platform.alertsPage.title')} description={t('platform.alertsPage.description')} />
      {isLoading ? (
        // PERSONA COUNCIL AUDIT (2026-08-25) -- Platform Owner persona
        // finding: this rendered nothing at all during load, the only
        // screen in the platform console without a skeleton, reading as
        // "did my click even register" for a moment on a slower
        // connection. Matches the row-skeleton density other
        // card-list screens in this app already use.
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : alerts.length === 0 ? (
        <EmptyState title={t('platform.alertsPage.emptyTitle')} />
      ) : (
        <div className="flex flex-col gap-2">
          {alerts.map((a) => {
            const config = KIND_ICON[a.kind]
            const label = t(`platform.alertsPage.kindLabels.${a.kind}`)
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
                        {label}
                        {a.daysLeft !== null ? t('platform.alertsPage.daysLeftSuffix', { days: a.daysLeft }) : ''}
                      </p>
                    </div>
                  </div>
                  <StatusBadge tone={config.tone} label={label} />
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
