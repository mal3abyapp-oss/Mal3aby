// Time Model — Gate 1 (Booking Time Integrity)
//
// Root cause of the P0 "booking stored ~2-3h off" defect: the booking UI
// built a NAIVE datetime string ("2026-08-16T18:00:00", no offset) and
// sent it as a `timestamptz` RPC parameter. Postgres parses an
// offset-less timestamp string using the *session's* default timezone
// (Supabase's session timezone is UTC), not the venue's real timezone —
// so a click on "18:00" (meant as 18:00 Africa/Cairo) was stored as
// 18:00 UTC, i.e. 20:00–21:00 Cairo-local depending on DST. Every
// downstream read/render was internally self-consistent with that wrong
// stored instant, which is why it wasn't visually obvious.
//
// This module is the single place that converts between:
//   - Business Date  ("YYYY-MM-DD", a calendar day with no time component)
//   - Business Time  ("HH:MM", a wall-clock time with no date/zone)
//   - Venue Timezone (an IANA zone name, e.g. "Africa/Cairo" — never
//     hardcoded; always read from clubs.timezone)
//   - Instant         (an absolute point in time — a real UTC ISO string
//     with an explicit offset, safe to hand to a `timestamptz` param)
//
// Never hardcode a fixed UTC+N offset anywhere in this app — Egypt's own
// offset has changed historically (DST reinstated 2023) and other clubs
// may run in other IANA zones entirely. Always resolve the offset for
// the *specific date* being booked, via this module, so DST transitions
// are handled correctly automatically.

/**
 * Returns the UTC offset (in minutes, positive = ahead of UTC) that
 * `ianaTimeZone` observes at the given wall-clock date+time, using the
 * Intl API's real tzdata — correct across DST transitions, and never a
 * hardcoded constant.
 */
function getTimeZoneOffsetMinutes(ianaTimeZone: string, dateStr: string, timeStr: string): number {
  const [year, month, day] = dateStr.split('-').map(Number)
  const [hour, minute] = timeStr.split(':').map(Number)

  // Interpret the wall-clock values as if they were UTC, then ask the
  // Intl formatter what that same instant reads as in the target zone.
  // The difference between the two tells us the zone's offset at that
  // moment (handles DST correctly because we're asking about this
  // specific date, not a fixed rule).
  const asUtc = Date.UTC(year, (month ?? 1) - 1, day, hour ?? 0, minute ?? 0, 0)

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  const parts = dtf.formatToParts(new Date(asUtc))
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0)
  // formatToParts can render hour as "24" for midnight in some locales/zones.
  const zonedHour = get('hour') % 24

  const asIfUtcAgain = Date.UTC(get('year'), get('month') - 1, get('day'), zonedHour, get('minute'), get('second'))

  // asUtc is the instant we assumed; asIfUtcAgain is what that instant's
  // wall-clock reads as in the target zone (re-parsed as if UTC, purely
  // for subtraction). For a zone ahead of UTC (e.g. Cairo, UTC+3),
  // asIfUtcAgain > asUtc, so this gap equals the zone's offset in the
  // conventional sign (positive = ahead of UTC).
  return (asIfUtcAgain - asUtc) / 60000
}

/**
 * Converts a Business Date + Business Time in a given IANA Venue
 * Timezone into a correct absolute Instant, returned as an ISO 8601
 * string with an explicit offset — safe to send as a `timestamptz` RPC
 * parameter (never a naive/offset-less string).
 *
 * Example: toInstant("2026-08-16", "18:00", "Africa/Cairo")
 *   -> "2026-08-16T15:00:00.000Z"  (Cairo is UTC+3 in August 2026 DST)
 */
export function toInstant(dateStr: string, timeStr: string, ianaTimeZone: string): string {
  const normalizedTime = timeStr.length === 5 ? `${timeStr}:00` : timeStr
  const [year, month, day] = dateStr.split('-').map(Number)
  const [hour, minute, second] = normalizedTime.split(':').map(Number)

  const offsetMinutes = getTimeZoneOffsetMinutes(ianaTimeZone, dateStr, timeStr)

  // The instant equals the wall-clock time treated as UTC, minus the
  // zone's offset from UTC (a zone at UTC+3 means local 18:00 is 15:00 UTC).
  const asUtcMillis = Date.UTC(year, (month ?? 1) - 1, day, hour ?? 0, minute ?? 0, second ?? 0)
  const instantMillis = asUtcMillis - offsetMinutes * 60000

  return new Date(instantMillis).toISOString()
}

/**
 * Converts an absolute Instant (ISO string, Date, or timestamptz value
 * from the database) into its Business Date + Business Time components
 * as observed in the given IANA Venue Timezone — the inverse of
 * toInstant, and the correct way to render a stored booking time back
 * to the user (never `new Date(x).toLocaleTimeString()` without an
 * explicit venue timeZone, which silently uses the *browser's* local
 * zone and will misrender for staff viewing from outside the venue's
 * timezone, or whenever browser zone != venue zone).
 */
export function fromInstant(instant: string | Date, ianaTimeZone: string): { date: string; time: string } {
  const d = typeof instant === 'string' ? new Date(instant) : instant

  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: ianaTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const parts = dtf.formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const hour = get('hour') === '24' ? '00' : get('hour')

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${hour}:${get('minute')}`,
  }
}

/**
 * Formats an absolute Instant for display in the venue's timezone using
 * Arabic locale conventions — the venue-timezone-aware replacement for
 * ad-hoc `new Date(x).toLocaleTimeString('ar-EG', ...)` calls, which
 * default to the *browser's* local timezone and can misrender for any
 * viewer not physically in the venue's zone.
 */
export function formatInstant(
  instant: string | Date,
  ianaTimeZone: string,
  options: Intl.DateTimeFormatOptions,
): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant
  return new Intl.DateTimeFormat('ar-EG', { timeZone: ianaTimeZone, ...options }).format(d)
}
