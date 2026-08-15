import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'

// Club Owner's own-club subscription view. Scoped to the restricted
// club_platform_subscription_summary view only — never platform_invoices/
// platform_payments directly (ADR-035: "own club's commercial summary
// only"). No self-service payment recording — "contact us to activate"
// only, matching the no-online-payment-gateway product decision.
const ACCESS_LABEL: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  full: { label: 'نشط', tone: 'success' },
  grace: { label: 'فترة سماح', tone: 'warning' },
  blocked: { label: 'موقوف', tone: 'danger' },
}

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
  const { data: summary, isLoading } = useQuery({
    queryKey: ['subscription-summary', currentClubId],
    queryFn: () => fetchSummary(currentClubId!),
    enabled: !!currentClubId,
  })
  const { data: plans = [] } = useQuery({ queryKey: ['public-plans-subscription'], queryFn: fetchPublicPlans })

  return (
    <div>
      <PageHeader title="اشتراك النادي" description="حالة اشتراكك في منصة ملعبي" />

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">الحالة الحالية</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-text-secondary">جارٍ التحميل...</p>
          ) : !summary ? (
            <p className="text-sm text-text-secondary">لا يوجد اشتراك نشط.</p>
          ) : (
            <div className="flex flex-col gap-2 text-sm">
              <StatusBadge
                tone={ACCESS_LABEL[summary.effective_access ?? 'blocked']?.tone ?? 'danger'}
                label={ACCESS_LABEL[summary.effective_access ?? 'blocked']?.label ?? 'موقوف'}
              />
              <p>النوع: {summary.subscription_kind === 'trial' ? 'تجربة مجانية' : summary.subscription_kind}</p>
              {summary.plan_name_snapshot && <p>الخطة: {summary.plan_name_snapshot}</p>}
              <p>تاريخ الانتهاء: {summary.end_at ? new Date(summary.end_at).toLocaleDateString('ar-EG') : '—'}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">الخطط المتاحة</CardTitle>
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
            لتفعيل أو تجديد اشتراكك، تواصل معنا وسنقوم بتفعيله لك.
          </p>
          <Button asChild className="w-fit">
            <a href="https://wa.me/201000000000" target="_blank" rel="noreferrer">
              تواصل معنا لتفعيل الاشتراك
            </a>
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
