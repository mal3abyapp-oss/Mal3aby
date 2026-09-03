import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { StatusBadge } from '@/components/ui/status-badge'
import { QrCodeViewer } from '@/components/ui/qr-code-viewer'
import { PAYMENT_STATUS_TONE, type PaymentStatus } from '@/lib/domain/billing'
import { useDirection } from '@/app/providers/DirectionProvider'
import { FormattedDate } from '@/components/ui/formatted-date'
import { FormattedCurrency } from '@/components/ui/formatted-currency'
import { CheckCircle2, XCircle, Ticket, Ban } from 'lucide-react'

// Task #86: public invoice verification page. Reachable with NO login
// (verify_invoice_public() is granted to anon), matching the documented
// design intent (docs/ARCHITECTURE.md "QR Strategy"): the customer
// holding a printed invoice/receipt -- or any third party checking it,
// e.g. an auditor -- can scan the QR and confirm it's genuine without a
// staff account. Standalone route (no PublicLayout marketing chrome,
// no app shell) -- someone landing here scanned a QR, they didn't come
// from the marketing site or log in.
//
// Deliberately shows ONLY what verify_invoice_public() returns:
// invoice number, issue date, total, payment status, and (WhatsApp
// secure links directive) paid/outstanding/customer_name/booking_ref/
// field_name -- never phone/email/internal IDs/line items. This link
// is only ever reached by the customer themselves via their own
// WhatsApp message (not a random QR-scanner-in-the-wild scenario the
// way the printed-receipt case is), so showing their own name back to
// them is correct, not an over-exposure.
//
// WHATSAPP BUSINESS MESSAGING FINAL HARDENING (2026-08-22), Sections
// 40/42/45: official_receipts now renders here too, matching the
// WhatsApp message templates and the PDF invoice -- previously this
// was the one surface missing government receipt data. Every active
// receipt against the invoice is shown (Section 43 -- multiple cash
// payments can each carry their own receipt; none are dropped).
//
// INVOICE QR BUTTON (2026-08-23): "عرض رمز QR" / "View QR Code",
// Field Booking invoices only. Reuses the SAME canonical QR
// architecture as Booking Details "Show QR" (ensure_booking_qr) and
// Secure Booking Page "Show QR" -- via get_booking_qr_for_invoice_token
// (migration 20260823020000), which mints through the shared
// _mint_booking_qr_token_internal() primitive, and renders through the
// shared <QrCodeViewer> component (no separate InvoiceQr
// implementation). The button is lazy -- nothing is minted just from
// this invoice page loading, only on click -- and never shown for
// Academy/subscription invoices (no linked booking -- see
// data.bookingRef gate below), never affects official-receipt data,
// and the RPC re-validates the booking's own status server-side on
// every click (cancelled/checked-in/not-eligible), so a stale or
// tampered client can't force a QR for an invalid booking.
//
// Production audit finding H-1 (RTL-bidi gap): date/currency values
// used to call formatDate()/formatCurrency() directly, returning plain
// strings with no bidi isolation (unlike MoneyDisplay, which has always
// wrapped its own output in <bdi>). Migrated to <FormattedDate>/
// <FormattedCurrency> (src/components/ui/formatted-date.tsx,
// formatted-currency.tsx) so every rendered date/amount on this public,
// unauthenticated page is bidi-isolated the same way.

interface OfficialReceipt {
  receiptSerial: string | null
  receiptBook: string | null
  receiptSeries: string | null
  receiptDate: string | null
  receiptAmount: number | null
}

interface VerificationResult {
  result: 'success' | 'invalid'
  invoiceNumber: string | null
  issuedAt: string | null
  total: number | null
  paid: number | null
  outstanding: number | null
  paymentStatus: PaymentStatus | null
  customerName: string | null
  bookingRef: string | null
  fieldName: string | null
  officialReceipts: OfficialReceipt[]
}

