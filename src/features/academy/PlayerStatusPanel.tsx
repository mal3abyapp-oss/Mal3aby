import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { SUBSCRIPTION_STATUS_LABELS } from '@/lib/domain/academy'

// Section I4 — Player Profile: a player's own detail dialog previously
// showed only name/DOB/gender/status + guardians + QR -- none of the
// group/subscription/financial/attendance state a receptionist or
// academy manager actually needs when a parent asks "where does my
// child stand." This summary panel surfaces all of it directly.

interface PlayerStatus {
  groupName: string | null
  subscriptionStatus: string | null
  startDate: string | null
  endDate: string | null
  effectiveEndDate: string | null
  outstanding: number
  attendanceRate: number | null
  attendanceCount: { present: number; total: number }
}

async function fetchPlayerStatus(playerId: string): Promise<PlayerStatus> {
  const { data: enrollment } = await supabase
    .from('enrollments')
    .select('id, group_id, groups(name)')
    .eq('player_id', playerId)
    .eq('status', 'active')
    .maybeSingle()

  let subscriptionStatus: string | null = null
  let startDate: string | null = null
  let endDate: string | null = null
  let effectiveEndDate: string | null = null
  let outstanding = 0

  if (enrollment) {
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('id, status, start_date, end_date, price, discount, invoice_id')
      .eq('enrollment_id', enrollment.id)
      .maybeSingle()

    if (subscription) {
      subscriptionStatus = subscription.status
      startDate = subscription.start_date
      endDate = subscription.end_date
      effectiveEndDate = subscription.end_date

      const { data: effectiveEnd } = await supabase.rpc('get_subscription_effective_end_date', { p_subscription_id: subscription.id })
      if (effectiveEnd) effectiveEndDate = effectiveEnd as string

      if (subscription.invoice_id) {
        const { data: allocations } = await supabase.from('payment_allocations').select('amount').eq('invoice_id', subscription.invoice_id)
        const paid = (allocations ?? []).reduce((sum, a) => sum + Number(a.amount), 0)
        const total = Number(subscription.price) - Number(subscription.discount)
        outstanding = Math.max(total - paid, 0)
      }
    }
  }

  const { data: attendanceRows } = await supabase.from('attendance').select('status').eq('player_id', playerId)
  const total = attendanceRows?.length ?? 0
  const present = (attendanceRows ?? []).filter((a) => a.status === 'present').length

  return {
    groupName: (enrollment?.groups as unknown as { name: string } | null)?.name ?? null,
    subscriptionStatus,
    startDate,
    endDate,
    effectiveEndDate,
    outstanding,
    attendanceRate: total > 0 ? Math.round((present / total) * 100) : null,
    attendanceCount: { present, total },
  }
}

export function PlayerStatusPanel({ playerId }: { playerId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['player-status', playerId],
    queryFn: () => fetchPlayerStatus(playerId),
    enabled: !!playerId,
  })

  if (isLoading || !data) return <p className="text-sm text-text-secondary">جارٍ التحميل...</p>

  if (!data.groupName) {
    return <p className="rounded-md bg-muted/30 p-2 text-sm text-text-secondary">هذا اللاعب غير مسجّل في أي مجموعة حاليًا.</p>
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3 text-sm">
      <div className="flex items-center justify-between">
        <span className="font-medium">{data.groupName}</span>
        {data.subscriptionStatus && (
          <StatusBadge
            tone={data.subscriptionStatus === 'active' ? 'success' : data.subscriptionStatus === 'frozen' ? 'warning' : data.subscriptionStatus === 'pending' ? 'warning' : 'neutral'}
            label={SUBSCRIPTION_STATUS_LABELS[data.subscriptionStatus] ?? data.subscriptionStatus}
          />
        )}
      </div>
      {data.startDate && data.endDate && (
        <p className="text-text-secondary">
          من {data.startDate} إلى {data.endDate}
          {data.effectiveEndDate && data.effectiveEndDate !== data.endDate && (
            <span className="text-status-warning"> (فعليًا حتى {data.effectiveEndDate} بعد التجميد)</span>
          )}
        </p>
      )}
      <div className="flex items-center justify-between">
        <span className="text-text-secondary">المستحق</span>
        {data.outstanding > 0 ? (
          <MoneyDisplay amount={data.outstanding} tone="danger" size="sm" />
        ) : (
          <span className="text-status-success">مدفوع بالكامل</span>
        )}
      </div>
      <div className="flex items-center justify-between">
        <span className="text-text-secondary">نسبة الحضور</span>
        {data.attendanceRate != null ? (
          <span className="tabular-nums font-medium">{data.attendanceRate}% ({data.attendanceCount.present}/{data.attendanceCount.total})</span>
        ) : (
          <span className="text-text-secondary">لا يوجد سجل حضور بعد</span>
        )}
      </div>
    </div>
  )
}
