import { describe, it, expect, vi, afterEach } from 'vitest'
import { daysRemaining, daysRemainingFromInstant, previewClubMembershipEndDate } from './clubMembership'

// STAFF OPERATIONS ACCEPTANCE (2026-08-31) Phase A: dedicated regression
// coverage for the daysRemaining() timezone defect fix -- this used to
// anchor the end date at 23:59:59Z (UTC) and compare against the
// browser's own Date.now(), producing an off-by-one whenever the
// club's real timezone (or the viewer's browser timezone) wasn't UTC.
// See clubMembership.ts's own doc comment on daysRemaining() for the
// full root-cause explanation.
describe('daysRemaining', () => {
  const CAIRO = 'Africa/Cairo' // UTC+2/+3 (DST) -- the club's real zone in production data
  const LOS_ANGELES = 'America/Los_Angeles' // UTC-7/-8 -- used to prove browser zone never leaks in

  it('returns null when there is no effective end date', () => {
    expect(daysRemaining(null, CAIRO)).toBeNull()
  })

  it('returns a positive whole-day count for a far-future end date', () => {
    expect(daysRemaining('2026-09-15', CAIRO, '2026-08-31')).toBe(15)
  })

  it('returns 0 for a membership expiring exactly today (club-local)', () => {
    expect(daysRemaining('2026-08-31', CAIRO, '2026-08-31')).toBe(0)
  })

  it('floor-clamps at 0 for an already-expired end date (never negative)', () => {
    expect(daysRemaining('2026-08-20', CAIRO, '2026-08-31')).toBe(0)
  })

  it('handles a month-boundary span correctly (Aug 31 -> Sep 30)', () => {
    expect(daysRemaining('2026-09-30', CAIRO, '2026-08-31')).toBe(30)
  })

  it('handles a year-boundary span correctly (Dec 20 -> Jan 5)', () => {
    expect(daysRemaining('2027-01-05', CAIRO, '2026-12-20')).toBe(16)
  })

  it('gives the same club-local day count regardless of which IANA zone is passed for an equivalent calendar span', () => {
    // The whole point of comparing business DATES rather than raw
    // instants: a 10-day span is 10 days in every zone, because both
    // ends are anchored to the SAME zone's midnight -- there is no
    // zone-crossing to introduce drift.
    expect(daysRemaining('2026-09-10', CAIRO, '2026-08-31')).toBe(10)
    expect(daysRemaining('2026-09-10', LOS_ANGELES, '2026-08-31')).toBe(10)
  })

  describe('real-clock behavior (no `today` override) -- proves the club zone, not the browser zone, is authoritative', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('reads a membership as still active (days=1) when it is 23:00 UTC on Aug 30 -- already Aug 31 in Cairo (UTC+3) but still Aug 30 in Los Angeles (UTC-7)', () => {
      // 23:00 UTC on 2026-08-30 is:
      //   - 02:00 on 2026-08-31 in Africa/Cairo (UTC+3 in August DST)
      //   - 16:00 on 2026-08-30 in America/Los_Angeles (UTC-7)
      // A membership expiring 2026-08-31 must read as the SAME
      // days-remaining value regardless of which machine/browser
      // timezone is running this code -- only the CLUB's zone decides
      // whether "today" has rolled over to the 31st.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-08-30T23:00:00.000Z'))

      // Club-local (Cairo) already sees 2026-08-31 as today, so a
      // membership expiring 2026-08-31 has 0 days remaining (expires today).
      expect(daysRemaining('2026-08-31', CAIRO)).toBe(0)

      // The exact same wall-clock instant, but the club's zone here is
      // Los Angeles, where it's still 2026-08-30 -- the SAME
      // 2026-08-31 expiry date is genuinely 1 day away for THIS club,
      // proving the calculation follows the passed-in club zone, not
      // whatever zone the test runner's own machine happens to be in.
      expect(daysRemaining('2026-08-31', LOS_ANGELES)).toBe(1)
    })

    it('does not flip a membership to expired near midnight UTC when it is still daytime in the club\'s own zone', () => {
      // 00:30 UTC on 2026-09-01 is still 2026-08-31 in Los Angeles
      // (UTC-7) -- the old UTC-anchored implementation would have
      // already rolled this over to a new UTC calendar day and
      // miscounted; the club-zone-aware version must not.
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-09-01T00:30:00.000Z'))

      expect(daysRemaining('2026-08-31', LOS_ANGELES)).toBe(0) // still today, LA-local
    })
  })
})

