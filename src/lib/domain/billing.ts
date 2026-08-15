// Shared domain types for Phase 7 — Billing Core.

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
