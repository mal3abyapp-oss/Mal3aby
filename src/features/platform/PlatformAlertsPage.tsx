import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { StatusBadge } from '@/components/ui/status-badge'
import { Card, CardContent } from '@/components/ui/card'
import { AlertTriangle, Clock, Sparkles } from 'lucide-react'

// Rule-based in-app alerts, computed live from platform_subscriptions --
// no external notification service (see IMPLEMENTATION_PLAN.md Phase 3c:
// "rule-based, no external notification service").
interface AlertItem {
  id: string
  clubId: string
  clubName: string
  kind: 'expiring_soon' | 'overdue_grace' | 'trial_ending'
  daysLeft: number
}

async function fetchAlerts(): Promise<AlertItem[]> {
  const { data, error } = await supabase
    .from('platform_subscriptions')
    .select('id, club_id, subscription_kind, lifecycle_status, end_at, grace_period_days_snapshot, clubs(name_ar)')
    .neq('lifecycle_status', 'cancelled')

  if (error) throw error

  const now = new Date()
  const alerts: AlertItem[] = []

  for (const row of data ?? []) {
    const end = new Date(row.end_at)
    const graceEnd = new Date(end.getTime() + row.grace_period_days_snapshot * 24 * 60 * 60 * 1000)
    const clubName = (row.clubs as unknown as { name_ar: string } | null)?.name_ar ?? '—'
    const daysToEnd = Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))

    if (now >= end && now < graceEnd) {
      alerts.push({ id: row.id, clubId: row.club_id, clubName, kind: 'overdue_grace', daysLeft: Math.ceil((graceEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)) })
    } else if (row.subscription_kind === 'trial' && daysToEnd >= 0 && daysToEnd <= 3) {
      alerts.push({ id: row.id, clubId: row.club_id, clubName, kind: 'trial_ending', daysLeft: daysToEnd })
    } else if (row.subscription_kind !== 'trial' && daysToEnd >= 0 && daysToEnd <= 7) {
      alerts.push({ id: row.id, clubId: row.club_id, clubName, kind: 'expiring_soon', daysLeft: daysToEnd })
    }
  }

  return alerts
}

const KIND_CONFIG = {
  expiring_soon: { icon: Clock, label: 'اشتراك ينتهي قريبًا', tone: 'warning' as const },
  overdue_grace: { icon: AlertTriangle, label: 'في فترة السماح', tone: 'danger' as const },
  trial_ending: { icon: Sparkles, label: 'تجربة مجانية تنتهي قريبًا', tone: 'info' as const },
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
                      <p className="text-sm text-text-secondary">{config.label} — {a.daysLeft} يوم متبقٍ</p>
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
