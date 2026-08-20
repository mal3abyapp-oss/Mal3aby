// Shared domain types for Phase 7 — Billing Core.
import { supabase } from '@/lib/supabase/client'

export interface InvoiceRow {
  id: string
  invoiceNumber: string
  customerId: string
  customerName: string
  status: string
  total: number
  outstanding: number | null
  dueDate: string | null
  daysOverdue: number | null
}

export interface PaymentRow {
  id: string
  amount: number
  method: string
  receivedAt: string
  reference: string | null
  receivedByName: string | null
  // Government / Ministry Collection Compliance -- Phase B: surfaced
  // wherever payment details are shown, since a receipt-required
  // payment with an invisible receipt reference is exactly the kind of
  // gap that leaves staff unable to answer "which official receipt
  // covers this payment?" without leaving the screen.
  officialReceiptSerial: string | null
  officialReceiptStatus: string | null
}

export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'نقدًا',
  card: 'بطاقة',
  bank_transfer: 'تحويل بنكي',
  wallet: 'محفظة إلكترونية',
  other: 'أخرى',
}

// Plain-string money formatting for contexts that need a string value
// (e.g. StatCard's value prop), as opposed to <MoneyDisplay> which renders
// its own styled element.
// Master IA/UX audit (RTL phase): this returns a plain string (not JSX),
// so it can't wrap in a <bdi> element the way MoneyDisplay does -- every
// call site interpolates the return value directly into Arabic text
// (e.g. StatCard's `value` prop, report labels), which is exactly the
// bidi-reversal risk StatCard's own <bdi> wrapper exists to guard
// against for composite values. Unicode isolate marks (U+2066 FIRST
// STRONG ISOLATE / U+2069 POP DIRECTIONAL ISOLATE) provide the same
// protection *inside a plain string* -- they survive string
// concatenation and interpolation, unlike a React element, so this
// stays a drop-in replacement for every existing caller.
const FSI = '⁦'
const PDI = '⁩'

// English-localization sweep: this used to hardcode the 'ar-EG' Intl
// locale regardless of the app's active UI language, so English-mode
// screens rendered Arabic-Indic digits (e.g. "٢٢٠.٠٠") instead of
// Western ones ("220.00"). `locale` now threads through from the
// caller's useDirection() -- defaulted to 'ar' only so any caller that
// genuinely can't reach locale (rare; almost every call site is inside
// an authenticated /app, /portal, or /platform page where
// DirectionProvider is in context) keeps the prior Arabic-digit
// behavior instead of silently changing.
export function formatMoney(amount: number, currency = 'EGP', locale: 'ar' | 'en' = 'ar'): string {
  const formatted = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'ar-EG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
  return `${FSI}${formatted} ${currency}${PDI}`
}

// Master Payment Directive task #81: SINGLE source of truth for invoice
// payment status. Audit (D-015 in AUTONOMOUS_DECISION_LOG.md) found the
// correct outstanding formula (total - paid + completed refunds) had
// been independently reimplemented in 5 places, 4 of them wrong (missing
// refund netting) -- every screen must call this instead of hand-rolling
// the math against payment_allocations/refunds directly.
export type PaymentStatus = 'draft' | 'void' | 'unpaid' | 'partially_paid' | 'paid' | 'partially_refunded' | 'refunded'

export interface InvoicePaymentSummary {
  invoiceId: string
  total: number
  paid: number
  refunded: number
  outstanding: number
  paymentStatus: PaymentStatus
}

export const PAYMENT_STATUS_LABELS: Record<PaymentStatus, string> = {
  draft: 'مسودة',
  void: 'ملغاة',
  unpaid: 'غير مدفوعة',
  partially_paid: 'مدفوعة جزئيًا',
  paid: 'مدفوعة بالكامل',
  partially_refunded: 'مستردة جزئيًا',
  refunded: 'مستردة بالكامل',
}

export const PAYMENT_STATUS_TONE: Record<PaymentStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  draft: 'neutral',
  void: 'neutral',
  unpaid: 'danger',
  partially_paid: 'warning',
  paid: 'success',
  partially_refunded: 'warning',
  refunded: 'neutral',
}

export async function fetchInvoicePaymentSummaries(invoiceIds: string[]): Promise<Map<string, InvoicePaymentSummary>> {
  const map = new Map<string, InvoicePaymentSummary>()
  if (invoiceIds.length === 0) return map
  const { data, error } = await supabase.rpc('get_invoice_payment_summary', { p_invoice_ids: invoiceIds })
  if (error) throw error
  for (const row of data ?? []) {
    map.set(row.invoice_id, {
      invoiceId: row.invoice_id,
      total: Number(row.total),
      paid: Number(row.paid),
      refunded: Number(row.refunded),
      outstanding: Number(row.outstanding),
      paymentStatus: row.payment_status as PaymentStatus,
    })
  }
  return map
}
