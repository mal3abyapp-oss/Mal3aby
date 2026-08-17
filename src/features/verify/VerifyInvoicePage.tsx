import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { StatusBadge } from '@/components/ui/status-badge'
import { formatMoney, PAYMENT_STATUS_LABELS, PAYMENT_STATUS_TONE, type PaymentStatus } from '@/lib/domain/billing'
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
}

async function verifyInvoice(token: string): Promise<VerificationResult> {
  const { data, error } = await supabase.rpc('verify_invoice_public', { p_token: token })
  if (error) throw error
  const row = data?.[0]
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
  }
}

export function VerifyInvoicePage() {
  const { token } = useParams<{ token: string }>()

  const { data, isLoading, isError } = useQuery({
    queryKey: ['verify-invoice', token],
    queryFn: () => verifyInvoice(token!),
    enabled: !!token,
    retry: false,
  })

  return (
    <div className="flex min-h-screen items-center justify-center bg-page-bg p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 text-center shadow">
        <p className="mb-4 text-sm font-medium text-text-secondary">التحقق من فاتورة</p>

        {isLoading && <p className="text-sm text-text-secondary">جارٍ التحقق...</p>}

        {!isLoading && (isError || !data || data.result === 'invalid') && (
          <div className="flex flex-col items-center gap-3">
            <XCircle className="size-12 text-status-danger" />
            <p className="font-medium text-status-danger">رمز غير صالح</p>
            <p className="text-sm text-text-secondary">
              لم يتم العثور على فاتورة مطابقة لهذا الرمز. تأكد من مسح الرمز الصحيح، أو تواصل مع النادي مباشرة للتأكد.
            </p>
          </div>
        )}

        {!isLoading && data && data.result === 'success' && (
          <div className="flex flex-col items-center gap-3">
            <CheckCircle2 className="size-12 text-status-success" />
            <p className="font-medium text-status-success">فاتورة موثّقة</p>
            <div className="w-full rounded-md border border-border p-4 text-start text-sm">
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">رقم الفاتورة</span>
                <span className="font-medium"><bdi>{data.invoiceNumber}</bdi></span>
              </div>
              {data.customerName && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">العميل</span>
                  <span className="font-medium">{data.customerName}</span>
                </div>
              )}
              {data.bookingRef && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">رقم الحجز</span>
                  <span className="font-medium"><bdi>{data.bookingRef}</bdi></span>
                </div>
              )}
              {data.fieldName && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">الملعب</span>
                  <span className="font-medium">{data.fieldName}</span>
                </div>
              )}
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">تاريخ الإصدار</span>
                <span className="font-medium">
                  {data.issuedAt ? new Date(data.issuedAt).toLocaleDateString('ar-EG') : '—'}
                </span>
              </div>
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">الإجمالي</span>
                <span className="font-medium">{data.total !== null ? formatMoney(data.total) : '—'}</span>
              </div>
              {data.paid !== null && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">المدفوع</span>
                  <span className="font-medium text-status-success">{formatMoney(data.paid)}</span>
                </div>
              )}
              {data.outstanding !== null && data.outstanding > 0 && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">المتبقي</span>
                  <span className="font-medium text-status-danger">{formatMoney(data.outstanding)}</span>
                </div>
              )}
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">حالة السداد</span>
                {data.paymentStatus && (
                  <StatusBadge tone={PAYMENT_STATUS_TONE[data.paymentStatus]} label={PAYMENT_STATUS_LABELS[data.paymentStatus]} />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
