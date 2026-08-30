import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'
import { useTranslation } from 'react-i18next'
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
import { formatInstant, fromInstant } from '@/lib/domain/time'
import { fetchInvoicePaymentSummaries, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, type InvoicePaymentSummary } from '@/lib/domain/billing'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'
import { useAuth } from '@/app/providers/AuthProvider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { MessageCircle } from 'lucide-react'
import { useOfficialReceipt, OfficialCollectionReceiptFields, translateReceiptError } from '@/components/ui/official-collection-receipt-fields'

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

// Government / Ministry Collection Compliance -- Phase B: surfaces the
// official receipt reference right where staff are already looking at
// this booking's payment status, without requiring a trip to Billing.
async function fetchBookingOfficialReceipts(bookingId: string) {
  const { data, error } = await supabase
    .from('official_collection_receipts')
    .select('receipt_serial, status, receipt_date')
    .eq('booking_id', bookingId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

// Master IA/UX audit (Club Side Booking 360 phase): confirmed real gaps
// -- this sheet showed no invoice number and no link to it at all, and
// customer/field were static text with zero navigation, unlike every
// sibling screen (Reports, Alerts, Audit) which link club-keyed rows.
// get_invoice_payment_summary() (the RPC above) doesn't carry
// invoice_number, and per this codebase's own standing caution around
// RPC-body/signature edits (a prior parameter-order incident), a
// separate plain single-column read is the lower-risk fix here rather
// than widening that RPC's return shape.
async function fetchInvoiceNumber(invoiceId: string): Promise<string | null> {
  const { data, error } = await supabase.from('invoices').select('invoice_number').eq('id', invoiceId).single()
  if (error) return null
  return data?.invoice_number ?? null
}

// BOOKING ENGINE / AVAILABILITY / RESCHEDULING directive, sections
// 29-35: Reschedule and Change Field share one flow here (Change Field
// is just Reschedule with a different target field -- the server's
// reschedule_booking() RPC already treats them identically, taking
// p_new_field_id as an optional override of the booking's current
// field). Change Duration is folded in too (same RPC, new end_at) --
// three separate directive line items, one real underlying operation,
// matching how reschedule_booking itself was designed. This sheet
// self-fetches its own field list scoped to the booking's club, same
// self-contained pattern as fetchInvoiceSummary/fetchBookingWhatsAppSummary
// above, rather than threading BookingsPage's already-fetched list down
// as a new prop.
interface RescheduleFieldOption {
  id: string
  name: string
  branch_id: string
}

async function fetchClubFields(clubId: string): Promise<RescheduleFieldOption[]> {
  const { data, error } = await supabase.from('fields').select('id, name, branch_id').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

const RESCHEDULE_DURATION_VALUES = ['0.5', '1', '1.5', '2', '3'] as const

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
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { currentClubId } = useAuth()
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
  // Security P0 fix (MAL3ABY_PRODUCTION_READINESS.md C3): one key per
  // logical collection attempt, not per click -- generated lazily on
  // first submit and reused verbatim if record_payment() is retried
  // (network timeout, mutation retry), so the server-side idempotency
  // check can recognize "same attempt" vs "genuinely new payment".
  // Reset to null whenever the form is dismissed/reopened so the next
  // distinct attempt gets its own fresh key.
  const collectIdempotencyKeyRef = useRef<string | null>(null)
  const queryClient = useQueryClient()

  // Reschedule / Change Field / Change Duration -- one shared review-
  // before-confirm flow (directive section 31). showReschedule reveals
  // the picker; reschedulePreview holds the NEW side once a target
  // date/field/duration/start has been chosen, so the confirm step can
  // render "CURRENT vs NEW" from state already in hand rather than
  // re-deriving it at confirm time.
  const [showReschedule, setShowReschedule] = useState(false)
  const [rescheduleDate, setRescheduleDate] = useState('')
  const [rescheduleFieldId, setRescheduleFieldId] = useState('')
  const [rescheduleDuration, setRescheduleDuration] = useState('1')
  const [rescheduleStart, setRescheduleStart] = useState<string | null>(null)
  const [rescheduleReason, setRescheduleReason] = useState('')

  const { data: invoiceSummary } = useQuery({
    queryKey: ['booking-invoice-summary', booking?.invoiceId],
    queryFn: () => fetchInvoiceSummary(booking!.invoiceId!),
    enabled: !!booking?.invoiceId,
  })

  const { data: invoiceNumber } = useQuery({
    queryKey: ['booking-invoice-number', booking?.invoiceId],
    queryFn: () => fetchInvoiceNumber(booking!.invoiceId!),
    enabled: !!booking?.invoiceId,
  })

  const { data: whatsappSummary } = useQuery({
    queryKey: ['booking-whatsapp-summary', booking?.id],
    queryFn: () => fetchBookingWhatsAppSummary(booking!.id),
    enabled: !!booking?.id,
  })

  const { data: officialReceipts = [] } = useQuery({
    queryKey: ['booking-official-receipts', booking?.id],
    queryFn: () => fetchBookingOfficialReceipts(booking!.id),
    enabled: !!booking?.id,
  })

  const { data: rescheduleFields = [] } = useQuery({
    queryKey: ['booking-reschedule-fields', currentClubId],
    queryFn: () => fetchClubFields(currentClubId!),
    enabled: !!currentClubId && showReschedule,
  })

  // Server-authoritative candidate starts for the target date/field/
  // duration -- the exact same get_field_available_starts engine the
  // staff calendar and QuickBookingSheet now use (directive section 33:
  // reschedule's target interval goes through the same guarantee as
  // any new booking, no bypass). Excludes THIS booking's own current
  // slot from counting as "busy against itself" is not needed here --
  // the underlying query only looks at OTHER bookings' start_at/end_at,
  // this booking's own row is simply not double-counted since a row
  // can't overlap itself in a WHERE clause scan of other rows... but to
  // be precise: if reschedule keeps the same field, this booking's own
  // still-open row IS in that field's busy set until the UPDATE
  // actually runs, which would incorrectly shadow its own current slot
  // as "unavailable." Handled by filtering it out of the returned rows
  // client-side below (isRescheduleStartAvailable), not by trusting the
  // raw is_available flag blindly on the current slot.
  const effectiveRescheduleFieldId = rescheduleFieldId || booking?.fieldId || ''
  const { data: rescheduleStarts } = useQuery({
    queryKey: ['booking-reschedule-starts', effectiveRescheduleFieldId, rescheduleDate, rescheduleDuration],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_field_available_starts', {
        p_field_id: effectiveRescheduleFieldId,
        p_date: rescheduleDate,
        p_duration_minutes: Number(rescheduleDuration) * 60,
      })
      if (error) throw error
      return data ?? []
    },
    enabled: showReschedule && !!effectiveRescheduleFieldId && !!rescheduleDate,
  })

  const rescheduleSlots = (rescheduleStarts ?? []).map((row) => {
    const isCurrentSlot = booking != null && effectiveRescheduleFieldId === booking.fieldId && row.start_at === booking.startAt
    return {
      startAt: row.start_at,
      localTime: fromInstant(row.start_at, clubTimezone).time,
      // The booking's own current slot always renders available even
      // though the raw engine sees it as busy against itself -- picking
      // it back is a legitimate no-op reschedule (e.g. only the reason
      // changed) and must not be blocked by the booking's own existing row.
      isAvailable: row.is_available || isCurrentSlot,
    }
  })

  // Government / Ministry Collection Compliance -- Phase B: the shared
  // useOfficialReceipt() hook owns policy resolution (field -> branch ->
  // club, identical to the server-side guard) and all receipt field
  // state, so this surface can never drift from QuickBookingSheet's or
  // BillingPage's behavior. Recomputes `required` whenever collectMethod
  // changes -- requirement 9 ("تغيير طريقة الدفع بعد إدخال الإيصال").
  const receipt = useOfficialReceipt({
    clubId: currentClubId,
    branchId: booking?.branchId,
    fieldId: booking?.fieldId,
    method: collectMethod,
    enabled: !!booking,
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
    onError: () => setActionError(t('bookings.detail.qrError')),
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
    onError: () => setActionError(t('bookings.detail.cancelError')),
  })

  const rescheduleMutation = useMutation({
    mutationFn: async () => {
      if (!booking || !rescheduleStart) throw new Error('missing input')
      const newEndAt = new Date(new Date(rescheduleStart).getTime() + Number(rescheduleDuration) * 3600000).toISOString()
      const { data, error } = await supabase.rpc('reschedule_booking', {
        p_booking_id: booking.id,
        p_new_start_at: rescheduleStart,
        p_new_end_at: newEndAt,
        p_new_field_id: rescheduleFieldId && rescheduleFieldId !== booking.fieldId ? rescheduleFieldId : undefined,
        p_reason: rescheduleReason.trim() || undefined,
      })
      if (error) throw error
      return data?.[0]
    },
    onSuccess: () => {
      setShowReschedule(false)
      setRescheduleStart(null)
      setRescheduleReason('')
      setActionError(null)
      onOpenChange(false)
      onChanged()
    },
    onError: (error) => {
      setActionError(translateSupabaseError(error, t('bookings.detail.rescheduleError')))
    },
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
    onError: () => setActionError(t('bookings.detail.noShowError')),
  })

  const outstanding = invoiceSummary ? invoiceSummary.outstanding : booking?.totalPrice ?? 0

  const collectPaymentMutation = useMutation({
    mutationFn: async () => {
      if (!booking?.invoiceId) throw new Error('no invoice to collect against')
      const amount = Number(collectAmount)
      if (!amount || amount <= 0) throw new Error(t('bookings.detail.invalidAmountError'))
      if (amount - outstanding > 0.01) {
        throw new Error(t('bookings.detail.amountExceedsOutstanding', { amount: amount.toFixed(2), outstanding: outstanding.toFixed(2) }))
      }
      if (!collectIdempotencyKeyRef.current) {
        collectIdempotencyKeyRef.current = crypto.randomUUID()
      }

      // Government / Ministry Collection Compliance -- Phase B: the
      // button stays enabled here but the SERVER is what actually
      // enforces the block -- record_payment() itself raises if a
      // receipt is required and none is supplied, even if this
      // client-side check were somehow bypassed.
      const receiptPayload = receipt.getPayload()
      if (receiptPayload) {
        // record_payment_with_official_receipt() names this parameter
        // p_notes (its p_receipt_serial/p_receipt_date/etc. siblings
        // match the shared hook's field names exactly, but there is no
        // separate "booking notes" concept on this RPC to disambiguate
        // from, unlike create_booking()'s p_receipt_notes).
        const { p_receipt_notes, ...rest } = receiptPayload
        const { error } = await supabase.rpc('record_payment_with_official_receipt', {
          p_invoice_id: booking.invoiceId,
          p_amount: amount,
          p_method: collectMethod,
          ...rest,
          p_notes: p_receipt_notes,
          p_idempotency_key: collectIdempotencyKeyRef.current,
        })
        if (error) throw error
        return
      }

      const { error } = await supabase.rpc('record_payment', {
        p_invoice_id: booking.invoiceId,
        p_amount: amount,
        p_method: collectMethod,
        p_idempotency_key: collectIdempotencyKeyRef.current,
      })
      if (error) throw error
    },
    onSuccess: () => {
      collectIdempotencyKeyRef.current = null
      setShowCollectForm(false)
      setCollectAmount('')
      receipt.reset()
      setActionError(null)
      void queryClient.invalidateQueries({ queryKey: ['booking-invoice-summary', booking?.invoiceId] })
      void queryClient.invalidateQueries({ queryKey: ['booking-official-receipts', booking?.id] })
      onChanged()
    },
    onError: (error) => {
      const message = error instanceof Error && !('code' in error) ? error.message : translateSupabaseError(error, t('bookings.detail.collectError'))
      setActionError(translateReceiptError(message, t, message))
    },
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
          receipt.reset()
          setShowReschedule(false)
          setRescheduleDate('')
          setRescheduleFieldId('')
          setRescheduleDuration('1')
          setRescheduleStart(null)
          setRescheduleReason('')
        }
        onOpenChange(open)
      }}
    >
      <SheetContent className="flex w-full flex-col overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('bookings.detail.title')}</SheetTitle>
        </SheetHeader>

        {booking && (
          <div className="flex flex-1 flex-col gap-4 py-4 text-sm">
            <div className="flex items-center justify-between">
              <StatusBadge tone={BOOKING_STATUS_TONE[booking.status] ?? 'neutral'} label={t(`bookings.statusLabels.${booking.status}`, { defaultValue: BOOKING_STATUS_LABELS[booking.status] ?? booking.status })} />
              <span className="text-xs text-text-secondary tabular-nums">
                {formatInstant(booking.startAt, clubTimezone, { day: 'numeric', month: 'long' }, locale)}
              </span>
            </div>

            <div className="rounded-lg border border-border p-3">
              <p className="text-xs text-text-secondary">{t('bookings.detail.customer')}</p>
              <Link to={`/app/customers/${booking.customerId}`} className="font-semibold text-accent-foreground hover:underline">
                {booking.customerName}
              </Link>
              {booking.customerMobile && <p className="text-text-secondary tabular-nums"><bdi>{booking.customerMobile}</bdi></p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-text-secondary">{t('bookings.detail.field')}</p>
                <Link to="/app/fields" className="font-medium text-accent-foreground hover:underline">
                  {fieldName}
                </Link>
              </div>
              <div>
                <p className="text-xs text-text-secondary">{t('bookings.detail.time')}</p>
                {/* Same RTL bidi-swap risk as StatCard's composite values
                    (owner-level review finding) -- isolates the time
                    range's direction from the surrounding Arabic context. */}
                <p className="font-medium tabular-nums">
                  <bdi>
                    {formatInstant(booking.startAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)}
                    {' — '}
                    {formatInstant(booking.endAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)}
                  </bdi>
                </p>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-1.5">
              {booking.invoiceId && (
                <div className="flex justify-between">
                  <span className="text-text-secondary">{t('bookings.detail.invoiceNumber')}</span>
                  <Link
                    to={`/app/billing?invoice=${booking.invoiceId}`}
                    className="font-medium text-accent-foreground hover:underline"
                  >
                    <bdi>{invoiceNumber ?? '...'}</bdi>
                  </Link>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-text-secondary">{t('bookings.detail.total')}</span>
                <span className="tabular-nums font-medium">{booking.totalPrice.toFixed(0)} {t('common.currency')}</span>
              </div>
              {invoiceSummary && (
                <>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">{t('bookings.detail.paid')}</span>
                    <span className="tabular-nums text-status-success">{invoiceSummary.paid.toFixed(0)} {t('common.currency')}</span>
                  </div>
                  {invoiceSummary.refunded > 0 && (
                    <div className="flex justify-between">
                      <span className="text-text-secondary">{t('bookings.detail.refunded')}</span>
                      <span className="tabular-nums text-status-warning">{invoiceSummary.refunded.toFixed(0)} {t('common.currency')}</span>
                    </div>
                  )}
                  <div className="flex justify-between font-semibold">
                    <span>{t('bookings.detail.outstanding')}</span>
                    {outstanding > 0 ? (
                      <Link to={`/app/billing?invoice=${booking.invoiceId}`} className="tabular-nums text-status-danger hover:underline">
                        {outstanding.toFixed(0)} {t('common.currency')}
                      </Link>
                    ) : (
                      <span className="tabular-nums">{outstanding.toFixed(0)} {t('common.currency')}</span>
                    )}
                  </div>
                  <div className="flex justify-between text-xs text-text-secondary">
                    <span>{t('bookings.detail.paymentStatus')}</span>
                    <span>{t(`secureBooking.paymentStatusLabels.${invoiceSummary.paymentStatus}`, { defaultValue: PAYMENT_STATUS_LABELS[invoiceSummary.paymentStatus] })}</span>
                  </div>
                  {/* Government / Ministry Collection Compliance --
                      Phase B: shown only when this booking's payment
                      actually has a linked official receipt -- no
                      placeholder clutter otherwise. */}
                  {officialReceipts.length > 0 && (
                    <div className="flex justify-between text-xs text-text-secondary">
                      <span>{t('governmentCompliance.title')}</span>
                      <span className="text-end">
                        {officialReceipts.map((r, i) => (
                          <span key={i} className="block tabular-nums">
                            <bdi>{r.receipt_serial}</bdi>
                            {r.status === 'reversed' && <span className="text-status-danger"> ({t('billing.detail.refund')})</span>}
                          </span>
                        ))}
                      </span>
                    </div>
                  )}
                </>
              )}
              {!booking.invoiceId && (
                <p className="text-xs text-text-secondary">{t('bookings.detail.noInvoice')}</p>
              )}
            </div>

            {/* Phase H (H2): a cancelled/no-show booking's outstanding
                balance is real accounting information (still shown
                above), but staff should never be invited to collect
                MORE money for a booking that isn't happening. */}
            {booking.invoiceId && outstanding > 0.01 && booking.status !== 'cancelled' && booking.status !== 'no_show' && (
              showCollectForm ? (
                <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      type="number"
                      min={0}
                      step="0.01"
                      placeholder={t('bookings.detail.amountPlaceholder', { amount: outstanding.toFixed(0) })}
                      value={collectAmount}
                      onChange={(e) => setCollectAmount(e.target.value)}
                    />
                    <Select value={collectMethod} onValueChange={setCollectMethod}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>{t(`common.paymentMethodLabels.${value}`, { defaultValue: label })}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* Government / Ministry Collection Compliance --
                      Phase B: the shared component renders nothing at
                      all unless this booking's field/branch/club policy
                      actually requires an official receipt for the
                      currently-selected payment method. */}
                  <OfficialCollectionReceiptFields state={receipt} />

                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={!collectAmount || collectPaymentMutation.isPending || !receipt.isValid}
                      onClick={() => collectPaymentMutation.mutate()}
                    >
                      {collectPaymentMutation.isPending ? t('bookings.detail.recording') : t('bookings.detail.confirmCollect')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setShowCollectForm(false); setCollectAmount(''); receipt.reset(); collectIdempotencyKeyRef.current = null }}>{t('bookings.detail.undo')}</Button>
                  </div>
                </div>
              ) : (
                <Button
                  size="sm"
                  onClick={() => { setCollectAmount(outstanding.toFixed(2)); setShowCollectForm(true) }}
                >
                  {t('bookings.detail.collectPayment')}
                </Button>
              )
            )}

            {booking.notes && (
              <>
                <Separator />
                <div>
                  <p className="text-xs text-text-secondary">{t('bookings.detail.notes')}</p>
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
                      ? t('bookings.detail.whatsappFailed', { count: whatsappSummary.failedCount })
                      : whatsappSummary.pendingCount > 0
                        ? t('bookings.detail.whatsappPending')
                        : t('bookings.detail.whatsappSent', { count: whatsappSummary.sentCount })}
                  </span>
                  <Link to="/app/whatsapp" className="font-medium text-accent-foreground hover:underline">
                    {t('bookings.detail.viewActivity')}
                  </Link>
                </div>
              </>
            )}

            {(booking.status === 'pending_payment' || booking.status === 'confirmed') && (
              <>
                <Separator />
                <div className="flex flex-col items-center gap-2">
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt={t('bookings.detail.qrAlt')} className="size-40 rounded-md border border-border" />
                  ) : (
                    <Button variant="outline" size="sm" className="w-full" disabled={qrMutation.isPending} onClick={() => qrMutation.mutate()}>
                      {qrMutation.isPending ? t('bookings.detail.generatingQr') : t('bookings.detail.viewQr')}
                    </Button>
                  )}
                </div>
              </>
            )}

            {/* Reschedule / Change Field / Change Duration -- directive
                sections 29-35. Gated exactly like reschedule_booking's
                own server-side guard: only pending_payment/confirmed,
                only a booking that hasn't started yet -- an unauthorized
                direct RPC call would hard-fail regardless (section 49),
                this just avoids offering an action the server would
                reject outright. */}
            {(booking.status === 'pending_payment' || booking.status === 'confirmed') && new Date(booking.startAt) > new Date() && (
              <>
                <Separator />
                {showReschedule ? (
                  <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                    <p className="text-sm font-medium">{t('bookings.detail.rescheduleTitle')}</p>

                    <div className="rounded-lg border border-border bg-muted/30 p-2 text-xs">
                      <p className="font-medium text-text-secondary">{t('bookings.detail.rescheduleCurrent')}</p>
                      <p className="tabular-nums">
                        <bdi>
                          {fieldName} — {formatInstant(booking.startAt, clubTimezone, { day: 'numeric', month: 'short' }, locale)}
                          {' · '}
                          {formatInstant(booking.startAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)}
                          {' — '}
                          {formatInstant(booking.endAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)}
                        </bdi>
                      </p>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-text-secondary">{t('bookings.detail.rescheduleDate')}</label>
                        <Input
                          type="date"
                          value={rescheduleDate}
                          min={fromInstant(new Date(), clubTimezone).date}
                          onChange={(e) => { setRescheduleDate(e.target.value); setRescheduleStart(null); setActionError(null) }}
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-text-secondary">{t('bookings.detail.rescheduleField')}</label>
                        <Select
                          value={rescheduleFieldId || booking.fieldId}
                          onValueChange={(v) => { setRescheduleFieldId(v); setRescheduleStart(null); setActionError(null) }}
                        >
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {(rescheduleFields.length > 0 ? rescheduleFields : [{ id: booking.fieldId, name: fieldName, branch_id: booking.branchId }]).map((f) => (
                              <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-xs text-text-secondary">{t('bookings.detail.rescheduleDuration')}</label>
                      <Select value={rescheduleDuration} onValueChange={(v) => { setRescheduleDuration(v); setRescheduleStart(null); setActionError(null) }}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {RESCHEDULE_DURATION_VALUES.map((v) => (
                            <SelectItem key={v} value={v}>{t(`bookings.quick.durations.${v}`)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {rescheduleDate && (
                      <div className="flex flex-col gap-1">
                        <label className="text-xs text-text-secondary">{t('bookings.detail.rescheduleNewStart')}</label>
                        {rescheduleSlots.length === 0 ? (
                          <p className="text-xs text-text-secondary">{t('bookings.detail.rescheduleNoSlots')}</p>
                        ) : (
                          <div className="grid grid-cols-4 gap-1.5">
                            {rescheduleSlots.map((s) => (
                              <button
                                key={s.startAt}
                                type="button"
                                disabled={!s.isAvailable}
                                onClick={() => setRescheduleStart(s.startAt)}
                                className={`rounded-md border px-2 py-1.5 text-xs font-medium tabular-nums transition disabled:cursor-not-allowed disabled:opacity-40 ${
                                  rescheduleStart === s.startAt ? 'border-accent bg-accent/10' : 'border-border bg-surface hover:border-accent'
                                }`}
                              >
                                <bdi>{s.localTime}</bdi>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {rescheduleStart && (
                      <div className="rounded-lg border border-accent/30 bg-accent/5 p-2 text-xs">
                        <p className="font-medium text-accent-foreground">{t('bookings.detail.rescheduleNew')}</p>
                        <p className="tabular-nums">
                          <bdi>
                            {(rescheduleFields.find((f) => f.id === (rescheduleFieldId || booking.fieldId))?.name) ?? fieldName}
                            {' — '}
                            {formatInstant(rescheduleStart, clubTimezone, { day: 'numeric', month: 'short' }, locale)}
                            {' · '}
                            {fromInstant(rescheduleStart, clubTimezone).time}
                            {' — '}
                            {fromInstant(new Date(new Date(rescheduleStart).getTime() + Number(rescheduleDuration) * 3600000).toISOString(), clubTimezone).time}
                          </bdi>
                        </p>
                      </div>
                    )}

                    <Input
                      placeholder={t('bookings.detail.rescheduleReasonPlaceholder')}
                      value={rescheduleReason}
                      onChange={(e) => setRescheduleReason(e.target.value)}
                    />

                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        disabled={!rescheduleStart || rescheduleMutation.isPending}
                        onClick={() => rescheduleMutation.mutate()}
                      >
                        {rescheduleMutation.isPending ? t('bookings.detail.rescheduling') : t('bookings.detail.confirmReschedule')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setShowReschedule(false)}>{t('bookings.detail.undo')}</Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setShowReschedule(true)
                      setRescheduleDate(fromInstant(booking.startAt, clubTimezone).date)
                      setRescheduleFieldId(booking.fieldId)
                      const durationHours = (new Date(booking.endAt).getTime() - new Date(booking.startAt).getTime()) / 3600000
                      const closestOption = RESCHEDULE_DURATION_VALUES.reduce((best, v) =>
                        Math.abs(Number(v) - durationHours) < Math.abs(Number(best) - durationHours) ? v : best,
                      )
                      setRescheduleDuration(closestOption)
                    }}
                  >
                    {t('bookings.detail.rescheduleBooking')}
                  </Button>
                )}
              </>
            )}

            {(booking.status === 'confirmed' || booking.status === 'checked_in') && (
              showNoShowConfirm ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm text-text-secondary">{t('bookings.detail.confirmNoShowMessage')}</p>
                  <div className="flex gap-2">
                    <Button variant="destructive" size="sm" disabled={noShowMutation.isPending} onClick={() => noShowMutation.mutate()}>
                      {noShowMutation.isPending ? t('bookings.detail.recordingNoShow') : t('bookings.detail.confirmNoShow')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setShowNoShowConfirm(false)}>{t('bookings.detail.undo')}</Button>
                  </div>
                </div>
              ) : (
                <Button variant="outline" size="sm" onClick={() => setShowNoShowConfirm(true)}>
                  {t('bookings.detail.markNoShow')}
                </Button>
              )
            )}

            {booking.status !== 'cancelled' && booking.status !== 'no_show' && booking.status !== 'completed' && (
              <>
                <Separator />
                {showCancelForm ? (
                  <div className="flex flex-col gap-2">
                    <Input placeholder={t('bookings.detail.cancelReasonPlaceholder')} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
                    <div className="flex gap-2">
                      <Button variant="destructive" size="sm" disabled={!cancelReason.trim() || cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>
                        {t('bookings.detail.confirmCancel')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setShowCancelForm(false)}>{t('bookings.detail.undo')}</Button>
                    </div>
                  </div>
                ) : (
                  <Button variant="ghost" size="sm" className="text-status-danger hover:text-status-danger" onClick={() => setShowCancelForm(true)}>
                    {t('bookings.detail.cancelBooking')}
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
