// Club Memberships domain -- shared status/tone maps and small pure
// helpers, mirroring src/lib/domain/booking.ts's own BOOKING_STATUS_*
// pattern so every screen (staff MembersSection/MemberDetailDialog,
// Customer 360 tab, Portal "My Memberships", the scanner) renders the
// exact same status vocabulary and color/icon semantics. Status values
// come straight from the DB CHECK constraint / get_club_membership_
// effective_status() (see supabase/migrations/20260826*club_membership*):
// pending_payment | scheduled | active | frozen | expired | cancelled.

export type ClubMembershipEffectiveStatus =
  | 'pending_payment'
  | 'scheduled'
  | 'active'
  | 'frozen'
  | 'expired'
  | 'cancelled'

export const CLUB_MEMBERSHIP_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  pending_payment: 'warning',
  scheduled: 'info',
  active: 'success',
  frozen: 'warning',
  expired: 'danger',
  cancelled: 'neutral',
}

export const DURATION_UNIT_LABEL_KEYS: Record<string, string> = {
  day: 'clubMemberships.durationUnits.day',
  month: 'clubMemberships.durationUnits.month',
  year: 'clubMemberships.durationUnits.year',
}

/**
 * UI-only preview of a plan's end date given a start date -- never
 * trusted as the real value (the sell_club_membership/
 * renew_club_membership RPCs compute the authoritative end date
 * server-side). Mirrors addMonthsToDate's spirit but supports all three
 * duration units this domain has (day/month/year) rather than only
 * months.
 */
export function previewClubMembershipEndDate(
  startDate: string,
  durationValue: number,
  durationUnit: 'day' | 'month' | 'year',
): string {
  const d = new Date(`${startDate}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return startDate
  if (durationUnit === 'day') {
    d.setUTCDate(d.getUTCDate() + durationValue)
  } else if (durationUnit === 'month') {
    d.setUTCMonth(d.getUTCMonth() + durationValue)
  } else {
    d.setUTCFullYear(d.getUTCFullYear() + durationValue)
  }
  // Subtract one day so a 1-month plan starting 2026-01-01 previews as
  // ending 2026-01-31 (inclusive last day), matching how the server-side
  // computation treats duration periods elsewhere in this codebase
  // (addMonthsToDate has the same -1 day convention).
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** Days remaining until (and including) the given effective end date, floor-clamped at 0. Client-side display only. */
export function daysRemaining(effectiveEndDate: string | null): number | null {
  if (!effectiveEndDate) return null
  const end = new Date(`${effectiveEndDate}T23:59:59Z`).getTime()
  const now = Date.now()
  if (Number.isNaN(end)) return null
  return Math.max(0, Math.ceil((end - now) / (1000 * 60 * 60 * 24)))
}
