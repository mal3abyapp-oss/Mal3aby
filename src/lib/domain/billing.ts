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
export function formatMoney(amount: number, currency = 'EGP'): string {
  const formatted = new Intl.NumberFormat('ar-EG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
  return `${formatted} ${currency}`
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
