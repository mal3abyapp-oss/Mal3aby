import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CheckCircle2 } from 'lucide-react'

// public_plans-sourced only, no hardcoded prices, no "Buy"/"Checkout"
// language anywhere on this page — see docs/ARCHITECTURE.md
// #public-website--layout-strategy.
//
// COMMERCIAL PACKAGING (2026-09-04): public_plans now also contains
// the 2 surviving legacy plans (Monthly/Annual, id d1a05e72.../
// 21c0c577...) — kept is_public=true ONLY because real existing
// subscriptions still reference them (see
// MAL3ABY_V1_PRICING_MIGRATION.md) — they must NEVER be marketed to
// new customers on this page. The 4 new commercial tiers (Starter/
// Growth/Pro, each with a monthly+annual row) all have
// display_order >= 10; the 2 legacy rows have display_order 1/4.
// Filtering on this is a frontend display decision, not a database
// change — the legacy plans stay technically public for their own
// existing-subscriber reasons, this page simply never surfaces them.
const NEW_COMMERCIAL_TIER_MIN_DISPLAY_ORDER = 10

interface PublicPlanRow {
  id: string
  name: string
  name_ar: string
  description_ar: string | null
  billing_interval: string
  billing_interval_count: number
  price: number
  currency: string | null
  discount_label: string | null
  features_summary: string | null
  default_grace_period_days: number | null
  default_branch_limit: number | null
  default_field_limit: number | null
  default_academy_limit: number | null
  default_staff_limit: number | null
  default_active_player_limit: number | null
  display_order: number | null
}

interface PlanFamily {
  familyName: string // e.g. "Starter" — the shared name minus "(Annual)"
  monthly: PublicPlanRow | null
  annual: PublicPlanRow | null
}

async function fetchPlans(): Promise<PublicPlanRow[]> {
  const { data, error } = await supabase.from('public_plans').select('*').order('display_order')
  if (error) throw error
  return (data ?? []) as PublicPlanRow[]
}

// Groups the flat public_plans rows (each billing interval is its own
// row, e.g. "Starter" + "Starter (Annual)") into one card per
// commercial tier, matching how a customer actually thinks about
// plans — "Starter" with a monthly/annual choice, not 6 separate cards.
function groupIntoFamilies(rows: PublicPlanRow[]): PlanFamily[] {
  const families = new Map<string, PlanFamily>()
  for (const row of rows) {
    if ((row.display_order ?? 0) < NEW_COMMERCIAL_TIER_MIN_DISPLAY_ORDER) continue
    const isAnnual = row.billing_interval === 'year'
    const familyName = isAnnual ? row.name.replace(/\s*\(Annual\)\s*$/, '') : row.name
    const existing = families.get(familyName) ?? { familyName, monthly: null, annual: null }
    if (isAnnual) existing.annual = row
    else existing.monthly = row
    families.set(familyName, existing)
  }
  return Array.from(families.values()).sort(
    (a, b) => (a.monthly?.display_order ?? a.annual?.display_order ?? 0) - (b.monthly?.display_order ?? b.annual?.display_order ?? 0)
  )
}

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

const CAPACITY_FIELDS: Array<{ key: keyof PublicPlanRow; labelKey: string }> = [
  { key: 'default_branch_limit', labelKey: 'branches' },
  { key: 'default_field_limit', labelKey: 'fields' },
  { key: 'default_academy_limit', labelKey: 'academies' },
  { key: 'default_staff_limit', labelKey: 'staff' },
  { key: 'default_active_player_limit', labelKey: 'activePlayers' },
]

export function PricingPage() {
  const { t, i18n } = useTranslation()
  const isArabic = i18n.language.startsWith('ar')
  const [billingInterval, setBillingInterval] = useState<'month' | 'year'>('month')

  const { data: plans = [], isLoading } = useQuery({ queryKey: ['public-plans-pricing'], queryFn: fetchPlans })
  const { data: slotsRemaining } = useQuery({ queryKey: ['founding-slots-remaining'], queryFn: fetchFoundingSlotsRemaining })

  const families = groupIntoFamilies(plans)

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
            {families.map((family) => {
              const row = billingInterval === 'year' ? (family.annual ?? family.monthly) : (family.monthly ?? family.annual)
              if (!row) return null
              const isRecommended = family.familyName === 'Growth' // mid-tier, matches the packaging doc's own "Growth is the natural default for a multi-branch/academy operator" framing
              const monthlyEquivalent = billingInterval === 'year' && family.monthly ? family.annual!.price / 12 : null

              return (
                <Card key={family.familyName} className={cn('flex flex-col', isRecommended && 'border-primary ring-1 ring-primary')}>
                  <CardHeader>
                    {isRecommended && (
                      <span className="mb-2 inline-block w-fit rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
                        {t('publicSite.pricing.recommended')}
                      </span>
                    )}
                    <CardTitle>{isArabic ? (family.monthly?.name_ar ?? family.annual?.name_ar) : family.familyName}</CardTitle>
                    {row.description_ar && isArabic && <p className="text-sm text-text-secondary">{row.description_ar}</p>}
                  </CardHeader>
                  <CardContent className="flex flex-1 flex-col gap-4">
                    <div>
                      <MoneyDisplay amount={Number(row.price)} currency={row.currency ?? 'EGP'} size="lg" />
                      <p className="text-sm text-text-secondary">
                        {billingInterval === 'year'
                          ? t('publicSite.pricing.perYear')
                          : t('publicSite.pricing.perMonth')}
                      </p>
                      {billingInterval === 'year' && monthlyEquivalent !== null && (
                        <p className="mt-1 text-xs text-status-success">
                          {t('publicSite.pricing.annualSavingHint', { monthlyEquivalent: Math.round(monthlyEquivalent) })}
                        </p>
                      )}
                    </div>

                    {/* Real capacity numbers, pulled live from public_plans —
                        never hardcoded, never diverges from what
                        commercial_entitlements will actually enforce for a
                        club created on this plan. */}
                    <ul className="flex flex-col gap-1.5 text-sm">
                      {CAPACITY_FIELDS.map((field) => {
                        const value = row[field.key]
                        return (
                          <li key={field.labelKey} className="flex items-center gap-2">
                            <CheckCircle2 className="size-4 shrink-0 text-status-success" />
                            <span>
                              {value === null
                                ? t(`publicSite.pricing.capacity.${field.labelKey}Unlimited`)
                                : t(`publicSite.pricing.capacity.${field.labelKey}`, { count: value })}
                            </span>
                          </li>
                        )
                      })}
                      <li className="flex items-center gap-2">
                        <CheckCircle2 className="size-4 shrink-0 text-status-success" />
                        <span>{t('publicSite.pricing.capacity.unlimitedBookingsAndReports')}</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 className="size-4 shrink-0 text-status-success" />
                        <span>{t('publicSite.pricing.capacity.whatsappFairUse')}</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <CheckCircle2 className="size-4 shrink-0 text-status-success" />
                        <span>{t(`publicSite.pricing.supportLevel.${family.familyName === 'Starter' ? 'standard' : 'priority'}`)}</span>
                      </li>
                    </ul>

                    <Button asChild className="mt-auto">
                      <Link to="/signup">{t('publicSite.pricing.startFreeTrial')}</Link>
                    </Button>
                  </CardContent>
                </Card>
              )
            })}

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