async function verifyInvoice(token: string): Promise<VerificationResult> {
  const { data, error } = await supabase.rpc('verify_invoice_public', { p_token: token })
  if (error) throw error
  const row = data?.[0]
  const rawReceipts = Array.isArray(row?.official_receipts) ? row.official_receipts : []
  return {
    result: (row?.result as 'success' | 'invalid') ?? 'invalid',
    invoiceNumber: row?.invoice_number ?? null,
    issuedAt: row?.issued_at ?? null,
    total: row?.total !== null && row?.total !== undefined ? Number(row.total) : null,
    paid: row?.paid !== null && row?.paid !== undefined ? Number(row.paid) : null,
    outstanding: row?.outstanding !== null && row?.outstanding !== undefined ? Number(row.outstanding) : null,
    paymentStatus: (row?.payment_status as PaymentStatus) ?? null,
    customerName: row?.customer_name ?? null,
    bookingRef: row?.booking_ref ?? null,
    fieldName: row?.field_name ?? null,
    officialReceipts: rawReceipts.map((raw) => {
      const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
      return {
        receiptSerial: (r.receipt_serial as string) ?? null,
        receiptBook: (r.receipt_book as string) ?? null,
        receiptSeries: (r.receipt_series as string) ?? null,
        receiptDate: (r.receipt_date as string) ?? null,
        receiptAmount: r.receipt_amount !== null && r.receipt_amount !== undefined ? Number(r.receipt_amount) : null,
      }
    }),
  }
}

type BookingQrStatus =
  | 'active'
  | 'invalid_invoice_token'
  | 'not_a_booking_invoice'
  | 'booking_cancelled'
  | 'already_checked_in'
  | 'booking_not_eligible'

interface BookingQrResult {
  status: BookingQrStatus
  rawToken: string | null
  bookingRef: string | null
  fieldName: string | null
  startAt: string | null
}

async function fetchBookingQr(invoiceToken: string): Promise<BookingQrResult> {
  const { data, error } = await supabase.rpc('get_booking_qr_for_invoice_token', { p_invoice_token: invoiceToken })
  if (error) throw error
  const row = data?.[0]
  return {
    status: (row?.status as BookingQrStatus) ?? 'invalid_invoice_token',
    rawToken: row?.raw_token ?? null,
    bookingRef: row?.booking_ref ?? null,
    fieldName: row?.field_name ?? null,
    startAt: row?.start_at ?? null,
  }
}

