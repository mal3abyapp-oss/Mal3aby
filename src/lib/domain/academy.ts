// Shared domain types for Phase 10 — Academy Structure.

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

export interface GroupRow {
  id: string
  branchId: string
  programId: string
  seasonId: string
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
