import { describe, it, expect } from 'vitest'
import { isCoachOnlyView } from './AcademyPage'

// Regression coverage for the 2026-09-05 P0 fix: AcademyPage.tsx used
// to route purely on `roleKey === 'coach'`, the same defect class as
// TodayPage.tsx's custom-role-empty-dashboard bug. A custom role built
// with coach-equivalent permissions (session.view/attendance.mark, no
// enrollment/program/group management keys) was misrouted to the full
// manager tabs it has no permission to act on.

describe('isCoachOnlyView', () => {
  it('returns false for a membership with no permission keys (e.g. still loading)', () => {
    expect(isCoachOnlyView(undefined)).toBe(false)
    expect(isCoachOnlyView([])).toBe(false)
  })

  it('returns true for a custom role holding only coach-equivalent delivery permissions', () => {
    expect(isCoachOnlyView(['session.view', 'attendance.mark'])).toBe(true)
  })

  it('returns false for a custom role holding academy management permissions', () => {
    expect(isCoachOnlyView(['session.view', 'attendance.mark', 'enrollment.view'])).toBe(false)
    expect(isCoachOnlyView(['academy.group.manage'])).toBe(false)
  })

  it('returns false for a manager-equivalent custom role with no delivery keys at all', () => {
    expect(isCoachOnlyView(['academy.program.manage', 'enrollment.create'])).toBe(false)
  })

  it('returns false for a custom role with unrelated permissions only (e.g. billing/reports)', () => {
    expect(isCoachOnlyView(['payment.view', 'report.view'])).toBe(false)
  })
})
