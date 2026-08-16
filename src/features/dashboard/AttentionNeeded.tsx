import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'

// Section D1 "ATTENTION NEEDED": a receptionist/manager must be able to
// see, in one place, everything that needs a decision right now --
// unpaid confirmed bookings, bookings starting soon with no check-in
// yet, and academy subscriptions expiring within 3 days. Each row is
// clickable straight into the screen that can act on it.

interface AttentionItem {
  id: string
  kind: 'unpaid' | 'starting-soon' | 'expiring-subscription'
  label: string
  detail: string
  to: string
}

async function fetchAttentionItems(clubId: string): Promise<AttentionItem[]> {
  const today = new Date().toISOString().slice(0, 10)
  const now = new Date()
  const soonCutoff = new Date(now.getTime() + 60 * 60 * 1000).toISOString() // next 60 min

  const [unpaidRes, soonRes, expiringRes] = await Promise.all([
    supabase
      .from('bookings')
      .select('id, start_at, total_price, customers(full_name)')
      .eq('club_id', clubId)
      .eq('status', 'confirmed')
      .gte('start_at', `${today}T00:00:00`)
      .lte('start_at', `${today}T23:59:59`)
      .limit(10),
    supabase
      .from('bookings')
      .select('id, start_at, customers(full_name)')
      .eq('club_id', clubId)
      .in('status', ['confirmed', 'pending_payment'])
      .gte('start_at', now.toISOString())
      .lte('start_at', soonCutoff)
      .limit(10),
    supabase
      .from('subscriptions')
      .select('id, end_date, enrollment_id, enrollments(players(full_name))')
      .eq('club_id', clubId)
      .eq('status', 'active')
      .gte('end_date', today)
      .lte('end_date', new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10))
      .limit(10),
  ])

  const items: AttentionItem[] = []

  for (const b of unpaidRes.data ?? []) {
    const name = (b.customers as unknown as { full_name: string } | null)?.full_name ?? '—'
    items.push({
      id: `unpaid-${b.id}`,
      kind: 'unpaid',
      label: `حجز مؤكد بدون دفع كامل — ${name}`,
      detail: `${Number(b.total_price).toFixed(0)} ج.م`,
      to: '/app/bookings',
    })
  }

  for (const b of soonRes.data ?? []) {
    const name = (b.customers as unknown as { full_name: string } | null)?.full_name ?? '—'
    items.push({
      id: `soon-${b.id}`,
      kind: 'starting-soon',
      label: `موعد قريب لم يتم تسجيل الحضور — ${name}`,
      detail: new Date(b.start_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' }),
      to: '/app/bookings',
    })
  }

  for (const s of expiringRes.data ?? []) {
    const playerName = (s.enrollments as unknown as { players: { full_name: string } | null } | null)?.players?.full_name ?? '—'
    items.push({
      id: `expiring-${s.id}`,
      kind: 'expiring-subscription',
      label: `اشتراك أكاديمية على وشك الانتهاء — ${playerName}`,
      detail: s.end_date,
      to: '/app/academy',
    })
  }

  return items
}

const KIND_TONE = {
  unpaid: 'warning',
  'starting-soon': 'danger',
  'expiring-subscription': 'warning',
} as const

const KIND_CHIP_LABEL: Record<AttentionItem['kind'], string> = {
  unpaid: 'دفع',
  'starting-soon': 'عاجل',
  'expiring-subscription': 'تجديد',
}

export function AttentionNeeded() {
  const { currentClubId } = useAuth()
  const navigate = useNavigate()

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['attention-needed', currentClubId],
    queryFn: () => fetchAttentionItems(currentClubId!),
    enabled: !!currentClubId,
    refetchInterval: 60_000,
  })

  if (isLoading) return null

  if (items.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">يحتاج انتباه</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-status-success">لا يوجد ما يحتاج انتباهًا الآن.</p></CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">يحتاج انتباه ({items.length})</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => navigate(item.to)}
            className="flex items-center justify-between gap-2 rounded-md border border-border p-2.5 text-start text-sm hover:bg-muted/40"
          >
            <span>{item.label}</span>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-xs text-text-secondary tabular-nums">{item.detail}</span>
              <StatusBadge tone={KIND_TONE[item.kind]} label={KIND_CHIP_LABEL[item.kind]} />
            </div>
          </button>
        ))}
      </CardContent>
    </Card>
  )
}
