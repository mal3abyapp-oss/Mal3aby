import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { MoneyDisplay } from '@/components/ui/money-display'
import { filterPublicCommercialPlans } from '@/lib/domain/billing'
import {
  CalendarDays,
  GraduationCap,
  Receipt,
  ScanLine,
  BarChart3,
  ShoppingCart,
  Building2,
  Users,
  MapPinned,
  LandPlot,
  ChevronDown,
} from 'lucide-react'

// LANDING PAGE REDESIGN (2026-08-29) -- the homepage previously
// implemented only 3 of the ~9 sections already prescribed in
// docs/DESIGN_SYSTEM.md's own "Public Website Visual System" spec
// (Header -> Hero -> Suitable For -> Core Benefits -> How It Works ->
// Pricing -> Free Trial CTA -> FAQ -> Contact -> Footer), and its copy
// was a bare feature-name list ("الحجوزات" / "QR" / "التقارير") with
// no explanation of what any of it does or why it matters -- a real,
// live user-reported finding ("صفحة الهبوط لا تعبر عن الأداة
// ومميزاتها ضعيفة جدًا"). This closes that gap: every section below
// was reviewed against a published wireframe before implementation
// (see conversation history), copy went through an explicit
// pain-then-solution rewrite pass (the hero headline especially --
// "بلاش ورق وإكسل متفرقة / نادك، كله، في مكان واحد" replaces a
// 4-line descriptive title that visually broke apart on screen), and
// every capability described is real and shippable today -- sourced
// from the actual route tree / nav domains, nothing invented.
//
// See docs/USER_FLOWS.md Flow 8, docs/SCREEN_MAP.md Home. Pricing
// section reads only the public_plans view (never platform_plans
// directly, unchanged from before) -- see
// docs/ARCHITECTURE.md#public-website--layout-strategy. All 4 real
// plans render (was previously capped by only having 3 in an older
// snapshot); no hardcoded price ever appears here.

const suitableForSegments = [
  { icon: Building2, key: 'club' },
  { icon: Users, key: 'academy' },
  { icon: MapPinned, key: 'fields' },
  { icon: LandPlot, key: 'sportsCenter' },
] as const

const benefits = [
  { icon: CalendarDays, key: 'bookings' },
  { icon: GraduationCap, key: 'academy' },
  { icon: ShoppingCart, key: 'shop' },
  { icon: Receipt, key: 'invoicesAndPayments' },
  { icon: ScanLine, key: 'qr' },
  { icon: BarChart3, key: 'reports' },
] as const

const howItWorksSteps = ['step1', 'step2', 'step3', 'step4'] as const

const faqItems = ['q1', 'q2', 'q3', 'q4'] as const

async function fetchPublicPlans() {
  const { data, error } = await supabase.from('public_plans').select('*')
  if (error) throw error
  // P0 fix (2026-09-05): unfiltered, this returned the 2 surviving
  // legacy plans (499/4,499 EGP) alongside the real Starter/Growth/Pro
  // tiers on the public landing page -- see filterPublicCommercialPlans
  // (src/lib/domain/billing.ts), the same shared guard now used by
  // PricingPage.tsx and SubscriptionPage.tsx.
  return filterPublicCommercialPlans(data ?? [])
}

