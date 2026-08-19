import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { fetchInvoicePaymentSummaries } from '@/lib/domain/billing'

// Section D1 "ATTENTION NEEDED": a receptionist/manager must be able to
// see, in one place, everything that needs a decision right now --
// unpaid confirmed bookings, bookings starting soon with no check-in
// yet, and academy subscriptions expiring within 3 days. Each row is
// clickable straight into the screen that can act on it.
//
// Master Payment Directive task #81 (Section 19: operational status !=
// payment status): the "unpaid" query used to trust
// bookings.status = 'confirmed' alone, with zero join against actual
// payment state -- a confirmed booking that was ALREADY fully paid
// still showed up here as needing payment, confirmed against real data
// in AUTONOMOUS_DECISION_LOG.md D-015. Now filters through
// get_invoice_payment_summary() so only bookings with a genuinely
// nonzero outstanding balance appear.
//
// HIGH-ROI UX PASS 01, Priority 4 (Today exception-first): the design
// audit found Today had no signal at all for two genuinely
// time-sensitive exceptions -- customer-uploaded payment proofs
// awaiting review (a real customer's payment-hold countdown is running
// while it sits unreviewed) and WhatsApp messages that failed
// permanently. Rather than build a second, competing "exceptions"
// panel on Today (which the directive explicitly warns against as
// dashboard noise), both are added as two more AttentionItem kinds
// here -- this component already IS Today's single actionable-exception
// surface, so extending it is the correct, non-duplicative fix.

interface AttentionItem {
  id: string
  kind: 'unpaid' | 'starting-soon' | 'expiring-subscription' | 'pending-payment-proof' | 'whatsapp-failed'
  label: string
  detail: string
  to: string
}

async function fetchAttentionItems(clubId: string, t: TFunction, locale: 'ar' | 'en'): Promise<AttentionItem[]> {
  const today = new Date().toISOString().slice(0, 10)
  const now = new Date()
  const soonCutoff = new Date(now.getTime() + 60 * 60 * 1000).toISOString() // next 60 min

  const [unpaidRes, soonRes, expiringRes, pendingProofsRes, whatsappDiagRes] = await Promise.all([
    supabase
      .from('bookings')
      .select('id, start_at, total_price, invoice_id, customers(full_name)')
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
    supabase
      .from('payment_proofs')
      .select('id, amount, uploaded_at, bookings(hold_expires_at, customer_id, customers(full_name))')
      .eq('club_id', clubId)
      .eq('status', 'pending_review')
      .order('uploaded_at', { ascending: true })
      .limit(10),
    supabase
      .from('whatsapp_queue_diagnostics')
      .select('failed_count')
      .eq('club_id', clubId)
      .maybeSingle(),
  ])

  const items: AttentionItem[] = []

  const unpaidBookings = unpaidRes.data ?? []
  const unpaidInvoiceIds = unpaidBookings.map((b) => b.invoice_id).filter((id): id is string => !!id)
  const unpaidSummaries = await fetchInvoicePaymentSummaries(unpaidInvoiceIds)

  for (const b of unpaidBookings) {
    // A confirmed booking with no invoice yet is definitionally unpaid;
    // one with an invoice is only genuinely unpaid if its real
    // outstanding balance (net of refunds) is still > 0 -- not just
    // because its operational status happens to be 'confirmed'.
    const outstanding = b.invoice_id ? (unpaidSummaries.get(b.invoice_id)?.outstanding ?? 0) : Number(b.total_price)
    if (outstanding <= 0) continue
    const name = (b.customers as unknown as { full_name: string } | null)?.full_name ?? '—'
    items.push({
      id: `unpaid-${b.id}`,
      kind: 'unpaid',
      label: t('dashboard.attentionNeeded.unpaidBooking', { name }),
      detail: t('dashboard.attentionNeeded.amountEgp', { amount: outstanding.toFixed(0) }),
      to: '/app/bookings',
    })
  }

  for (const b of soonRes.data ?? []) {
    const name = (b.customers as unknown as { full_name: string } | null)?.full_name ?? '—'
    items.push({
      id: `soon-${b.id}`,
      kind: 'starting-soon',
      label: t('dashboard.attentionNeeded.startingSoon', { name }),
      detail: new Date(b.start_at).toLocaleTimeString(locale === 'en' ? 'en-US' : 'ar-EG', { hour: '2-digit', minute: '2-digit' }),
      to: '/app/bookings',
    })
  }

  for (const s of expiringRes.data ?? []) {
    const playerName = (s.enrollments as unknown as { players: { full_name: string } | null } | null)?.players?.full_name ?? '—'
    items.push({
      id: `expiring-${s.id}`,
      kind: 'expiring-subscription',
      label: t('dashboard.attentionNeeded.expiringSubscription', { name: playerName }),
      detail: s.end_date,
      to: '/app/academy',
    })
  }

  // HIGH-ROI UX PASS 01, Priority 4: pending payment proofs, ordered
  // oldest-first (the ones closest to their booking's hold_expires_at
  // deserve attention first). detail shows minutes remaining when the
  // linked booking is still holding a slot -- matches the directive's
  // explicit "don't rely on color alone" instruction by putting the
  // urgency as text, not just a badge tone.
  for (const p of pendingProofsRes.data ?? []) {
    const booking = p.bookings as unknown as { hold_expires_at: string | null; customers: { full_name: string } | null } | null
    const name = booking?.customers?.full_name ?? '—'
    let detail = t('dashboard.attentionNeeded.amountEgp', { amount: Number(p.amount).toFixed(0) })
    if (booking?.hold_expires_at) {
      const minutesLeft = Math.round((new Date(booking.hold_expires_at).getTime() - now.getTime()) / 60000)
      if (minutesLeft > 0) {
        detail = t('dashboard.attentionNeeded.holdMinutesLeft', { minutes: minutesLeft })
      }
    }
    items.push({
      id: `proof-${p.id}`,
      kind: 'pending-payment-proof',
      label: t('dashboard.attentionNeeded.pendingPaymentProof', { name }),
      detail,
      to: '/app/pending-payments',
    })
  }

  // HIGH-ROI UX PASS 01, Priority 4: a single summary row (not one row
  // per failed message -- that level of detail belongs on the WhatsApp
  // Activity tab, which this row links to) when any WhatsApp message
  // has permanently failed for this club.
  const failedWhatsappCount = whatsappDiagRes.data?.failed_count ?? 0
  if (failedWhatsappCount > 0) {
    items.push({
      id: 'whatsapp-failed-summary',
      kind: 'whatsapp-failed',
      label: t('dashboard.attentionNeeded.whatsappFailed', { count: failedWhatsappCount }),
      detail: '',
      to: '/app/whatsapp',
    })
  }

  return items
}

