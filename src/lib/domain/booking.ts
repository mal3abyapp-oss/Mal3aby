// Shared domain types for Phase 6 — Booking Engine.

export interface BookingRow {
  id: string
  fieldId: string
  customerId: string
  customerName: string
  startAt: string
  endAt: string
  status: string
  totalPrice: number
  bookingSeriesId: string | null
}

export interface FieldBlockRow {
  id: string
  fieldId: string
  startAt: string
  endAt: string
  type: string
  reason: string | null
}

export const BOOKING_STATUS_LABELS: Record<string, string> = {
  pending_payment: 'بانتظار الدفع',
  confirmed: 'مؤكد',
  checked_in: 'تم تسجيل الحضور',
  completed: 'مكتمل',
  cancelled: 'ملغي',
  no_show: 'لم يحضر',
}
