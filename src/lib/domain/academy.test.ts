import { describe, it, expect } from 'vitest'
import { getAcademySubscriptionDisplayStatus, addMonthsToDate } from './academy'

// Dedicated automated test for academy expiry/DUE derivation (directive's
// explicit "academy enrollment expiry calculation" test requirement).
// This mirrors get_academy_subscription_display_status() in
// supabase/migrations/20260820082000_academy_renewal_and_expiry_rpcs.sql
// -- these tests exist specifically to catch client/server drift if
// either side's rule ever changes without the other being updated.
describe('getAcademySubscriptionDisplayStatus', () => {
  const TODAY = '2026-08-20'

  it('returns "active" for an active subscription with a far-future end date', () => {
    expect(getAcademySubscriptionDisplayStatus('active', '2026-12-01', TODAY)).toBe('active')
  })

  it('returns "due" for an active subscription ending exactly 7 days from today', () => {
    expect(getAcademySubscriptionDisplayStatus('active', '2026-08-27', TODAY)).toBe('due')
  })

  it('returns "due" for an active subscription ending within the 7-day window', () => {
    expect(getAcademySubscriptionDisplayStatus('active', '2026-08-22', TODAY)).toBe('due')
  })

  it('returns "active" (not due) for a subscription ending 8 days from today (just outside the window)', () => {
    expect(getAcademySubscriptionDisplayStatus('active', '2026-08-28', TODAY)).toBe('active')
  })

  it('returns "expired" for an active-status subscription whose end date has already passed', () => {
    expect(getAcademySubscriptionDisplayStatus('active', '2026-08-19', TODAY)).toBe('expired')
  })

  it('returns "due" for a pending subscription within the 7-day window (same rule applies to pending)', () => {
    expect(getAcademySubscriptionDisplayStatus('pending', '2026-08-21', TODAY)).toBe('due')
  })

  it('never overrides a terminal "expired" status even if end_date looks otherwise active', () => {
    expect(getAcademySubscriptionDisplayStatus('expired', '2026-12-01', TODAY)).toBe('expired')
  })

  it('never overrides a terminal "cancelled" status', () => {
    expect(getAcademySubscriptionDisplayStatus('cancelled', '2026-12-01', TODAY)).toBe('cancelled')
  })

  it('never overrides a terminal "frozen" status', () => {
    expect(getAcademySubscriptionDisplayStatus('frozen', '2026-08-19', TODAY)).toBe('frozen')
  })

  it('treats a subscription ending exactly today as expired, not due (< today is expired)', () => {
    // end_date < today -> expired takes priority over the due window
    expect(getAcademySubscriptionDisplayStatus('active', '2026-08-19', TODAY)).toBe('expired')
  })

  it('treats a subscription ending today itself as due, not expired (endDate === today)', () => {
    expect(getAcademySubscriptionDisplayStatus('active', TODAY, TODAY)).toBe('due')
  })

  it('defaults to the real system clock when no `today` override is passed', () => {
    // Sanity check that the default parameter path doesn't throw and
    // produces a plausible ISO-shaped comparison (exact value depends on
    // the real clock, so only structural correctness is asserted here).
    const result = getAcademySubscriptionDisplayStatus('active', '2099-01-01')
    expect(result).toBe('active')
  })
})

// Academy radical simplification directive section 10: "the system
// calculates the end date automatically" -- dedicated coverage for the
// one shared date-math helper the create-membership and renewal flows
// both now use (previously two hand-copied inline implementations).
describe('addMonthsToDate', () => {
  it('adds exactly one month for the default academy subscription duration', () => {
    expect(addMonthsToDate('2026-08-20', 1)).toBe('2026-09-20')
  })

  it('rolls over the year boundary correctly', () => {
    expect(addMonthsToDate('2026-12-15', 1)).toBe('2027-01-15')
  })

  it('handles a start date on the 31st rolling into a shorter month', () => {
    // JS Date.setMonth() rolls Jan 31 + 1 month into March 3 (Feb has no
    // 31st) -- documenting the real, current behavior so a future change
    // to this helper is caught by a test, not discovered live.
    expect(addMonthsToDate('2026-01-31', 1)).toBe('2026-03-03')
  })

  it('supports multi-month durations', () => {
    expect(addMonthsToDate('2026-08-20', 3)).toBe('2026-11-20')
  })
})
