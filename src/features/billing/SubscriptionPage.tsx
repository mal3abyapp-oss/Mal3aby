import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'

// Club Owner's own-club subscription view. Scoped to the restricted
// club_platform_subscription_summary view only — never platform_invoices/
// platform_payments directly (ADR-035: "own club's commercial summary
// only"). No self-service payment recording — "contact us to activate"
// only, matching the no-online-payment-gateway product decision.
const ACCESS_TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  full: 'success',
  grace: 'warning',
  blocked: 'danger',
}

const ACCESS_LABEL_KEYS = {
  full: 'billing.subscriptionPage.accessLabels.full',
  grace: 'billing.subscriptionPage.accessLabels.grace',
  blocked: 'billing.subscriptionPage.accessLabels.blocked',
} as const

async function fetchSummary(clubId: string) {
  const { data, error } = await supabase
    .from('club_platform_subscription_summary')
    .select('*')
    .eq('club_id', clubId)
    .maybeSingle()
  if (error) throw error
  return data
}

async function fetchPublicPlans() {
  const { data, error } = await supabase.from('public_plans').select('*').order('price')
  if (error) throw error
  return data ?? []
}

export function SubscriptionPage() {
  const { currentClubId } = useAuth()
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { data: summary, isLoading } = useQuery({
    queryKey: ['subscription-summary', currentClubId],
    queryFn: () => fetchSummary(currentClubId!),
    enabled: !!currentClubId,
  })
  const { data: plans = [] } = useQuery({ queryKey: ['public-plans-subscription'], queryFn: fetchPublicPlans })

  return (
    <div>
      <PageHeader title={t('billing.subscriptionPage.title')} description={t('billing.subscriptionPage.description')} />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">{t('billing.subscriptionPage.currentStatus')}</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-text-secondary">{t('billing.subscriptionPage.loading')}</p>
          ) : !summary ? (
            <p className="text-sm text-text-secondary">{t('billing.subscriptionPage.noActiveSubscription')}</p>
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <StatusBadge
                tone={ACCESS_TONE[summary.effective_access ?? 'blocked'] ?? 'danger'}
                label={t(ACCESS_LABEL_KEYS[summary.effective_access as keyof typeof ACCESS_LABEL_KEYS] ?? ACCESS_LABEL_KEYS.blocked)}
              />
              <p>{t('billing.subscriptionPage.type', { type: summary.subscription_kind === 'trial' ? t('billing.subscriptionPage.typeTrial') : summary.subscription_kind })}</p>
              {summary.plan_name_snapshot && <p>{t('billing.subscriptionPage.plan', { name: summary.plan_name_snapshot })}</p>}
              <p>{t('billing.subscriptionPage.endDate', { date: summary.end_at ? new Date(summary.end_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') : '—' })}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('billing.subscriptionPage.availablePlans')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {plans.map((p) => (
              <div key={p.name_ar} className="rounded-md border border-border p-3">
                <p className="font-medium">{p.name_ar}</p>
                <p className="text-sm text-text-secondary">{p.price} {p.currency}</p>
              </div>
            ))}
          </div>
          <p className="text-sm text-text-secondary">
            {t('billing.subscriptionPage.contactToActivate')}
          </p>
          <Button asChild className="w-fit">
            <a href="https://wa.me/201000000000" target="_blank" rel="noreferrer">
              {t('billing.subscriptionPage.contactCta')}
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
