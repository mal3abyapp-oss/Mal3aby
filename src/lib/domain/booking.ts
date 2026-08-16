// Shared domain types for Phase 6 — Booking Engine, extended for the V1
// Operational Product Rebuild (booking calendar / quick booking / detail).

export interface BookingRow {
  id: string
  fieldId: string
  branchId: string
  customerId: string
  customerName: string
  customerMobile: string | null
  startAt: string
  endAt: string
  status: string
  totalPrice: number
  discountAmount: number
  bookingSeriesId: string | null
  invoiceId: string | null
  notes: string | null
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

// Status → semantic tone, used consistently across the calendar grid,
// booking cards, and the detail sheet. Never color-only (see StatusBadge).
export const BOOKING_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  pending_payment: 'warning',
  confirmed: 'success',
  checked_in: 'info',
  completed: 'neutral',
  cancelled: 'danger',
  no_show: 'danger',
}

export const FIELD_BLOCK_TYPE_LABELS: Record<string, string> = {
  maintenance: 'صيانة',
  manual: 'إغلاق يدوي',
  holiday: 'إجازة',
}
