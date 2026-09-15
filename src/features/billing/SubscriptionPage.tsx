import { useState } from 'react'
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
import { cn } from '@/lib/utils'
import { formatNumberIsolated } from '@/lib/i18n/config'
import { usePublicPricing } from '@/features/public-site/usePublicPricing'

// Club Owner's own-club subscription view. Scoped to the restricted
// club_platform_subscription_summary view only — never platform_invoices/
// platform_payments directly (ADR-035: "own club's commercial summary
// only"). No self-service payment recording — "contact us to activate"
// only, matching the no-online-payment-gateway product decision.
//
// P0 fix (2026-09-05): the plans query previously selected every row
// from public_plans with no filter, so the 2 surviving legacy plans
// (Monthly 499 EGP, Annual 4499 EGP) rendered mixed into "Available
// Plans", and since the query ordered by raw price ascending, the
// cheapest legacy plan (499) rendered FIRST -- ahead of the real
// Starter/Growth/Pro tiers. Now sourced entirely from usePublicPricing()
// (src/features/public-site/usePublicPricing.ts), the same shared fetch/
// filter/family-grouping pipeline PricingPage.tsx/HomePage.tsx use, so
// this can't drift back out of sync with either the legacy-plan filter
// or the grouping/toggle presentation (round-2 audit finding #3).

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
  const { t, i18n } = useTranslation()
  const isArabic = i18n.language.startsWith('ar')
  const { locale } = useDirection()
  const { data: summary, isLoading } = useQuery({
    queryKey: ['subscription-summary', currentClubId],
    queryFn: () => fetchSummary(currentClubId!),
    enabled: !!currentClubId,
  })
  // Audit fix (round-2, finding #3): this page used to list every
  // public_plans row flatly (monthly+annual per tier, 6 loose cards)
  // with no family grouping or billing-cycle toggle -- inconsistent
  // with the public Pricing page's grouped presentation of the exact
  // same table. Now reuses usePublicPricing() (the shared fetch/filter/
  // family-grouping/discount pipeline PricingPage.tsx and HomePage.tsx
  // already share -- see usePublicPricing.ts's own header comment) so
  // this can't drift into a third independent grouping implementation.
  const [billingInterval, setBillingInterval] = useState<'month' | 'year'>('month')
  const { isLoading: plansLoading, families, annualDiscountByFamily } = usePublicPricing()
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
          {!plansLoading && families.length > 0 && (
            // Same toggle pattern/copy as PricingPage.tsx -- monthly vs
            // annual is a single page-level choice, not a per-card
            // decision, so every family card below reflects the same
            // selected billing cycle.
            <div className="flex justify-center">
              <div className="inline-flex rounded-lg border border-border p-1">
                <button
                  type="button"
                  onClick={() => setBillingInterval('month')}
                  className={cn('rounded-md px-4 py-1.5 text-sm font-medium transition-colors', billingInterval === 'month' ? 'bg-primary text-primary-foreground' : 'text-text-secondary')}
                >
                  {t('publicSite.pricing.billingToggle.monthly')}
                </button>
                <button
                  type="button"
                  onClick={() => setBillingInterval('year')}
                  className={cn('rounded-md px-4 py-1.5 text-sm font-medium transition-colors', billingInterval === 'year' ? 'bg-primary text-primary-foreground' : 'text-text-secondary')}
                >
                  {t('publicSite.pricing.billingToggle.annual')}
                </button>
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {families.map((family) => {
              const row = billingInterval === 'year' ? (family.annual ?? family.monthly) : (family.monthly ?? family.annual)
              if (!row) return null
              const discountPct = billingInterval === 'year' ? annualDiscountByFamily.get(family.familyName) : undefined
              const displayName = isArabic ? (family.monthly?.name_ar ?? family.annual?.name_ar ?? family.familyName) : family.familyName
              return (
                <div key={family.familyName} className="rounded-md border border-border p-3">
                  <p className="font-medium">{displayName}</p>
                  <MoneyDisplay amount={Number(row.price)} currency={row.currency ?? 'EGP'} size="sm" />
                  <p className="text-xs text-text-secondary">
                    {billingInterval === 'year' ? t('publicSite.pricing.perYear') : t('publicSite.pricing.perMonth')}
                  </p>
                  {discountPct != null && (
                    <p className="text-xs font-medium text-status-success">
                      {t('publicSite.pricing.saveDiscount', { percent: formatNumberIsolated(discountPct, isArabic ? 'ar' : 'en') })}
                    </p>
                  )}
                </div>
              )
            })}
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