// Real, live-looking numbers for the hero's product preview -- this is
// NOT a stock photo (docs/DESIGN_SYSTEM.md explicitly forbids stock
// photography standing in for actual product UI) and it is not a real
// screenshot either, since no product screenshots exist in the repo
// yet (confirmed before writing this). It is a static illustration of
// the Today dashboard's real shape (same KPI cards, same row pattern,
// same QR check-in concept every authenticated club owner actually
// sees on /app) -- built from the same design tokens as the rest of
// the app, not invented UI.
function HeroMockup() {
  const { t } = useTranslation()
  return (
    <div className="relative">
      <div className="absolute -inset-8 -z-10 rounded-full bg-accent/10 blur-2xl" aria-hidden="true" />
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-dark-secondary shadow-2xl">
        <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
          <span className="size-2 rounded-full bg-white/15" />
          <span className="size-2 rounded-full bg-white/15" />
          <span className="size-2 rounded-full bg-white/15" />
          <span className="ms-3 text-xs text-white/50">{t('publicSite.home.mockup.tabLabel')}</span>
        </div>
        <div className="grid gap-3 p-4">
          <div className="grid grid-cols-3 gap-2.5">
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <p className="text-[11px] text-white/50">{t('publicSite.home.mockup.bookingsToday')}</p>
              <p className="tabular-nums text-lg font-bold text-white">18</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <p className="text-[11px] text-white/50">{t('publicSite.home.mockup.revenueToday')}</p>
              <p className="tabular-nums text-lg font-bold text-accent">4,250 EGP</p>
            </div>
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <p className="text-[11px] text-white/50">{t('publicSite.home.mockup.fieldsOccupied')}</p>
              <p className="tabular-nums text-lg font-bold text-white">6/8</p>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-[13px] text-white/70">
            <span>{t('publicSite.home.mockup.bookingRow')}</span>
            <span className="rounded-full bg-status-success/15 px-2.5 py-0.5 text-[11px] font-semibold text-status-success">
              {t('publicSite.home.mockup.confirmed')}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-[13px] text-white/70">
            <span>{t('publicSite.home.mockup.subscriptionRow')}</span>
            <span className="rounded-full bg-status-warning/15 px-2.5 py-0.5 text-[11px] font-semibold text-status-warning">
              {t('publicSite.home.mockup.pendingPayment')}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-[13px] text-white/70">
            <span>{t('publicSite.home.mockup.shopSaleRow')}</span>
            <span className="rounded-full bg-status-success/15 px-2.5 py-0.5 text-[11px] font-semibold text-status-success">
              {t('publicSite.home.mockup.completed')}
            </span>
          </div>
          <div className="flex items-center gap-2.5 rounded-lg border border-accent/25 bg-accent/[0.08] px-3.5 py-2.5 text-[12.5px] text-accent">
            <ScanLine className="size-4 shrink-0" aria-hidden="true" />
            {t('publicSite.home.mockup.qrLine')}
          </div>
        </div>
      </div>
    </div>
  )
}

