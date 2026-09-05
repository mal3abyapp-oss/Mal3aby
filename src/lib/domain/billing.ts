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

// COMMERCIAL PACKAGING (2026-09-04): public_plans contains 2 surviving
// legacy plans (Monthly/Annual, display_order 1/4) kept is_public=true
// ONLY because real existing subscriptions still reference them (see
// MAL3ABY_V1_PRICING_MIGRATION.md) — they must NEVER be offered to new
// customers on any public/authenticated commercial surface. Filtering
// is a frontend display decision, not a database change.
//
// P0 fix (2026-09-05): this filter used to live only inside
// PricingPage.tsx (as NEW_COMMERCIAL_TIER_MIN_DISPLAY_ORDER), so it was
// never applied to SubscriptionPage.tsx or HomePage.tsx's own
// public_plans queries — both leaked the legacy 499/4,499 EGP plans
// live in production. Extracted here as the single shared source of
// truth so a future 4th commercial surface can't reintroduce the same
// leak by simply forgetting to copy a local constant.
export const NEW_COMMERCIAL_TIER_MIN_DISPLAY_ORDER = 10

export function filterPublicCommercialPlans<T extends { display_order: number | null }>(plans: readonly T[]): T[] {
  return plans.filter((p) => (p.display_order ?? 0) >= NEW_COMMERCIAL_TIER_MIN_DISPLAY_ORDER)
}

// P0 fix (2026-09-05): HomePage.tsx's landing-page pricing preview used
// to show a hardcoded English "Save 25%" label (i18n key
// publicSite.pricing.discounts.year_1), left over from an earlier
// pricing model and wrong against the real ~16.2-16.5% annual
// discounts (the Arabic side separately read the DB's own
// discount_label text directly, so only English was visibly wrong, but
// both were one hardcoded/DB-text value away from ever drifting from
// reality again). This computes the discount mathematically from the
// real monthly/annual price pair for a plan family, with one
// consistent rounding policy (1 decimal place), so both locales always
// show the true number regardless of future price changes.
export function computeAnnualDiscountsByFamily<T extends { name: string | null; billing_interval: string | null; price: number | string | null }>(
  plans: readonly T[],
): Map<string, number> {
  const result = new Map<string, number>()
  for (const p of plans) {
    if (p.billing_interval !== 'year' || !p.name) continue
    const familyName = p.name.replace(/\s*\(Annual\)\s*$/, '')
    const monthly = plans.find((m) => m.billing_interval === 'month' && m.name === familyName)
    if (!monthly || monthly.price == null || p.price == null) continue
    const annualEquivalentOfMonthly = Number(monthly.price) * 12
    const discountPct = (1 - Number(p.price) / annualEquivalentOfMonthly) * 100
    result.set(familyName, Math.round(discountPct * 10) / 10)
  }
  return result
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

// Reports + Invoices + Universal Entity Drill-Down audit: several
// screens (Customer 360's payment history, the Reconciliation report)
// have a real payment_id but no invoice_id in their RPC's return shape
// (get_customer_financial_account, get_financial_reconciliation_report),
// so a payment row had no way to reach its own invoice. Rather than
// widen either RPC (this codebase's own standing caution around
// RPC-body edits -- see BookingDetailSheet's fetchInvoiceNumber for the
// same reasoning), batch-resolve payment_id -> invoice_id via
// payment_allocations, the same table BillingPage's fetchInvoicePayments
// already joins through for the reverse direction. Shared here rather
// than duplicated per screen.
export async function fetchPaymentInvoiceIds(paymentIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (paymentIds.length === 0) return map
  const { data, error } = await supabase
    .from('payment_allocations')
    .select('payment_id, invoice_id')
    .in('payment_id', paymentIds)
  if (error) return map
  for (const row of data ?? []) {
    if (!map.has(row.payment_id)) map.set(row.payment_id, row.invoice_id)
  }
  return map
}
