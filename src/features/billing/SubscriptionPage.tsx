import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { MoneyDisplay } from '@/components/ui/money-display'
import { filterPublicCommercialPlans } from '@/lib/domain/billing'

// Club Owner's own-club subscription view. Scoped to the restricted
// club_platform_subscription_summary view only — never platform_invoices/
// platform_payments directly (ADR-035: "own club's commercial summary
// only"). No self-service payment recording — "contact us to activate"
// only, matching the no-online-payment-gateway product decision.
//
// P0 fix (2026-09-05): fetchPublicPlans() previously selected every
// row from public_plans with no filter, so the 2 surviving legacy
// plans (Monthly 499 EGP, Annual 4499 EGP) rendered mixed into
// "Available Plans", and since the query ordered by raw price
// ascending, the cheapest legacy plan (499) rendered FIRST -- ahead of
// the real Starter/Growth/Pro tiers. Now uses the same shared
// filterPublicCommercialPlans() helper as PricingPage.tsx/HomePage.tsx
// (src/lib/domain/billing.ts) so this can't drift back out of sync.

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
  const { data, error } = await supabase.from('public_plans').select('*').order('display_order')
  if (error) throw error
  // Exclude the 2 surviving legacy plans -- this page must never offer
  // legacy plans as something a customer can switch TO; a legacy
  // subscriber's own current plan is already shown separately above
  // via club_platform_subscription_summary (plan_name_snapshot), not
  // sourced from this list.
  return filterPublicCommercialPlans(data ?? [])
}

// P0 fix (2026-09-05): this CTA used to hardcode wa.me/201000000000, a
// placeholder platform number that drifted from the real one. The one
// canonical published platform WhatsApp number lives in
// platform_settings.platform_phone, read the same way PublicLayout's
// footer reads it -- via get_platform_contact() -- never a second
// hardcoded copy. Per-club numbers (whatsapp_number,
// payment_receipt_whatsapp_number on ClubContactCard) are a separate,
// legitimately-per-club concern and are not touched here.
async function fetchPlatformContact() {
  const { data, error } = await supabase.rpc('get_platform_contact')
  if (error) throw error
  return data?.[0] as { platform_phone: string | null; platform_email: string | null } | undefined
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
  const { data: platformContact } = useQuery({
    queryKey: ['platform-contact'],
    queryFn: fetchPlatformContact,
    staleTime: 5 * 60 * 1000,
  })
  const platformWaDigits = platformContact?.platform_phone?.replace(/\D/g, '')

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
                <MoneyDisplay amount={Number(p.price)} currency={p.currency ?? 'EGP'} size="sm" />
              </div>
            ))}
          </div>
          <p className="text-sm text-text-secondary">
            {t('billing.subscriptionPage.contactToActivate')}
          </p>
          {platformWaDigits && (
            <Button asChild className="w-fit">
              <a href={`https://wa.me/${platformWaDigits}`} target="_blank" rel="noreferrer">
                {t('billing.subscriptionPage.contactCta')}
              </a>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