// STAFF OPERATIONS ACCEPTANCE post-closure cleanup (2026-08-31):
// dedicated coverage for daysRemainingFromInstant() -- extracted from
// AppLayout.tsx's platform-subscription trial banner, which had the
// exact same browser/UTC-vs-club-local defect class as daysRemaining()'s
// own original bug (Date.now() compared directly against end_at's raw
// UTC instant). Unlike daysRemaining(), the input here is a real
// Instant (a timestamptz string, e.g. "2026-08-31T21:00:00.000Z") --
// these tests specifically exercise the fromInstant() resolution step,
// not just the already-covered daysRemaining() business-date math.
describe('daysRemainingFromInstant', () => {
  const CAIRO = 'Africa/Cairo' // UTC+2/+3 (DST)
  const LOS_ANGELES = 'America/Los_Angeles' // UTC-7/-8

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns null when there is no end instant', () => {
    expect(daysRemainingFromInstant(null, CAIRO)).toBeNull()
  })

  it('club-local today: an instant at club-local midday today resolves to 0 days remaining', () => {
    // 2026-08-31T10:00:00Z is 2026-08-31 13:00 in Cairo (UTC+3) --
    // still today, club-local.
    expect(daysRemainingFromInstant('2026-08-31T10:00:00.000Z', CAIRO, '2026-08-31')).toBe(0)
  })

  it('near midnight: 23:00 UTC on Aug 30 is already Aug 31 club-local in Cairo but still Aug 30 in Los Angeles -- same instant, different club-local day', () => {
    const endInstant = '2026-08-31T12:00:00.000Z' // Aug 31 midday UTC, unambiguously Aug 31 in both zones
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T23:00:00.000Z')) // "now" -- ambiguous zone

    // Cairo: "now" (23:00 UTC Aug 30) is already 02:00 Aug 31 club-local,
    // so the Aug-31 end instant is 0 days away.
    expect(daysRemainingFromInstant(endInstant, CAIRO)).toBe(0)
    // Los Angeles: "now" (23:00 UTC Aug 30) is still 16:00 Aug 30
    // club-local, so the same Aug-31 end instant is genuinely 1 day away.
    expect(daysRemainingFromInstant(endInstant, LOS_ANGELES)).toBe(1)
  })

  it('browser timezone != club timezone: the calculation follows the CLUB zone regardless of which zone the test runner itself is in', () => {
    // No system-time mocking here -- this proves the function accepts
    // an explicit club timezone independent of the host machine's own
    // Intl default zone (whatever that happens to be in CI/locally).
    expect(daysRemainingFromInstant('2026-09-10T12:00:00.000Z', CAIRO, '2026-08-31')).toBe(10)
    expect(daysRemainingFromInstant('2026-09-10T12:00:00.000Z', LOS_ANGELES, '2026-08-31')).toBe(10)
  })

  it('zero days: an end instant on club-local today returns exactly 0', () => {
    // 20:59 UTC on Aug 31 is still 2026-08-31 23:59 in Cairo (UTC+3) --
    // deliberately close to club-local midnight without crossing into
    // Sep 1, unlike a naive 23:59 UTC pick which would already be
    // Sep 1 club-local.
    expect(daysRemainingFromInstant('2026-08-31T20:59:00.000Z', CAIRO, '2026-08-31')).toBe(0)
  })

  it('expired: an end instant in the club-local past floor-clamps to 0, never negative', () => {
    expect(daysRemainingFromInstant('2026-08-01T12:00:00.000Z', CAIRO, '2026-08-31')).toBe(0)
  })

  it('month boundary: Aug 31 -> Sep 30 spans correctly', () => {
    expect(daysRemainingFromInstant('2026-09-30T12:00:00.000Z', CAIRO, '2026-08-31')).toBe(30)
  })

  it('year boundary: Dec 20 -> Jan 5 spans correctly', () => {
    expect(daysRemainingFromInstant('2027-01-05T12:00:00.000Z', CAIRO, '2026-12-20')).toBe(16)
  })
})

describe('previewClubMembershipEndDate (unchanged, sanity check alongside the daysRemaining fix)', () => {
  it('previews a 1-month plan as ending the day before the same date next month', () => {
    expect(previewClubMembershipEndDate('2026-08-01', 1, 'month')).toBe('2026-08-31')
  })
})
