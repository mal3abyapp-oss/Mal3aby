// Shared domain types for Phase 5 — Fields, Operating Hours, Pricing.

export interface FieldRow {
  id: string
  name: string
  sport: string
  branchId: string
  status: string
}

export interface PricingRuleRow {
  id: string
  fieldId: string | null
  dayOfWeek: number | null
  dateSpecific: string | null
  startTime: string
  endTime: string
  pricePerHour: number
  priority: number
}

export const DAY_NAMES_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت']