export function VerifyInvoicePage() {
  const { token } = useParams<{ token: string }>()
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const { direction, locale, setLocale } = useDirection()
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrOpen, setQrOpen] = useState(false)

  // Secure Booking Page language hand-off (directive Sections 28-32/40):
  // invoiceUrl() now appends ?lang=ar|en matching the WhatsApp message's
  // own language -- honored here the same way SecureBookingPage does,
  // one-time on mount, so an English customer's "View invoice" link
  // opens with the correct direction set immediately. Copy is now fully
  // translated via useTranslation()/t() (verifyInvoice.* resource keys),
  // matching SecureBookingPage's pattern.
  useEffect(() => {
    const langParam = searchParams.get('lang')
    if ((langParam === 'ar' || langParam === 'en') && langParam !== locale) {
      setLocale(langParam)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['verify-invoice', token],
    queryFn: () => verifyInvoice(token!),
    enabled: !!token,
    retry: false,
  })

  // "عرض رمز QR" / "View QR Code" -- lazy, click-triggered only. Calls
  // get_booking_qr_for_invoice_token (the same server-side chain that
  // re-validates invoice -> booking -> QR eligibility on every call --
  // see the doc comment above), then encodes the returned bare token
  // (never a URL -- matching the fix applied to SecureBookingPage.tsx
  // this session; qr_validate/qr_confirm_checkin hash the token exactly
  // as given, with zero URL parsing).
  const bookingQrMutation = useMutation({
    mutationFn: () => fetchBookingQr(token!),
    onSuccess: async (result) => {
      if (result.status === 'active' && result.rawToken) {
        const url = await QRCode.toDataURL(result.rawToken, { width: 480, margin: 1 })
        setQrDataUrl(url)
      }
      setQrOpen(true)
    },
  })

  const bookingQr = bookingQrMutation.data

  return (
    <div dir={direction} className="flex min-h-screen items-center justify-center bg-page-bg p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 text-center shadow">
        <p className="mb-4 text-sm font-medium text-text-secondary">{t('verifyInvoice.title')}</p>

        {isLoading && <p className="text-sm text-text-secondary">{t('verifyInvoice.loading')}</p>}

        {!isLoading && (isError || !data || data.result === 'invalid') && (
          <div className="flex flex-col items-center gap-3">
            <XCircle className="size-12 text-status-danger" />
            <p className="font-medium text-status-danger">{t('verifyInvoice.states.invalidTitle')}</p>
            <p className="text-sm text-text-secondary">{t('verifyInvoice.states.invalidMessage')}</p>
          </div>
        )}

        {!isLoading && data && data.result === 'success' && (
          <div className="flex flex-col items-center gap-3">
            <CheckCircle2 className="size-12 text-status-success" />
            <p className="font-medium text-status-success">{t('verifyInvoice.states.successTitle')}</p>
            <div className="w-full rounded-md border border-border p-4 text-start text-sm">
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">{t('verifyInvoice.invoiceNumber')}</span>
                <span className="font-medium"><bdi>{data.invoiceNumber}</bdi></span>
              </div>
              {data.customerName && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">{t('verifyInvoice.customer')}</span>
                  <span className="font-medium">{data.customerName}</span>
                </div>
              )}
              {data.bookingRef && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">{t('verifyInvoice.bookingRef')}</span>
                  <span className="font-medium"><bdi>{data.bookingRef}</bdi></span>
                </div>
              )}
              {data.fieldName && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">{t('verifyInvoice.field')}</span>
                  <span className="font-medium">{data.fieldName}</span>
                </div>
              )}
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">{t('verifyInvoice.issuedAt')}</span>
                <span className="font-medium">
                  <FormattedDate value={data.issuedAt} timeZone="Africa/Cairo" options={{ day: 'numeric', month: 'long', year: 'numeric' }} />
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">{t('verifyInvoice.total')}</span>
                <span className="font-medium"><FormattedCurrency value={data.total} /></span>
              </div>
              {data.paid !== null && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">{t('verifyInvoice.paid')}</span>
                  <span className="font-medium text-status-success"><FormattedCurrency value={data.paid} /></span>
                </div>
              )}
              {data.outstanding !== null && data.outstanding > 0 && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">{t('verifyInvoice.outstanding')}</span>
                  <span className="font-medium text-status-danger"><FormattedCurrency value={data.outstanding} /></span>
                </div>
              )}
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">{t('verifyInvoice.paymentStatus')}</span>
                {data.paymentStatus && (
                  <StatusBadge
                    tone={PAYMENT_STATUS_TONE[data.paymentStatus]}
                    label={t(`verifyInvoice.paymentStatusLabels.${data.paymentStatus}`, { defaultValue: data.paymentStatus })}
                  />
                )}
              </div>
            </div>

            {data.officialReceipts.length > 0 && (
              <div className="w-full rounded-md border border-border bg-page-bg p-4 text-start text-sm">
                <p className="mb-2 font-medium">
                  {t(data.officialReceipts.length > 1 ? 'verifyInvoice.officialReceipts.titlePlural' : 'verifyInvoice.officialReceipts.title')}
                </p>
                <div className="flex flex-col gap-2">
                  {data.officialReceipts.map((receipt, index) => (
                    <div key={`${receipt.receiptSerial ?? 'receipt'}-${index}`} className="rounded border border-border/60 p-2">
                      <div className="flex justify-between py-0.5">
                        <span className="text-text-secondary">{t('verifyInvoice.officialReceipts.number')}</span>
                        <span className="font-medium"><bdi>{receipt.receiptSerial ?? '—'}</bdi></span>
                      </div>
                      <div className="flex justify-between py-0.5">
                        <span className="text-text-secondary">{t('verifyInvoice.officialReceipts.date')}</span>
                        <span className="font-medium">
                          <FormattedDate value={receipt.receiptDate} timeZone="Africa/Cairo" options={{ day: 'numeric', month: 'long', year: 'numeric' }} />
                        </span>
                      </div>
                      <div className="flex justify-between py-0.5">
                        <span className="text-text-secondary">{t('verifyInvoice.officialReceipts.amount')}</span>
                        <span className="font-medium">
                          <FormattedCurrency value={receipt.receiptAmount} />
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Directive item 5/F: only Field Booking invoices get the QR
                button -- data.bookingRef is only populated by
                verify_invoice_public() when this invoice has a linked
                booking, so an Academy/subscription invoice never shows
                this section at all. */}
            {data.bookingRef && (
              <div className="w-full rounded-md border border-border p-4 text-start text-sm">
                {!qrOpen && (
                  <button
                    type="button"
                    onClick={() => bookingQrMutation.mutate()}
                    disabled={bookingQrMutation.isPending}
                    className="flex w-full items-center justify-center gap-2 rounded-md bg-brand-primary px-4 py-2 font-medium text-white transition hover:opacity-90 disabled:opacity-60"
                  >
                    <Ticket className="size-4" />
                    {bookingQrMutation.isPending ? t('verifyInvoice.qrAction.loading') : t('verifyInvoice.qrAction.viewQr')}
                  </button>
                )}

                {bookingQrMutation.isError && (
                  <p className="mt-2 text-sm text-status-danger">{t('verifyInvoice.qrAction.loadError')}</p>
                )}

                {qrOpen && bookingQr && (
                  <div className="flex flex-col items-center gap-3">
                    <p className="font-medium">{t('verifyInvoice.qrAction.sectionTitle')}</p>
                    <div className="w-full text-sm">
                      {bookingQr.bookingRef && (
                        <div className="flex justify-between py-1">
                          <span className="text-text-secondary">{t('verifyInvoice.bookingRef')}</span>
                          <span className="font-medium"><bdi>{bookingQr.bookingRef}</bdi></span>
                        </div>
                      )}
                      {bookingQr.fieldName && (
                        <div className="flex justify-between py-1">
                          <span className="text-text-secondary">{t('verifyInvoice.qrAction.field')}</span>
                          <span className="font-medium">{bookingQr.fieldName}</span>
                        </div>
                      )}
                      {bookingQr.startAt && (
                        <>
                          <div className="flex justify-between py-1">
                            <span className="text-text-secondary">{t('verifyInvoice.qrAction.date')}</span>
                            <span className="font-medium">
                              <FormattedDate value={bookingQr.startAt} timeZone="Africa/Cairo" options={{ day: 'numeric', month: 'long', year: 'numeric' }} />
                            </span>
                          </div>
                          <div className="flex justify-between py-1">
                            <span className="text-text-secondary">{t('verifyInvoice.qrAction.time')}</span>
                            <span className="font-medium">
                              <FormattedDate value={bookingQr.startAt} timeZone="Africa/Cairo" options={{ hour: 'numeric', minute: '2-digit' }} />
                            </span>
                          </div>
                        </>
                      )}
                    </div>

                    {bookingQr.status === 'booking_cancelled' && (
                      <div className="flex flex-col items-center gap-2 text-status-danger">
                        <Ban className="size-8" />
                        <p className="font-medium">{t('verifyInvoice.qrAction.bookingCancelled')}</p>
                      </div>
                    )}

                    {bookingQr.status === 'already_checked_in' && (
                      <div className="flex flex-col items-center gap-2 text-status-success">
                        <CheckCircle2 className="size-8" />
                        <p className="font-medium">{t('verifyInvoice.qrAction.alreadyCheckedIn')}</p>
                      </div>
                    )}

                    {bookingQr.status === 'booking_not_eligible' && (
                      <p className="text-sm text-text-secondary">{t('verifyInvoice.qrAction.notEligible')}</p>
                    )}

                    {bookingQr.status === 'active' && qrDataUrl && (
                      <QrCodeViewer
                        qrDataUrl={qrDataUrl}
                        label={t('verifyInvoice.qrAction.attendanceQr')}
                        hint={t('verifyInvoice.qrAction.attendanceQrHint')}
                      />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
