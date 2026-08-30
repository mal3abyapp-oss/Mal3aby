import { describe, it, expect } from 'vitest'
import { toDateKey, toUtcDate, addDaysToKey, addMonths, compareDateKeys, parseDateKey } from './date-calendar'

// FINAL BOOKINGS UX & LIFECYCLE GAP CLOSURE, Section I (test matrix
// items 1-6): dedicated automated coverage for the calendar's pure
// date arithmetic -- today/tomorrow/+7 days/+30 days/month boundary/
// year boundary. These functions deliberately operate on plain
// "YYYY-MM-DD" calendar-day strings via a UTC-anchored Date used only
// for arithmetic (never rendered, never converted to a real Instant)
// -- see date-calendar.tsx's own header comment for why this avoids
// DST/local-timezone drift entirely. Club-timezone correctness itself
// (item 10: near-midnight) is a property of the CALLER always passing
// in fromInstant(new Date(), clubTimezone).date as `todayDate`/`value`
// -- already covered by the existing time.test.ts-style coverage of
// fromInstant/toInstant, not re-tested here.

describe('parseDateKey / toUtcDate / toDateKey round-trip', () => {
  it('round-trips a plain date key with no drift', () => {
    expect(toDateKey(toUtcDate('2026-08-31'))).toBe('2026-08-31')
  })

  it('parses year/month/day components correctly', () => {
    expect(parseDateKey('2026-02-05')).toEqual({ year: 2026, month: 2, day: 5 })
  })
})

describe('addDaysToKey (test matrix items: today, tomorrow, +7 days, +30 days)', () => {
  const today = '2026-08-31'

  it('item 1 -- today: adding 0 days returns the same date', () => {
    expect(addDaysToKey(today, 0)).toBe('2026-08-31')
  })

  it('item 2 -- tomorrow: adding 1 day', () => {
    expect(addDaysToKey(today, 1)).toBe('2026-09-01')
  })

  it('item 3 -- +7 days', () => {
    expect(addDaysToKey(today, 7)).toBe('2026-09-07')
  })

  it('item 4 -- +30 days (crosses a month boundary along the way)', () => {
    expect(addDaysToKey(today, 30)).toBe('2026-09-30')
  })

  it('handles a negative delta (going backward) correctly', () => {
    expect(addDaysToKey('2026-09-01', -1)).toBe('2026-08-31')
  })
})

describe('addMonths (test matrix item 5: month boundary; item 6: year boundary)', () => {
  it('item 5 -- month boundary: Jan 31 + 1 month clamps to Feb 28 (2026 is not a leap year)', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
  })

  it('leap year: Jan 31 2028 + 1 month clamps to Feb 29 (2028 IS a leap year)', () => {
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
  })

  it('item 6 -- year boundary: December + 1 month rolls into January of the next year', () => {
    expect(addMonths('2026-12-15', 1)).toBe('2027-01-15')
  })

  it('year boundary going backward: January - 1 month rolls into December of the previous year', () => {
    expect(addMonths('2027-01-15', -1)).toBe('2026-12-15')
  })

  it('a mid-month day that exists in every month is preserved exactly (no clamping needed)', () => {
    expect(addMonths('2026-03-15', 3)).toBe('2026-06-15')
  })

  it('multiple months forward, still correct at a leap-year day boundary', () => {
    expect(addMonths('2027-12-31', 2)).toBe('2028-02-29')
  })
})

// Regression test for a real bug found live in this session's own
// browser verification pass: month-navigation bounds were compared
// against the exact maxDate/minDate string, not the DATE'S MONTH --
// with maxDate = 2026-09-02, viewing September still allowed
// navigating to October (viewMonth = "2026-09-01" < "2026-09-02"),
// even though October has nothing selectable inside the window at
// all. This test exercises the same month-vs-exact-date comparison
// the DateCalendar component itself performs for canGoNextMonth/
// canGoPrevMonth (duplicated here as pure logic since the component
// doesn't export its derived booleans directly -- the underlying
// primitives it's built from, compareDateKeys and the month-start
// normalization, are what's actually under test).
describe('month navigation bounds (regression: exact-date comparison vs month comparison)', () => {
  function monthStart(key: string) {
    const { year, month } = parseDateKey(key)
    return `${year}-${String(month).padStart(2, '0')}-01`
  }

  it('viewing the max date\'s own month must NOT allow navigating further forward', () => {
    const maxDate = '2026-09-02'
    const viewMonth = '2026-09-01' // viewing September, the same month as maxDate
    const canGoNext = compareDateKeys(monthStart(viewMonth), monthStart(maxDate)) < 0
    expect(canGoNext).toBe(false) // September IS maxDate's month -- no further forward navigation
  })

  it('viewing a month strictly before the max date\'s month still allows navigating forward', () => {
    const maxDate = '2026-09-02'
    const viewMonth = '2026-08-01'
    const canGoNext = compareDateKeys(monthStart(viewMonth), monthStart(maxDate)) < 0
    expect(canGoNext).toBe(true)
  })

  it('viewing the min date\'s own month must NOT allow navigating further backward', () => {
    const minDate = '2026-08-31'
    const viewMonth = '2026-08-01'
    const canGoPrev = compareDateKeys(monthStart(viewMonth), monthStart(minDate)) > 0
    expect(canGoPrev).toBe(false)
  })
})

describe('compareDateKeys', () => {
  it('returns -1 when the first date is earlier', () => {
    expect(compareDateKeys('2026-08-30', '2026-08-31')).toBe(-1)
  })
  it('returns 1 when the first date is later', () => {
    expect(compareDateKeys('2026-09-01', '2026-08-31')).toBe(1)
  })
  it('returns 0 for equal dates', () => {
    expect(compareDateKeys('2026-08-31', '2026-08-31')).toBe(0)
  })
  it('compares correctly across a year boundary (lexicographic string compare on a zero-padded key)', () => {
    expect(compareDateKeys('2026-12-31', '2027-01-01')).toBe(-1)
  })
})
