import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { Skeleton } from '@/components/ui/skeleton'

// Phase 3b frontend scope: read-only summary only, sourced from the
// restricted club_platform_subscription_summary view (never the raw
// platform_subscriptions table — ADR-035). Full Platform Owner console is
// Phase 3c.
const ACCESS_LABELS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  full: { label: 'نشط بالكامل', tone: 'success' },
  grace: { label: 'فترة سماح', tone: 'warning' },
  blocked: { label: 'موقوف', tone: 'danger' },
}

const KIND_LABELS: Record<string, string> = {
  trial: 'تجربة مجانية',
  paid: 'مدفوع',
  complimentary: 'مجاني (منحة)',
}

async function fetchSubscriptionSummary(clubId: string) {
  const { data, error } = await supabase
    .from('club_platform_subscription_summary')
    .select('*')
    .eq('club_id', clubId)
    .maybeSingle()

  if (error) throw error
  return data
}

export function PlatformSubscriptionCard() {
  const { currentClubId } = useAuth()

  const { data, isLoading } = useQuery({
    queryKey: ['platform-subscription-summary', currentClubId],
    queryFn: () => fetchSubscriptionSummary(currentClubId!),
    enabled: !!currentClubId,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">اشتراك المنصة</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : !data ? (
          <p className="text-sm text-text-secondary">لا يوجد اشتراك نشط لهذا النادي.</p>
        ) : (
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-text-secondary">الحالة:</span>
              <StatusBadge
                tone={ACCESS_LABELS[data.effective_access ?? 'blocked']?.tone ?? 'neutral'}
                label={ACCESS_LABELS[data.effective_access ?? 'blocked']?.label ?? data.effective_access ?? '—'}
              />
            </div>
            <div>
              <span className="text-text-secondary">نوع الاشتراك: </span>
              {KIND_LABELS[data.subscription_kind ?? ''] ?? data.subscription_kind}
            </div>
            {data.plan_name_snapshot && (
              <div>
                <span className="text-text-secondary">الخطة: </span>
                {data.plan_name_snapshot}
              </div>
            )}
            <div>
              <span className="text-text-secondary">تاريخ الانتهاء: </span>
              {data.end_at ? new Date(data.end_at).toLocaleDateString('ar-EG') : '—'}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
