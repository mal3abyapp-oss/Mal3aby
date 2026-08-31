// Shared domain types for Phase 10 — Academy Structure.

/**
 * Academy radical simplification directive section 10: "the employee
 * should never calculate the end date manually." Given a start date and
 * a whole-month duration, returns the ISO end date exactly one calendar
 * month later -- the single implementation both the create-membership
 * wizard and the renewal flow use (previously duplicated inline in
 * EnrollmentSection.tsx's two onChange handlers, one for enrollment and
 * one for renewal, with identical logic hand-copied twice).
 */
export function addMonthsToDate(startDateIso: string, months: number): string {
  const d = new Date(startDateIso)
  d.setMonth(d.getMonth() + months)
  return d.toISOString().slice(0, 10)
}

export interface ProgramRow {
  id: string
  name: string
  nameAr: string
  sport: string | null
  status: string
}

export interface SeasonRow {
  id: string
  programId: string | null
  name: string
  startDate: string
  endDate: string
}

export interface AgeGroupRow {
  id: string
  name: string
  minAge: number | null
  maxAge: number | null
}

/**
 * Client-side mirror of get_academy_subscription_display_status() (see
 * supabase/migrations/20260820082000_academy_renewal_and_expiry_rpcs.sql
 * and its search_path fix in 20260820100000). Pure derivation, no cron
 * dependency: an active/pending subscription within 7 days of end_date
 * reads as DUE, past end_date reads as EXPIRED, even before the daily
 * pg_cron sweep has actually transitioned the stored status. Never
 * overrides a terminal status (frozen/expired/cancelled display exactly
 * as stored) -- extracted out of EnrollmentSection.tsx's render body so
 * this exact rule has real test coverage instead of only being
 * exercised implicitly through a rendered component.
 *
 * ACADEMY OPERATIONS HARDENING (AC6): `today`'s default used to be
 * `new Date().toISOString().slice(0, 10)` -- the BROWSER's local
 * timezone, not the club's. A staff member viewing this badge from a
 * timezone that differs from the club's own (e.g. anywhere west of
 * UTC, viewing a UTC+3 club near midnight) could see a wrong DUE/
 * EXPIRED label for up to a day, purely from where their browser
 * happened to be, not the club's real wall-clock day. Every real call
 * site now passes an explicit club-local `today` (see
 * EnrollmentSection.tsx's useClubTimezone + fromInstant usage) --
 * the browser-clock default remains ONLY as a last-resort fallback
 * for a caller that genuinely cannot reach the club's timezone yet
 * (e.g. before it has loaded), matching the same defensive-fallback
 * pattern already established elsewhere in this codebase (see
 * useResolvedFieldPrice's retry:false handling for an analogous
 * "correct at rest, gracefully degraded loading" case).
 */
export function getAcademySubscriptionDisplayStatus(
  status: string,
  endDate: string,
  today: string = new Date().toISOString().slice(0, 10),
): string {
  if (['expired', 'cancelled', 'frozen'].includes(status)) return status
  if (endDate < today) return 'expired'
  const sevenDaysFromToday = new Date(new Date(today).getTime() + 7 * 86400000).toISOString().slice(0, 10)
  if (endDate <= sevenDaysFromToday) return 'due'
  return status
}

export interface GroupRow {
  id: string
  branchId: string
  programId: string | null
  seasonId: string | null
  ageGroupId: string | null
  coachId: string | null
  assistantCoachId: string | null
  fieldId: string | null
  name: string
  capacity: number
  status: string
  programName?: string
  seasonName?: string
  coachName?: string | null
  branchName?: string
  ageGroupName?: string
  fieldName?: string | null
  subscriptionPrice?: number | null
}

export interface ScheduleSlotRow {
  id: string
  groupId: string
  dayOfWeek: number
  startTime: string
  endTime: string
}

export const DAY_OF_WEEK_LABELS: Record<number, string> = {
  0: 'الأحد',
  1: 'الإثنين',
  2: 'الثلاثاء',
  3: 'الأربعاء',
  4: 'الخميس',
  5: 'الجمعة',
  6: 'السبت',
}

export const GROUP_STATUS_LABELS: Record<string, string> = {
  active: 'نشطة',
  full: 'مكتملة',
  closed: 'مغلقة',
}

export interface EnrollmentRow {
  id: string
  playerId: string
  groupId: string
  status: string
  enrolledAt: string
  playerName?: string
  groupName?: string
}

export interface SubscriptionRow {
  id: string
  enrollmentId: string
  planType: string
  startDate: string
  endDate: string
  price: number
  discount: number
  status: string
  invoiceId: string | null
}

export const SUBSCRIPTION_PLAN_LABELS: Record<string, string> = {
  monthly: 'شهري',
  quarterly: 'ربع سنوي',
  season: 'موسم كامل',
  package: 'باقة',
}

export const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
  pending: 'بانتظار التفعيل',
  active: 'نشط',
  frozen: 'مجمّد',
  expired: 'منتهي',
  cancelled: 'ملغى',
}

export const ACTIVATION_POLICY_LABELS: Record<string, string> = {
  manual: 'تفعيل يدوي',
  first_payment: 'عند أول دفعة',
  full_payment: 'عند السداد الكامل',
}
