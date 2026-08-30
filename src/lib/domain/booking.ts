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
  /** FINAL BOOKINGS UX & LIFECYCLE GAP CLOSURE, Section C: which
   *  channel created this booking -- 'staff' | 'club_public_link' |
   *  'club_qr' (see bookings_source_check). Was already written by
   *  every booking-creation RPC but never selected/rendered anywhere
   *  in the frontend until now. */
  source: string
  /** Section B: only set once status = 'completed'. */
  completionSource: 'manual' | 'automatic' | null
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

// FINAL BOOKINGS UX & LIFECYCLE GAP CLOSURE, Section C1: mirrors the
// BOOKING_STATUS_LABELS Arabic-fallback pattern above -- t('bookings.
// sourceLabels.<value>') is the primary lookup, this is only the
// defaultValue fallback if a key is somehow missing. Matches the real
// values allowed by bookings_source_check exactly.
export const BOOKING_SOURCE_LABELS: Record<string, string> = {
  staff: 'الموظف',
  club_public_link: 'رابط الحجز العام',
  club_qr: 'رمز QR للنادي',
}
