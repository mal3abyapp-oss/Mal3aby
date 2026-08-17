import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { Separator } from '@/components/ui/separator'
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONE, type BookingRow } from '@/lib/domain/booking'
import { formatInstant } from '@/lib/domain/time'
import { fetchInvoicePaymentSummaries, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, type InvoicePaymentSummary } from '@/lib/domain/billing'
import { translateSupabaseError } from '@/lib/errors'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MessageCircle } from 'lucide-react'

// IA restructuring (Phase 8): "independent but connected" -- WhatsApp
// management lives entirely in its own module now (/app/whatsapp), but
// a booking is exactly the kind of place a staff member wants a quick
// "did we actually notify this customer?" answer without leaving the
// booking they're already looking at. Reads the same notification_queue
// data the Activity tab reads, scoped to this booking's own events via
// notification_events.reference_id -- summary only, no send/retry
// controls here (those stay in the WhatsApp module, avoiding duplicated
// business logic).
interface WhatsAppSummary {
  sentCount: number
  failedCount: number
  pendingCount: number
}

async function fetchBookingWhatsAppSummary(bookingId: string): Promise<WhatsAppSummary> {
  const { data: events, error: eventsError } = await supabase
    .from('notification_events')
    .select('id')
    .eq('reference_type', 'booking')
    .eq('reference_id', bookingId)
  if (eventsError) throw eventsError
  const eventIds = (events ?? []).map((e) => e.id)
  if (eventIds.length === 0) return { sentCount: 0, failedCount: 0, pendingCount: 0 }

  const { data: rows, error: queueError } = await supabase
    .from('notification_queue')
    .select('status')
    .eq('channel', 'whatsapp')
    .in('event_id', eventIds)
  if (queueError) throw queueError

  const summary = { sentCount: 0, failedCount: 0, pendingCount: 0 }
  for (const r of rows ?? []) {
    if (r.status === 'sent') summary.sentCount++
    else if (r.status === 'failed' || r.status === 'expired') summary.failedCount++
    else summary.pendingCount++
  }
  return summary
}

// Section E4 — Booking Detail: everything an employee needs to act on a
// booking, surfaced directly (not behind further navigation): customer,
// field, time, price, payment status, and every permitted action.
//
// Master Payment Directive task #81: this used to compute
// total - sum(payment_allocations) locally, missing refund netting --
// a booking paid in full then partially refunded showed too-LOW an
// outstanding balance here vs. the correct figure on OutstandingPage/
// CustomersPage. Now reads get_invoice_payment_summary(), the single
// source of truth (see AUTONOMOUS_DECISION_LOG.md D-015).
async function fetchInvoiceSummary(invoiceId: string): Promise<InvoicePaymentSummary | null> {
  const summaries = await fetchInvoicePaymentSummaries([invoiceId])
  return summaries.get(invoiceId) ?? null
}

