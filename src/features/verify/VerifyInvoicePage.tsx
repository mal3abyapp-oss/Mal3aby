import { useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { StatusBadge } from '@/components/ui/status-badge'
import { PAYMENT_STATUS_TONE, type PaymentStatus } from '@/lib/domain/billing'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatCurrency, formatDate, type SupportedLocale } from '@/lib/i18n/config'
import { CheckCircle2, XCircle } from 'lucide-react'

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
    officialReceipts: rawReceipts.map((r: Record<string, unknown>) => ({
      receiptSerial: (r.receipt_serial as string) ?? null,
      receiptBook: (r.receipt_book as string) ?? null,
      receiptSeries: (r.receipt_series as string) ?? null,
      receiptDate: (r.receipt_date as string) ?? null,
      receiptAmount: r.receipt_amount !== null && r.receipt_amount !== undefined ? Number(r.receipt_amount) : null,
    })),
  }
}

export function VerifyInvoicePage() {
  const { token } = useParams<{ token: string }>()
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const { direction, locale, setLocale } = useDirection()

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
                  {data.issuedAt
                    ? formatDate(data.issuedAt, locale as SupportedLocale, 'Africa/Cairo', { day: 'numeric', month: 'long', year: 'numeric' })
                    : '—'}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">{t('verifyInvoice.total')}</span>
                <span className="font-medium">{data.total !== null ? formatCurrency(data.total, locale as SupportedLocale) : '—'}</span>
              </div>
              {data.paid !== null && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">{t('verifyInvoice.paid')}</span>
                  <span className="font-medium text-status-success">{formatCurrency(data.paid, locale as SupportedLocale)}</span>
                </div>
              )}
              {data.outstanding !== null && data.outstanding > 0 && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">{t('verifyInvoice.outstanding')}</span>
                  <span className="font-medium text-status-danger">{formatCurrency(data.outstanding, locale as SupportedLocale)}</span>
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
                          {receipt.receiptDate
                            ? formatDate(receipt.receiptDate, locale as SupportedLocale, 'Africa/Cairo', { day: 'numeric', month: 'long', year: 'numeric' })
                            : '—'}
                        </span>
                      </div>
                      <div className="flex justify-between py-0.5">
                        <span className="text-text-secondary">{t('verifyInvoice.officialReceipts.amount')}</span>
                        <span className="font-medium">
                          {receipt.receiptAmount !== null ? formatCurrency(receipt.receiptAmount, locale as SupportedLocale) : '—'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
