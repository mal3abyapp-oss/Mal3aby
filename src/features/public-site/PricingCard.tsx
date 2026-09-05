// Shared presentational pricing card — the ONE place that renders a
// commercial-tier card (Starter/Growth/Pro), consumed by both
// PricingPage.tsx (full detail: capacity list, support level) and
// HomePage.tsx's compact pricing preview (name + price + discount +
// CTA only). Extracted 2026-09-06 alongside usePublicPricing.ts so
// both surfaces share one card visual language instead of two
// independently hand-rolled card implementations that could drift.
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CheckCircle2 } from 'lucide-react'
import { formatNumberIsolated } from '@/lib/i18n/config'
import type { PlanFamily, PublicPlanRow } from './usePublicPricing'

const CAPACITY_FIELDS: Array<{ key: keyof PublicPlanRow; labelKey: string }> = [
  { key: 'default_branch_limit', labelKey: 'branches' },
  { key: 'default_field_limit', labelKey: 'fields' },
  { key: 'default_academy_limit', labelKey: 'academies' },
  { key: 'default_staff_limit', labelKey: 'staff' },
  { key: 'default_active_player_limit', labelKey: 'activePlayers' },
]

export interface PricingCardProps {
  family: PlanFamily
  billingInterval: 'month' | 'year'
  annualDiscountByFamily: Map<string, number>
  /** "full" = PricingPage's detailed card (capacity list, support level). "compact" = HomePage preview's slimmer card (name + price + discount + CTA only). */
  variant?: 'full' | 'compact'
}

export function PricingCard({ family, billingInterval, annualDiscountByFamily, variant = 'full' }: PricingCardProps) {
  const { t, i18n } = useTranslation()
  const isArabic = i18n.language.startsWith('ar')
  const isRecommended = family.familyName === 'Growth' // mid-tier, matches the packaging doc's own "Growth is the natural default for a multi-branch/academy operator" framing

  const row = billingInterval === 'year' ? (family.annual ?? family.monthly) : (family.monthly ?? family.annual)
  if (!row) return null

  const monthlyEquivalent = billingInterval === 'year' && family.monthly && family.annual ? family.annual.price! / 12 : null
  const discountPct = billingInterval === 'year' ? annualDiscountByFamily.get(family.familyName) : undefined

  const displayName = isArabic ? (family.monthly?.name_ar ?? family.annual?.name_ar ?? family.familyName) : family.familyName

  if (variant === 'compact') {
    return (
      <div
        className={
          isRecommended
            ? 'relative flex -translate-y-1.5 flex-col gap-4 rounded-2xl border border-dark-base bg-dark-base p-6 text-white shadow-2xl shadow-dark-base/30'
            : 'flex flex-col gap-4 rounded-2xl border border-border bg-page-bg p-6'
        }
      >
        {isRecommended && (
          <span className="absolute -top-3 start-6 rounded-full bg-accent px-3 py-1 text-[11.5px] font-bold text-accent-foreground">
            {t('publicSite.home.mostPopular')}
          </span>
        )}
        <p className={isRecommended ? 'text-sm font-semibold text-white/70' : 'text-sm font-semibold text-text-secondary'}>{displayName}</p>
        <MoneyDisplay amount={Number(row.price)} currency={row.currency ?? 'EGP'} size="lg" className={isRecommended ? 'text-white' : undefined} />
        {discountPct != null && (
          <p className={isRecommended ? 'text-[12.5px] font-semibold text-green-300' : 'text-[12.5px] font-semibold text-status-success'}>
            {t('publicSite.pricing.saveDiscount', { percent: formatNumberIsolated(discountPct, isArabic ? 'ar' : 'en') })}
          </p>
        )}
        <Button size="sm" className={isRecommended ? 'mt-1 bg-accent text-accent-foreground hover:bg-accent/90' : 'mt-1'} variant={isRecommended ? 'default' : 'outline'} asChild>
          <Link to="/signup">{t('publicSite.home.startFreeTrial')}</Link>
        </Button>
      </div>
    )
  }

  return (
    <Card className={cn('flex flex-col', isRecommended && 'border-primary ring-1 ring-primary')}>
      <CardHeader>
        {isRecommended && (
          <span className="mb-2 inline-block w-fit rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            {t('publicSite.pricing.recommended')}
          </span>
        )}
        <CardTitle>{displayName}</CardTitle>
        {row.description_ar && isArabic && <p className="text-sm text-text-secondary">{row.description_ar}</p>}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <div>
          <MoneyDisplay amount={Number(row.price)} currency={row.currency ?? 'EGP'} size="lg" />
          <p className="text-sm text-text-secondary">{billingInterval === 'year' ? t('publicSite.pricing.perYear') : t('publicSite.pricing.perMonth')}</p>
          {billingInterval === 'year' && monthlyEquivalent !== null && (
            <p className="mt-1 text-xs text-status-success">
              {t('publicSite.pricing.annualSavingHint', { monthlyEquivalent: formatNumberIsolated(Math.round(monthlyEquivalent), isArabic ? 'ar' : 'en') })}
            </p>
          )}
        </div>

        {/* Real capacity numbers, pulled live from public_plans — never
            hardcoded, never diverges from what commercial_entitlements
            will actually enforce for a club created on this plan. */}
        <ul className="flex flex-col gap-1.5 text-sm">
          {CAPACITY_FIELDS.map((field) => {
            const value = row[field.key]
            return (
              <li key={field.labelKey} className="flex items-center gap-2">
                <CheckCircle2 className="size-4 shrink-0 text-status-success" />
                <span>{value === null ? t(`publicSite.pricing.capacity.${field.labelKey}Unlimited`) : t(`publicSite.pricing.capacity.${field.labelKey}`, { count: value })}</span>
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
}