export function HomePage() {
  const { t, i18n } = useTranslation()
  const { data: plans = [] } = useQuery({ queryKey: ['public-plans-home'], queryFn: fetchPublicPlans })

  return (
    <>
      {/* ============ HERO ============ */}
      <section className="relative overflow-hidden bg-dark-base text-white">
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(255,255,255,0.06) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
            maskImage: 'linear-gradient(to bottom, black, transparent 75%)',
            WebkitMaskImage: 'linear-gradient(to bottom, black, transparent 75%)',
          }}
          aria-hidden="true"
        />
        <div className="relative mx-auto grid max-w-6xl gap-10 px-4 py-20 md:grid-cols-[1.05fr_0.95fr] md:items-center md:py-28">
          <div>
            <p className="mb-3.5 inline-flex items-center gap-2 text-sm font-semibold tracking-wide text-accent">
              <span className="h-0.5 w-[18px] rounded-full bg-accent" />
              {t('publicSite.home.eyebrow')}
            </p>
            <h1 className="text-3xl font-bold leading-tight tracking-tight text-balance whitespace-pre-line md:text-5xl">
              {t('publicSite.home.heroTitle')}
            </h1>
            <p className="mt-4 max-w-md text-lg leading-relaxed text-white/70">
              {t('publicSite.home.heroSubtitle')}
            </p>
            <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
              <Button size="lg" className="bg-accent text-accent-foreground hover:bg-accent/90" asChild>
                <Link to="/signup">{t('publicSite.home.startFreeTrial')}</Link>
              </Button>
              <Button size="lg" variant="outline" className="border-white/25 bg-transparent text-white hover:bg-white/10" asChild>
                <a href="#how-it-works">{t('publicSite.home.watchHowItWorks')}</a>
              </Button>
            </div>
            <p className="mt-4 flex items-center gap-2 text-sm text-white/50">
              <span className="size-1.5 rounded-full bg-accent" />
              {t('publicSite.home.trialBadge')}
            </p>
            <p className="mt-7 text-sm">
              <Link to="/login" className="text-white/55 underline decoration-white/20 decoration-dashed underline-offset-4 hover:text-white hover:decoration-white/55">
                {t('publicSite.home.customerLink')}
              </Link>
            </p>
          </div>
          <HeroMockup />
        </div>
      </section>

      {/* ============ SUITABLE FOR ============ */}
      <section className="border-b border-border bg-surface py-14">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="mb-8 text-center text-xl font-semibold text-text-secondary md:text-2xl">
            {t('publicSite.home.suitableFor.title')}
          </h2>
          <div className="grid grid-cols-2 gap-3.5 md:grid-cols-4">
            {suitableForSegments.map((s) => (
              <div key={s.key} className="rounded-xl border border-border bg-gradient-to-b from-white to-page-bg p-5 text-center">
                <div className="mx-auto mb-3 flex size-9 items-center justify-center rounded-lg bg-accent/15 text-accent-emphasis">
                  <s.icon className="size-[18px]" aria-hidden="true" />
                </div>
                <p className="text-sm font-bold text-text-primary">{t(`publicSite.home.suitableFor.${s.key}.title`)}</p>
                <p className="mt-1 text-xs leading-relaxed text-text-secondary">{t(`publicSite.home.suitableFor.${s.key}.desc`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ CORE BENEFITS ============ */}
      <section id="features" className="bg-page-bg py-24">
        <div className="mx-auto max-w-6xl px-4">
          <div className="mx-auto mb-14 max-w-xl text-center">
            <p className="mb-3.5 inline-flex items-center gap-2 text-sm font-semibold tracking-wide text-accent-emphasis">
              <span className="h-0.5 w-[18px] rounded-full bg-accent-emphasis" />
              {t('publicSite.home.benefitsEyebrow')}
            </p>
            <h2 className="text-2xl font-bold text-text-primary text-balance md:text-[34px]">{t('publicSite.home.benefitsTitle')}</h2>
            <p className="mt-3.5 text-base leading-relaxed text-text-secondary">{t('publicSite.home.benefitsSubtitle')}</p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 md:grid-cols-3">
            {benefits.map((b) => (
              <div key={b.key} className="flex flex-col gap-3 rounded-2xl border border-border bg-surface p-6">
                <div className="flex size-[42px] items-center justify-center rounded-[11px] bg-dark-base text-accent">
                  <b.icon className="size-5" aria-hidden="true" />
                </div>
                <h3 className="text-base font-bold text-text-primary">{t(`publicSite.home.benefits.${b.key}.title`)}</h3>
                <p className="text-sm leading-relaxed text-text-secondary">{t(`publicSite.home.benefits.${b.key}.desc`)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ HOW IT WORKS ============ */}
      <section id="how-it-works" className="bg-dark-base py-24 text-white">
        <div className="mx-auto max-w-6xl px-4">
          <div className="mx-auto mb-14 max-w-xl text-center">
            <p className="mb-3.5 inline-flex items-center justify-center gap-2 text-sm font-semibold tracking-wide text-accent">
              <span className="h-0.5 w-[18px] rounded-full bg-accent" />
              {t('publicSite.home.howItWorks.eyebrow')}
            </p>
            <h2 className="text-2xl font-bold text-balance md:text-[34px]">{t('publicSite.home.howItWorks.title')}</h2>
            <p className="mt-3.5 text-base leading-relaxed text-white/70">{t('publicSite.home.howItWorks.subtitle')}</p>
          </div>
          <div className="grid gap-6 md:grid-cols-4">
            {howItWorksSteps.map((step, i) => (
              <div key={step} className="flex items-start gap-4 md:flex-col md:items-center md:text-center">
                <div className="flex size-[52px] shrink-0 items-center justify-center rounded-full border border-white/10 bg-dark-secondary text-[15px] font-bold text-accent">
                  {i + 1}
                </div>
                <div>
                  <h4 className="mb-1.5 text-[15px] font-semibold">{t(`publicSite.home.howItWorks.${step}.title`)}</h4>
                  <p className="text-[13.5px] leading-relaxed text-white/55">{t(`publicSite.home.howItWorks.${step}.desc`)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ============ PRICING ============ */}
      {plans.length > 0 && (
        <section id="pricing-preview" className="bg-surface py-24">
          <div className="mx-auto max-w-6xl px-4">
            <div className="mx-auto mb-12 max-w-xl text-center">
              <p className="mb-3.5 inline-flex items-center justify-center gap-2 text-sm font-semibold tracking-wide text-accent-emphasis">
                <span className="h-0.5 w-[18px] rounded-full bg-accent-emphasis" />
                {t('publicSite.home.pricingEyebrow')}
              </p>
              <h2 className="text-2xl font-bold text-text-primary md:text-[34px]">{t('publicSite.home.pricingTitle')}</h2>
              <p className="mt-3.5 text-base leading-relaxed text-text-secondary">{t('publicSite.home.pricingSubtitle')}</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {plans.map((p) => {
                const isFeatured = p.discount_label != null && Number(p.discount_label.match(/\d+/)?.[0] ?? 0) >= 20
                return (
                  <div
                    key={p.name_ar}
                    className={
                      isFeatured
                        ? 'relative flex -translate-y-1.5 flex-col gap-4 rounded-2xl border border-dark-base bg-dark-base p-6 text-white shadow-2xl shadow-dark-base/30'
                        : 'flex flex-col gap-4 rounded-2xl border border-border bg-page-bg p-6'
                    }
                  >
                    {isFeatured && (
                      <span className="absolute -top-3 start-6 rounded-full bg-accent px-3 py-1 text-[11.5px] font-bold text-accent-foreground">
                        {t('publicSite.home.mostPopular')}
                      </span>
                    )}
                    <p className={isFeatured ? 'text-sm font-semibold text-white/70' : 'text-sm font-semibold text-text-secondary'}>
                      {i18n.language.startsWith('ar') ? p.name_ar : t(`publicSite.pricing.intervals.${p.billing_interval}_${p.billing_interval_count}`)}
                    </p>
                    <MoneyDisplay amount={Number(p.price)} currency={p.currency ?? 'EGP'} size="lg" className={isFeatured ? 'text-white' : undefined} />
                    {p.discount_label && (
                      <p className={isFeatured ? 'text-[12.5px] font-semibold text-green-300' : 'text-[12.5px] font-semibold text-status-success'}>
                        {i18n.language.startsWith('ar') ? p.discount_label : t(`publicSite.pricing.discounts.${p.billing_interval}_${p.billing_interval_count}`)}
                      </p>
                    )}
                    <Button size="sm" className={isFeatured ? 'mt-1 bg-accent text-accent-foreground hover:bg-accent/90' : 'mt-1'} variant={isFeatured ? 'default' : 'outline'} asChild>
                      <Link to="/signup">{t('publicSite.home.startFreeTrial')}</Link>
                    </Button>
                  </div>
                )
              })}
            </div>
          </div>
        </section>
      )}

      {/* ============ FINAL CTA ============ */}
      <section className="bg-dark-base px-4 pb-24">
        <div className="mx-auto max-w-6xl overflow-hidden rounded-3xl bg-gradient-to-br from-accent-light via-accent to-accent-dark px-6 py-14 text-center text-dark-base md:px-10 md:py-16">
          <h2 className="text-2xl font-bold md:text-[30px]">{t('publicSite.home.finalCta.title')}</h2>
          <p className="mt-3 text-[15px] text-dark-base/75">{t('publicSite.home.finalCta.subtitle')}</p>
          <Button size="lg" className="mt-7 bg-dark-base text-white hover:bg-dark-base/90" asChild>
            <Link to="/signup">{t('publicSite.home.startFreeTrial')}</Link>
          </Button>
        </div>
      </section>

      {/* ============ FAQ ============ */}
      <section className="bg-page-bg py-24">
        <div className="mx-auto max-w-3xl px-4">
          <h2 className="mb-10 text-center text-2xl font-bold text-text-primary md:text-[34px]">{t('publicSite.home.faq.title')}</h2>
          <div className="flex flex-col gap-2.5">
            {faqItems.map((q, i) => (
              <details key={q} className="group rounded-xl border border-border bg-surface px-5 py-4" open={i === 0}>
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-semibold text-text-primary">
                  {t(`publicSite.home.faq.${q}.question`)}
                  <ChevronDown className="size-[18px] shrink-0 text-text-secondary transition-transform group-open:rotate-180" aria-hidden="true" />
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-text-secondary">{t(`publicSite.home.faq.${q}.answer`)}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  )
}