export function BookingDetailSheet({
  booking,
  fieldName,
  clubTimezone,
  onOpenChange,
  onChanged,
}: {
  booking: BookingRow | null
  fieldName: string
  clubTimezone: string
  onOpenChange: (open: boolean) => void
  onChanged: () => void
}) {
  const [cancelReason, setCancelReason] = useState('')
  const [showCancelForm, setShowCancelForm] = useState(false)
  // Owner-level review finding (P1, confirmed live): "تسجيل عدم حضور"
  // fired noShowMutation directly on click with zero confirmation --
  // one misclick during this review genuinely marked a real, confirmed
  // booking as no_show in the live database (reverted via direct SQL
  // once caught). The adjacent "إلغاء الحجز" action in this same file
  // already has a two-step reveal-then-confirm pattern (showCancelForm)
  // -- No-Show is at least as consequential (customer-facing status,
  // no undo UI) and had none. Mirrors that exact existing pattern
  // rather than introducing a new confirmation-dialog component.
  const [showNoShowConfirm, setShowNoShowConfirm] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // IA restructuring (Phase 9, Booking 360): confirmed in the audit --
  // this sheet showed the outstanding balance read-only with no way to
  // act on it; staff had to leave the booking and search for its
  // invoice on BillingPage just to collect a payment. Reuses
  // BillingPage's own record_payment() RPC call directly (same params,
  // same server-side validation) rather than duplicating payment logic
  // -- this is a single-line quick-collect for the exact outstanding
  // amount, not a replacement for BillingPage's full split-payment UI.
  const [showCollectForm, setShowCollectForm] = useState(false)
  const [collectAmount, setCollectAmount] = useState('')
  const [collectMethod, setCollectMethod] = useState('cash')
  const queryClient = useQueryClient()

  const { data: invoiceSummary } = useQuery({
    queryKey: ['booking-invoice-summary', booking?.invoiceId],
    queryFn: () => fetchInvoiceSummary(booking!.invoiceId!),
    enabled: !!booking?.invoiceId,
  })

  const { data: whatsappSummary } = useQuery({
    queryKey: ['booking-whatsapp-summary', booking?.id],
    queryFn: () => fetchBookingWhatsAppSummary(booking!.id),
    enabled: !!booking?.id,
  })

  const qrMutation = useMutation({
    mutationFn: async () => {
      if (!booking) throw new Error('no booking selected')
      const { data, error } = await supabase.rpc('ensure_booking_qr', { p_booking_id: booking.id })
      if (error) throw error
      return data as string
    },
    onSuccess: async (rawToken) => {
      const dataUrl = await QRCode.toDataURL(rawToken, { width: 240, margin: 1 })
      setQrDataUrl(dataUrl)
    },
    onError: () => setActionError('تعذّر إنشاء رمز QR.'),
  })

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!booking) throw new Error('no booking selected')
      const { error } = await supabase.rpc('cancel_booking', { p_booking_id: booking.id, p_reason: cancelReason })
      if (error) throw error
    },
    onSuccess: () => {
      onOpenChange(false)
      onChanged()
    },
    onError: () => setActionError('تعذّر إلغاء الحجز.'),
  })

  const noShowMutation = useMutation({
    mutationFn: async () => {
      if (!booking) throw new Error('no booking selected')
      const { error } = await supabase.rpc('mark_booking_no_show', { p_booking_id: booking.id })
      if (error) throw error
    },
    onSuccess: () => {
      setShowNoShowConfirm(false)
      onOpenChange(false)
      onChanged()
    },
    onError: () => setActionError('تعذّر تسجيل عدم الحضور.'),
  })

  const outstanding = invoiceSummary ? invoiceSummary.outstanding : booking?.totalPrice ?? 0

  const collectPaymentMutation = useMutation({
    mutationFn: async () => {
      if (!booking?.invoiceId) throw new Error('no invoice to collect against')
      const amount = Number(collectAmount)
      if (!amount || amount <= 0) throw new Error('أدخل مبلغًا صحيحًا')
      if (amount - outstanding > 0.01) {
        throw new Error(`المبلغ (${amount.toFixed(2)}) يتجاوز المتبقي (${outstanding.toFixed(2)})`)
      }
      const { error } = await supabase.rpc('record_payment', {
        p_invoice_id: booking.invoiceId,
        p_amount: amount,
        p_method: collectMethod,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setShowCollectForm(false)
      setCollectAmount('')
      setActionError(null)
      void queryClient.invalidateQueries({ queryKey: ['booking-invoice-summary', booking?.invoiceId] })
      onChanged()
    },
    onError: (error) => setActionError(error instanceof Error && !('code' in error) ? error.message : translateSupabaseError(error, 'تعذّر تسجيل الدفعة.')),
  })

  return (
    <Sheet
      open={!!booking}
      onOpenChange={(open) => {
        if (!open) {
          setQrDataUrl(null)
          setShowCancelForm(false)
          setCancelReason('')
          setActionError(null)
          setShowCollectForm(false)
          setCollectAmount('')
        }
        onOpenChange(open)
      }}
    >
      <SheetContent className="flex w-full flex-col overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>تفاصيل الحجز</SheetTitle>
        </SheetHeader>

        {booking && (
          <div className="flex flex-1 flex-col gap-4 py-4 text-sm">
            <div className="flex items-center justify-between">
              <StatusBadge tone={BOOKING_STATUS_TONE[booking.status] ?? 'neutral'} label={BOOKING_STATUS_LABELS[booking.status] ?? booking.status} />
              <span className="text-xs text-text-secondary tabular-nums">
                {formatInstant(booking.startAt, clubTimezone, { day: 'numeric', month: 'long' })}
              </span>
            </div>

            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-text-secondary">العميل</p>
              <p className="font-semibold">{booking.customerName}</p>
              {booking.customerMobile && <p className="text-text-secondary tabular-nums">{booking.customerMobile}</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-text-secondary">الملعب</p>
                <p className="font-medium">{fieldName}</p>
              </div>
              <div>
                <p className="text-xs text-text-secondary">الوقت</p>
                {/* Same RTL bidi-swap risk as StatCard's composite values
                    (owner-level review finding) -- isolates the time
                    range's direction from the surrounding Arabic context. */}
                <p className="font-medium tabular-nums">
                  <bdi>
                    {formatInstant(booking.startAt, clubTimezone, { hour: '2-digit', minute: '2-digit' })}
                    {' — '}
                    {formatInstant(booking.endAt, clubTimezone, { hour: '2-digit', minute: '2-digit' })}
                  </bdi>
                </p>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between">
                <span className="text-text-secondary">الإجمالي</span>
                <span className="tabular-nums font-medium">{booking.totalPrice.toFixed(0)} ج.م</span>
              </div>
              {invoiceSummary && (
                <>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">المدفوع</span>
                    <span className="tabular-nums text-status-success">{invoiceSummary.paid.toFixed(0)} ج.م</span>
                  </div>
                  {invoiceSummary.refunded > 0 && (
                    <div className="flex justify-between">
                      <span className="text-text-secondary">مسترد</span>
                      <span className="tabular-nums text-status-warning">{invoiceSummary.refunded.toFixed(0)} ج.م</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold">
                    <span>المتبقي</span>
                    <span className={outstanding > 0 ? 'text-status-danger tabular-nums' : 'tabular-nums'}>{outstanding.toFixed(0)} ج.م</span>
                  </div>
                  <div className="flex justify-between text-xs text-text-secondary">
                    <span>حالة الدفع</span>
                    <span>{PAYMENT_STATUS_LABELS[invoiceSummary.paymentStatus]}</span>
                  </div>
                </>
              )}
              {!booking.invoiceId && (
                <p className="text-xs text-text-secondary">لا توجد فاتورة مرتبطة بهذا الحجز.</p>
              )}
            </div>

            {booking.invoiceId && outstanding > 0.01 && (
              showCollectForm ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder={`المبلغ (المتبقي ${outstanding.toFixed(0)})`}
                      value={collectAmount}
                      onChange={(e) => setCollectAmount(e.target.value)}
                    />
                    <Select value={collectMethod} onValueChange={setCollectMethod}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>{label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={!collectAmount || collectPaymentMutation.isPending}
                      onClick={() => collectPaymentMutation.mutate()}
                    >
                      {collectPaymentMutation.isPending ? 'جارٍ التسجيل...' : 'تأكيد التحصيل'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setShowCollectForm(false); setCollectAmount('') }}>تراجع</Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  onClick={() => { setCollectAmount(outstanding.toFixed(2)); setShowCollectForm(true) }}
                >
                  تحصيل الدفعة
                </Button>
              )
            )}

            {booking.notes && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-text-secondary">ملاحظات</p>
                  <p>{booking.notes}</p>
                </div>
              </>
            )}

            {whatsappSummary && (whatsappSummary.sentCount > 0 || whatsappSummary.failedCount > 0 || whatsappSummary.pendingCount > 0) && (
              <>
                <Separator />
                <div className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 text-text-secondary">
                    <MessageCircle className="size-3.5" />
                    {whatsappSummary.failedCount > 0
                      ? `فشل إرسال ${whatsappSummary.failedCount} رسالة واتساب`
                      : whatsappSummary.pendingCount > 0
                        ? 'رسالة واتساب قيد الإرسال'
                        : `أُرسلت ${whatsappSummary.sentCount} رسالة واتساب ✓`}
                  </span>
                  <Link to="/app/whatsapp" className="font-medium text-accent-foreground hover:underline">
                    عرض النشاط
                  </Link>
                </div>
              </>
            )}

            {(booking.status === 'pending_payment' || booking.status === 'confirmed') && (
              <>
                <Separator />
                <div className="flex flex-col items-center gap-2">
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt="رمز QR للحجز" className="size-40 rounded-md border border-border" />
                  ) : (
                    <Button variant="outline" size="sm" className="w-full" disabled={qrMutation.isPending} onClick={() => qrMutation.mutate()}>
                      {qrMutation.isPending ? 'جارٍ الإنشاء...' : 'عرض رمز QR لتسجيل الحضور'}
                    </Button>
                  )}
                </div>
              </>
            )}

            {(booking.status === 'confirmed' || booking.status === 'checked_in') && (
              showNoShowConfirm ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-text-secondary">تأكيد تسجيل عدم حضور العميل لهذا الحجز؟</p>
                  <div className="flex gap-2">
                    <Button variant="destructive" size="sm" disabled={noShowMutation.isPending} onClick={() => noShowMutation.mutate()}>
                      {noShowMutation.isPending ? 'جارٍ التسجيل...' : 'تأكيد عدم الحضور'}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setShowNoShowConfirm(false)}>تراجع</Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setShowNoShowConfirm(true)}>
                  تسجيل عدم حضور
                </Button>
              )
            )}

            {booking.status !== 'cancelled' && booking.status !== 'no_show' && booking.status !== 'completed' && (
              <>
                <Separator />
                {showCancelForm ? (
                  <div className="flex flex-col gap-2">
                    <Input placeholder="سبب الإلغاء" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
                    <div className="flex gap-2">
                      <Button variant="destructive" size="sm" disabled={!cancelReason.trim() || cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>
                        تأكيد الإلغاء
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setShowCancelForm(false)}>تراجع</Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" className="text-status-danger hover:text-status-danger" onClick={() => setShowCancelForm(true)}>
                    إلغاء الحجز
                  </Button>
                )}
              </>
            )}

            {actionError && <p role="alert" className="text-sm text-status-danger">{actionError}</p>}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
