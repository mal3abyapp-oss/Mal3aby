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
import { formatInstant } from '@/lib/domain/time'
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

  // Government / Ministry Collection Compliance directive, section 25:
  // "بيانات إيصال التحصيل الرسمي" -- a prominent, dedicated section
  // shown only when this booking's field/branch/club actually requires
  // it. get_effective_government_policy() applies the same field ->
  // branch -> club inheritance the server-side hard block uses, so the
  // UI and the enforcement never disagree about whether a receipt is
  // needed.
  const { data: govPolicy } = useQuery({
    queryKey: ['government-policy', currentClubId, booking?.branchId, booking?.fieldId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_effective_government_policy', {
        p_club_id: currentClubId!,
        p_branch_id: booking?.branchId ?? undefined,
        p_field_id: booking?.fieldId ?? undefined,
      })
      if (error) throw error
      return data
    },
    enabled: !!currentClubId && !!booking,
  })
  const receiptRequiredForMethod = !!govPolicy?.enabled && !!govPolicy.official_receipt_required
    && (govPolicy.required_payment_methods ?? []).includes(collectMethod)
  const [receiptSerial, setReceiptSerial] = useState('')
  const [receiptDate, setReceiptDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [receiptBook, setReceiptBook] = useState('')
  const [receiptSeries, setReceiptSeries] = useState('')
  const [receiptNotes, setReceiptNotes] = useState('')

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

      // Government / Ministry Collection Compliance directive, section
      // 15/26: the button stays enabled here but the SERVER is what
      // actually enforces the block -- record_payment() itself raises
      // if a receipt is required and none is supplied, even if this
      // client-side branch were somehow bypassed.
      if (receiptRequiredForMethod) {
        if (!receiptSerial.trim()) throw new Error(t('governmentCompliance.receiptSerialRequired'))
        if (!receiptDate) throw new Error(t('governmentCompliance.receiptDateRequired'))
        const { error } = await supabase.rpc('record_payment_with_official_receipt', {
          p_invoice_id: booking.invoiceId,
          p_amount: amount,
          p_method: collectMethod,
          p_receipt_serial: receiptSerial.trim(),
          p_receipt_date: receiptDate,
          p_receipt_book: receiptBook.trim() || undefined,
          p_receipt_series: receiptSeries.trim() || undefined,
          p_notes: receiptNotes.trim() || undefined,
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
      setReceiptSerial('')
      setReceiptBook('')
      setReceiptSeries('')
      setReceiptNotes('')
      setActionError(null)
      void queryClient.invalidateQueries({ queryKey: ['booking-invoice-summary', booking?.invoiceId] })
      onChanged()
    },
    onError: (error) => {
      const message = error instanceof Error && !('code' in error) ? error.message : translateSupabaseError(error, t('bookings.detail.collectError'))
      // Directive section 14: a duplicate receipt must be rejected
      // clearly, not surfaced as a generic failure.
      setActionError(
        message.includes('unique constraint') || message.includes('duplicate key')
          ? t('governmentCompliance.duplicateReceiptError')
          : message,
      )
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
              <Link to={`/app/customers?q=${encodeURIComponent(booking.customerName)}`} className="font-semibold text-accent-foreground hover:underline">
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
                </>
              )}
              {!booking.invoiceId && (
                <p className="text-xs text-text-secondary">{t('bookings.detail.noInvoice')}</p>
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
                  {/* Government / Ministry Collection Compliance
                      directive, section 25: a prominent, dedicated
                      section -- only rendered when this booking's
                      field/branch/club policy actually requires an
                      official receipt for the currently-selected
                      payment method. */}
                  {receiptRequiredForMethod && (
                    <div className="flex flex-col gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3">
                      <p className="text-xs font-medium text-warning">{t('governmentCompliance.receiptSectionTitle')}</p>
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          required
                          placeholder={t('governmentCompliance.receiptSerialLabel')}
                          value={receiptSerial}
                          onChange={(e) => setReceiptSerial(e.target.value)}
                        />
                        <Input
                          required
                          type="date"
                          value={receiptDate}
                          onChange={(e) => setReceiptDate(e.target.value)}
                        />
                        {govPolicy?.receipt_book_enabled && (
                          <Input
                            placeholder={t('governmentCompliance.receiptBookLabel')}
                            value={receiptBook}
                            onChange={(e) => setReceiptBook(e.target.value)}
                          />
                        )}
                        {govPolicy?.receipt_series_enabled && (
                          <Input
                            placeholder={t('governmentCompliance.receiptSeriesLabel')}
                            value={receiptSeries}
                            onChange={(e) => setReceiptSeries(e.target.value)}
                          />
                        )}
                      </div>
                      <Input
                        placeholder={t('governmentCompliance.receiptNotesLabel')}
                        value={receiptNotes}
                        onChange={(e) => setReceiptNotes(e.target.value)}
                      />
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      disabled={
                        !collectAmount
                        || collectPaymentMutation.isPending
                        || (receiptRequiredForMethod && (!receiptSerial.trim() || !receiptDate))
                      }
                      onClick={() => collectPaymentMutation.mutate()}
                    >
                      {collectPaymentMutation.isPending ? t('bookings.detail.recording') : t('bookings.detail.confirmCollect')}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => { setShowCollectForm(false); setCollectAmount(''); setReceiptSerial(''); setReceiptBook(''); setReceiptSeries(''); setReceiptNotes(''); collectIdempotencyKeyRef.current = null }}>{t('bookings.detail.undo')}</Button>
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