const KIND_TONE = {
  unpaid: 'warning',
  'starting-soon': 'danger',
  'expiring-subscription': 'warning',
  'pending-payment-proof': 'warning',
  'whatsapp-failed': 'danger',
} as const

export function AttentionNeeded() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const navigate = useNavigate()
  const { locale } = useDirection()

  const KIND_CHIP_LABEL: Record<AttentionItem['kind'], string> = {
    unpaid: t('dashboard.attentionNeeded.chipLabels.unpaid'),
    'starting-soon': t('dashboard.attentionNeeded.chipLabels.startingSoon'),
    'expiring-subscription': t('dashboard.attentionNeeded.chipLabels.expiringSubscription'),
    'pending-payment-proof': t('dashboard.attentionNeeded.chipLabels.pendingPaymentProof'),
    'whatsapp-failed': t('dashboard.attentionNeeded.chipLabels.whatsappFailed'),
  }

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['attention-needed', currentClubId, locale],
    queryFn: () => fetchAttentionItems(currentClubId!, t, locale),
    enabled: !!currentClubId,
    refetchInterval: 60_000,
  })

  if (isLoading) return null

  if (items.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">{t('dashboard.attentionNeeded.title')}</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-status-success">{t('dashboard.attentionNeeded.nothingNow')}</p></CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">{t('dashboard.attentionNeeded.titleWithCount', { count: items.length })}</CardTitle></CardHeader>
      <CardContent className="flex flex-col gap-2">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => navigate(item.to)}
            className="flex items-center justify-between gap-2 rounded-md border border-border p-2.5 text-start text-sm hover:bg-muted/40"
          >
            <span>{item.label}</span>
            <div className="flex shrink-0 items-center gap-2">
              {item.detail && <span className="text-xs text-text-secondary tabular-nums">{item.detail}</span>}
              <StatusBadge tone={KIND_TONE[item.kind]} label={KIND_CHIP_LABEL[item.kind]} />
            </div>
          </button>
        ))}
      </CardContent>
    </Card>
  )
}
