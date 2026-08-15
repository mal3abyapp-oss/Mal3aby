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
