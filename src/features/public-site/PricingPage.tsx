import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { CheckCircle2 } from 'lucide-react'
import { usePublicPricing } from './usePublicPricing'
import { PricingCard } from './PricingCard'

// public_plans-sourced only, no hardcoded prices, no "Buy"/"Checkout"
// language anywhere on this page — see docs/ARCHITECTURE.md
// #public-website--layout-strategy.
//
// COMMERCIAL PACKAGING (2026-09-04): public_plans now also contains
// the 2 surviving legacy plans (Monthly/Annual, id d1a05e72.../
// 21c0c577...) — kept is_public=true ONLY because real existing
// subscriptions still reference them (see
// MAL3ABY_V1_PRICING_MIGRATION.md) — they must NEVER be marketed to
// new customers on this page. Filtering is a frontend display
// decision, not a database change — the legacy plans stay technically
// public for their own existing-subscriber reasons, this page simply
// never surfaces them.
//
// SHARED PRICING SOURCE (2026-09-06): fetching, filtering, family-
// grouping, and annual-discount calculation are no longer implemented
// here at all — they live once in usePublicPricing.ts, shared with
// HomePage.tsx's pricing preview (which used to independently
// re-implement this and drift into a worse interaction model, showing
// 6 flat monthly+annual cards instead of one toggle-driven set). The
// card markup itself is also shared via PricingCard.tsx ("full"
// variant here, "compact" on the homepage) — this page's job now is
// only the page-level layout: header, founding-offer banner, the
// billing-cycle toggle, and the Enterprise static card.

// Anonymous visitors cannot call get_founding_offer_status(p_club_id)
// (it requires a real club membership or platform_owner — correctly,
// since per-club founder status is not public data). founding_offer_
// public_status is a dedicated, narrow, security_invoker view that
// exposes ONLY the aggregate taken-slot count (0-5) — never club
// identity, price, or claim details, which stay fully RLS-protected on
// founding_customer_slots itself. If this query ever fails (network
// error, anon grant revoked in a future redesign), this falls back to
// the generic "limited to our first 5 customers" copy below — never a
// hard error on the page over a marketing detail.
async function fetchFoundingSlotsRemaining(): Promise<number | null> {
  const { data, error } = await supabase.from('founding_offer_public_status').select('slots_remaining').maybeSingle()
  if (error || !data) return null
  return data.slots_remaining
}

export function PricingPage() {
  const { t } = useTranslation()
  const [billingInterval, setBillingInterval] = useState<'month' | 'year'>('month')

  const { isLoading, families, annualDiscountByFamily } = usePublicPricing()
  const { data: slotsRemaining } = useQuery({ queryKey: ['founding-slots-remaining'], queryFn: fetchFoundingSlotsRemaining })

  return (
    <div className="mx-auto max-w-6xl px-4 py-12">
      <PageHeader title={t('publicSite.pricing.title')} description={t('publicSite.pricing.description')} />

      {/* Founding Customer promotion — deliberately a SEPARATE section
          from the list-price cards below, never a crossed-out price on
          the cards themselves (per the mission's explicit "no deceptive
          crossed-out prices" requirement). */}
      <div className="mb-8 rounded-xl border border-status-warning/40 bg-status-warning/10 p-5 text-center">
        <p className="text-base font-semibold text-status-warning">{t('publicSite.pricing.foundingOffer.title')}</p>
        <p className="mt-1 text-sm text-text-secondary">
          {typeof slotsRemaining === 'number'
            ? t('publicSite.pricing.foundingOffer.descriptionWithSlots', { count: slotsRemaining })
            : t('publicSite.pricing.foundingOffer.descriptionGeneric')}
        </p>
      </div>

      {isLoading ? null : families.length === 0 ? (
        <p className="text-center text-text-secondary">{t('publicSite.pricing.unavailable')}</p>
      ) : (
        <>
          {/* Monthly / Annual toggle */}
          <div className="mb-6 flex justify-center">
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

          <div className="grid gap-4 md:grid-cols-3">
            {families.map((family) => (
              <PricingCard key={family.familyName} family={family} billingInterval={billingInterval} annualDiscountByFamily={annualDiscountByFamily} variant="full" />
            ))}

            {/* Enterprise — not a public_plans row (custom/contract terms),
                shown as a static 4th card matching this page's own grid. */}
            <Card className="flex flex-col">
              <CardHeader>
                <CardTitle>{t('publicSite.pricing.enterprise.title')}</CardTitle>
                <p className="text-sm text-text-secondary">{t('publicSite.pricing.enterprise.description')}</p>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4">
                <p className="text-lg font-semibold">{t('publicSite.pricing.enterprise.customPricing')}</p>
                <ul className="flex flex-col gap-1.5 text-sm">
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 shrink-0 text-status-success" />
                    <span>{t('publicSite.pricing.enterprise.everythingInPro')}</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 shrink-0 text-status-success" />
                    <span>{t('publicSite.pricing.supportLevel.dedicated')}</span>
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="size-4 shrink-0 text-status-success" />
                    <span>{t('publicSite.pricing.enterprise.customOnboarding')}</span>
                  </li>
                </ul>
                <Button asChild variant="outline" className="mt-auto">
                  <Link to="/contact">{t('publicSite.pricing.enterprise.contactUs')}</Link>
                </Button>
              </CardContent>
            </Card>
          </div>

          <p className="mt-8 text-center text-sm text-text-secondary">{t('publicSite.pricing.trialFunnelHint')}</p>
        </>
      )}
    </div>
  )
}
