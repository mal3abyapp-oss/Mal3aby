import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Button } from '@/components/ui/button'

// public_plans-sourced only, no hardcoded prices, no "Buy"/"Checkout"
// language anywhere on this page — see docs/ARCHITECTURE.md
// #public-website--layout-strategy.
async function fetchPlans() {
  const { data, error } = await supabase.from('public_plans').select('*').order('price')
  if (error) throw error
  return data ?? []
}

export function PricingPage() {
  const { t } = useTranslation()
  const { data: plans = [], isLoading } = useQuery({ queryKey: ['public-plans-pricing'], queryFn: fetchPlans })

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <PageHeader title={t('publicSite.pricing.title')} description={t('publicSite.pricing.description')} />
      {isLoading ? null : plans.length === 0 ? (
        <p className="text-center text-text-secondary">{t('publicSite.pricing.unavailable')}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          {plans.map((p) => (
            <Card key={p.name_ar}>
              <CardHeader>
                <CardTitle>{p.name_ar}</CardTitle>
                {p.description_ar && <p className="text-sm text-text-secondary">{p.description_ar}</p>}
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <MoneyDisplay amount={Number(p.price)} currency={p.currency ?? 'EGP'} size="lg" />
                {p.discount_label && <p className="text-sm text-status-success">{p.discount_label}</p>}
                {p.features_summary && <p className="text-sm text-text-secondary">{p.features_summary}</p>}
                <Button asChild className="mt-2">
                  <Link to="/signup">{t('publicSite.pricing.startFreeTrial')}</Link>
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
