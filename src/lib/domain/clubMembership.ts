// Club Memberships domain -- shared status/tone maps and small pure
// helpers, mirroring src/lib/domain/booking.ts's own BOOKING_STATUS_*
// pattern so every screen (staff MembersSection/MemberDetailDialog,
// Customer 360 tab, Portal "My Memberships", the scanner) renders the
// exact same status vocabulary and color/icon semantics. Status values
// come straight from the DB CHECK constraint / get_club_membership_
// effective_status() (see supabase/migrations/20260826*club_membership*):
// pending_payment | scheduled | active | frozen | expired | cancelled.

import { fromInstant, toInstant } from './time'

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

/**
 * Days remaining until (and including) the given effective end date,
 * floor-clamped at 0. Client-side display only -- the authoritative
 * status/date still comes from the server (effective_end_date itself
 * is already server-computed with freeze math applied).
 *
 * STAFF OPERATIONS ACCEPTANCE (2026-08-31) Phase A fix: this used to
 * anchor the end date at 23:59:59Z (UTC) and compare against
 * Date.now() (the browser's own instant) -- i.e. it silently treated
 * the club's calendar day as ending at UTC midnight, and "now" as
 * whatever moment the *browser* is in, regardless of either the
 * club's or the browser's real timezone. For a club east of UTC (e.g.
 * Africa/Cairo, UTC+2/+3), the club's real end-of-day is several
 * hours AFTER UTC midnight, so a membership expiring "tonight" club-
 * local already read as expired (days=0) for several hours while it
 * was still genuinely the expiry day locally -- an off-by-one that
 * got worse the further the viewer's browser zone diverged from the
 * club's own zone (the two zones need not match: a club owner
 * checking the portal from abroad must still see the CLUB's day, not
 * their own). Fixed to require the club's own IANA timezone (reusing
 * toInstant/fromInstant from lib/domain/time.ts -- the same Gate 1
 * time model every booking/Academy timestamp already goes through,
 * never a duplicated ad-hoc calculation) and compare business-DATES
 * (whole club-local calendar days), not raw millisecond instants
 * anchored to the wrong zone. `today` is an explicit optional
 * override (mirrors getAcademySubscriptionDisplayStatus's own
 * pattern in this file's sibling academy.ts) so tests can pin an
 * exact club-local "today" without depending on the real clock.
 */
export function daysRemaining(
  effectiveEndDate: string | null,
  ianaTimeZone: string,
  today?: string,
): number | null {
  if (!effectiveEndDate) return null
  const clubToday = today ?? fromInstant(new Date(), ianaTimeZone).date
  // Compare the two business dates as club-local midnight instants --
  // both anchored via the same toInstant() Gate 1 conversion, so the
  // subtraction is always a whole number of club-local calendar days
  // regardless of DST or which zone the browser itself is in.
  const endMs = new Date(toInstant(effectiveEndDate, '00:00', ianaTimeZone)).getTime()
  const todayMs = new Date(toInstant(clubToday, '00:00', ianaTimeZone)).getTime()
  if (Number.isNaN(endMs) || Number.isNaN(todayMs)) return null
  return Math.max(0, Math.round((endMs - todayMs) / (1000 * 60 * 60 * 24)))
}
