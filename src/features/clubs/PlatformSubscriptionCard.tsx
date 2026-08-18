import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { Skeleton } from '@/components/ui/skeleton'
import { AlertTriangle } from 'lucide-react'

// Phase 3b frontend scope: read-only summary only, sourced from the
// restricted club_platform_subscription_summary view (never the raw
// platform_subscriptions table — ADR-035). Full Platform Owner console is
// Phase 3c.
const ACCESS_TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  full: 'success',
  grace: 'warning',
  blocked: 'danger',
}

async function fetchSubscriptionSummary(clubId: string) {
  const { data, error } = await supabase
    .from('club_platform_subscription_summary')
    .select('*')
    .eq('club_id', clubId)
    .maybeSingle()

  if (error) throw error
  return data
}

export function PlatformSubscriptionCard() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()

  const { data, isLoading } = useQuery({
    queryKey: ['platform-subscription-summary', currentClubId],
    queryFn: () => fetchSubscriptionSummary(currentClubId!),
    enabled: !!currentClubId,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('clubs.platformSubscriptionCard.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : !data ? (
          // Gate 13 (task #53): a club with zero platform_subscriptions rows
          // is always effectively blocked (get_club_platform_access() returns
          // 'blocked' with no row to check) -- but this is a normal, expected
          // state, not an error: complete_new_club_onboarding() only grants
          // an automatic trial once per owner (enforced via
          // automatic_trial_entitlements' unique constraint), so any second
          // or later club an owner creates lands here by design, awaiting a
          // real commercial decision from the platform. The previous bare
          // "no active subscription" message gave no explanation or next
          // step; this is the honest, actionable replacement.
          <div className="flex items-start gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-sm text-status-warning">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div className="flex flex-col gap-1">
              <span className="font-medium">{t('clubs.platformSubscriptionCard.pendingTitle')}</span>
              <span className="text-status-warning/90">
                {t('clubs.platformSubscriptionCard.pendingDescription')}
              </span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-text-secondary">{t('clubs.platformSubscriptionCard.statusLabel')}</span>
              <StatusBadge
                tone={ACCESS_TONE[data.effective_access ?? 'blocked'] ?? 'neutral'}
                label={
                  data.effective_access && ACCESS_TONE[data.effective_access]
                    ? t(`clubs.platformSubscriptionCard.accessLabels.${data.effective_access}`)
                    : (data.effective_access ?? '—')
                }
              />
            </div>
            <div>
              <span className="text-text-secondary">{t('clubs.platformSubscriptionCard.kindLabel')}</span>
              {data.subscription_kind && ['trial', 'paid', 'complimentary'].includes(data.subscription_kind)
                ? t(`clubs.platformSubscriptionCard.kindLabels.${data.subscription_kind}`)
                : data.subscription_kind}
            </div>
            {data.plan_name_snapshot && (
              <div>
                <span className="text-text-secondary">{t('clubs.platformSubscriptionCard.planLabel')}</span>
                {data.plan_name_snapshot}
              </div>
            )}
            <div>
              <span className="text-text-secondary">{t('clubs.platformSubscriptionCard.endDateLabel')}</span>
              {data.end_at ? new Date(data.end_at).toLocaleDateString('ar-EG') : '—'}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
