import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { CalendarDays, GraduationCap, Receipt, ScanLine, BarChart3, UserCog } from 'lucide-react'

// See docs/USER_FLOWS.md Flow 8, docs/SCREEN_MAP.md Home. Pricing preview
// reads only the public_plans view (never platform_plans directly) — see
// docs/ARCHITECTURE.md#public-website--layout-strategy.
const features = [
  { icon: CalendarDays, labelKey: 'publicSite.home.features.bookings' },
  { icon: GraduationCap, labelKey: 'publicSite.home.features.academy' },
  { icon: Receipt, labelKey: 'publicSite.home.features.invoicesAndPayments' },
  { icon: ScanLine, labelKey: 'publicSite.home.features.qr' },
  { icon: BarChart3, labelKey: 'publicSite.home.features.reports' },
  { icon: UserCog, labelKey: 'publicSite.home.features.staffManagement' },
]

async function fetchPublicPlans() {
  const { data, error } = await supabase.from('public_plans').select('*')
  if (error) throw error
  return data ?? []
}

export function HomePage() {
  const { t } = useTranslation()
  const { data: plans = [] } = useQuery({ queryKey: ['public-plans-home'], queryFn: fetchPublicPlans })

  return (
    <>
      <section className="bg-dark-base text-white">
        <div className="mx-auto max-w-4xl px-4 py-24 text-center">
          <h1 className="text-3xl font-bold md:text-5xl">
            {t('publicSite.home.heroTitle')}
          </h1>
          <p className="mt-4 text-lg text-white/70">
            {t('publicSite.home.heroSubtitle')}
          </p>
          <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
            <Button size="lg" className="bg-accent text-accent-foreground hover:bg-accent/90" asChild>
              <Link to="/signup">{t('publicSite.home.startFreeTrial')}</Link>
            </Button>
            <Button size="lg" variant="outline" className="border-white/30 bg-transparent text-white hover:bg-white/10" asChild>
              <Link to="/login">{t('publicSite.home.login')}</Link>
            </Button>
          </div>
          <p className="mt-3 text-sm text-white/50">{t('publicSite.home.trialBadge')}</p>
        </div>
      </section>

      <section id="features" className="mx-auto max-w-5xl px-4 py-16">
        <h2 className="text-center text-2xl font-bold text-text-primary">{t('publicSite.home.featuresTitle')}</h2>
        <div className="mt-8 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-6">
          {features.map((f) => (
            <div key={f.labelKey} className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-4">
              <f.icon className="size-6 text-accent-foreground" />
              <span className="text-sm text-text-secondary">{t(f.labelKey)}</span>
            </div>
          ))}
        </div>
      </section>

      {plans.length > 0 && (
        <section id="pricing-preview" className="bg-muted/30 px-4 py-16">
          <h2 className="text-center text-2xl font-bold text-text-primary">{t('publicSite.home.pricingTitle')}</h2>
          <div className="mx-auto mt-8 grid max-w-4xl gap-4 sm:grid-cols-2 md:grid-cols-4">
            {plans.map((p) => (
              <Card key={p.name_ar}>
                <CardHeader>
                  <CardTitle className="text-base">{p.name_ar}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-2">
                  <MoneyDisplay amount={Number(p.price)} currency={p.currency ?? 'EGP'} size="lg" />
                  {p.discount_label && <p className="text-sm text-status-success">{p.discount_label}</p>}
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="mt-8 flex justify-center">
            <Button size="lg" asChild>
              <Link to="/signup">{t('publicSite.home.startFreeTrial')}</Link>
            </Button>
          </div>
        </section>
      )}
    </>
  )
}
