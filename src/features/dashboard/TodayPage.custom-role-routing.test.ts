import { describe, it, expect } from 'vitest'
import { isCoachOnlyDashboard } from './TodayPage'

// Regression coverage for the 2026-09-06 role/permissions review fix:
// TodayPage.tsx used to route purely on `roleKey === 'coach'`, the same
// defect class AcademyPage.tsx had already been fixed for on
// 2026-09-05 (see AcademyPage.custom-role-routing.test.ts). A custom
// role built with coach-equivalent permissions (session/attendance
// keys, none of the manager/reception/owner keys) matched none of
// isManager/isReception/isOwner/isCoach and fell through to a
// dashboard body with nothing but the header and first-run checklist
// -- a blank Today screen instead of CoachTodayView.

describe('isCoachOnlyDashboard', () => {
  it('returns true for the built-in coach system role regardless of permission keys', () => {
    expect(isCoachOnlyDashboard('coach', [])).toBe(true)
    expect(isCoachOnlyDashboard('coach', undefined)).toBe(true)
  })

  it('returns false for a membership with no permission keys and no coach roleKey (e.g. still loading)', () => {
    expect(isCoachOnlyDashboard(undefined, undefined)).toBe(false)
    expect(isCoachOnlyDashboard(undefined, [])).toBe(false)
  })

  it('returns true for a custom role holding only coach-equivalent delivery permissions', () => {
    expect(isCoachOnlyDashboard(undefined, ['session.view', 'attendance.mark'])).toBe(true)
    expect(isCoachOnlyDashboard(undefined, ['attendance.view', 'attendance.mark', 'field.view', 'player.view', 'qr.scan', 'session.manage', 'session.view'])).toBe(true)
  })

  it('returns false for a custom role holding manager permission keys', () => {
    expect(isCoachOnlyDashboard(undefined, ['session.view', 'attendance.mark', 'staff.view'])).toBe(false)
  })

  it('returns false for a custom role holding reception (booking.view) or owner (club.update) keys', () => {
    expect(isCoachOnlyDashboard(undefined, ['session.view', 'booking.view'])).toBe(false)
    expect(isCoachOnlyDashboard(undefined, ['session.view', 'club.update'])).toBe(false)
  })

  it('returns false for a custom role with unrelated permissions only (e.g. billing/reports)', () => {
    expect(isCoachOnlyDashboard(undefined, ['payment.view', 'report.view'])).toBe(false)
  })
})
