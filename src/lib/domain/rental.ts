// RENTALS MODULE (2026-10-07) -- pure client-side helpers. The server
// (create_rental_contract / _rental_period_start in
// 20261007100000_rentals_module.sql) is authoritative; these only drive
// the live preview in the New Contract dialog and labels/tones.

export const RENTAL_SPACE_TYPES = [
  'gym', 'wedding_hall', 'event_hall', 'shop', 'office', 'warehouse',
  'apartment', 'sports_facility', 'other', 'custom',
] as const
export type RentalSpaceType = (typeof RENTAL_SPACE_TYPES)[number]

export const RENT_CYCLES = ['daily', 'monthly', 'quarterly', 'semi_annual', 'annual', 'custom'] as const
export type RentCycle = (typeof RENT_CYCLES)[number]

export const CUSTOM_CYCLE_UNITS = ['day', 'week', 'month'] as const
export type CustomCycleUnit = (typeof CUSTOM_CYCLE_UNITS)[number]

export type RentalPaymentState =
  | 'scheduled' | 'due_not_invoiced' | 'unpaid' | 'partial' | 'paid' | 'overdue' | 'cancelled'

export const RENTAL_PAYMENT_STATE_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  scheduled: 'neutral',
  due_not_invoiced: 'warning',
  unpaid: 'info',
  partial: 'warning',
  paid: 'success',
  overdue: 'danger',
  cancelled: 'neutral',
}

export const RENTAL_CONTRACT_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'info' | 'neutral'> = {
  active: 'success',
  upcoming: 'info',
  expired: 'neutral',
  terminated: 'warning',
  cancelled: 'danger',
}

export interface RentCycleSpec {
  cycle: RentCycle
  customValue?: number | null
  customUnit?: CustomCycleUnit | null
}

function addUtcMonths(d: Date, months: number): Date {
  // Postgres `date + interval 'N months'` clamps to the last day of the
  // target month (Jan 31 + 1 month = Feb 28); JS setUTCMonth overflows
  // into the next month instead, so clamp explicitly to match.
  const day = d.getUTCDate()
  const result = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1))
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate()
  result.setUTCDate(Math.min(day, lastDay))
  return result
}

function addUtcDays(d: Date, days: number): Date {
  const result = new Date(d.getTime())
  result.setUTCDate(result.getUTCDate() + days)
  return result
}

/** Start date (YYYY-MM-DD) of period `index` (0-based); always computed from the contract start so month ends never drift. */
export function rentalPeriodStart(startDate: string, spec: RentCycleSpec, index: number): string | null {
  const start = new Date(`${startDate}T00:00:00Z`)
  if (Number.isNaN(start.getTime())) return null
  let d: Date
  switch (spec.cycle) {
    case 'daily': d = addUtcDays(start, index); break
    case 'monthly': d = addUtcMonths(start, index); break
    case 'quarterly': d = addUtcMonths(start, 3 * index); break
    case 'semi_annual': d = addUtcMonths(start, 6 * index); break
    case 'annual': d = addUtcMonths(start, 12 * index); break
    case 'custom': {
      const n = spec.customValue ?? 0
      if (!n || n < 1 || !spec.customUnit) return null
      if (spec.customUnit === 'day') d = addUtcDays(start, n * index)
      else if (spec.customUnit === 'week') d = addUtcDays(start, 7 * n * index)
      else d = addUtcMonths(start, n * index)
      break
    }
    default: return null
  }
  return d.toISOString().slice(0, 10)
}

export interface RentalSchedulePreviewRow {
  sequence: number
  periodStart: string
  periodEnd: string
  amount: number
}

/** Full installment schedule preview, plus the inclusive contract end date. */
export function previewRentalSchedule(
  startDate: string,
  spec: RentCycleSpec,
  cyclesCount: number,
  cycleAmount: number,
): { endDate: string | null; rows: RentalSchedulePreviewRow[]; totalRent: number } {
  const count = Math.floor(cyclesCount)
  if (!startDate || !count || count < 1) return { endDate: null, rows: [], totalRent: 0 }
  const rows: RentalSchedulePreviewRow[] = []
  for (let i = 0; i < count; i++) {
    const ps = rentalPeriodStart(startDate, spec, i)
    const next = rentalPeriodStart(startDate, spec, i + 1)
    if (!ps || !next) return { endDate: null, rows: [], totalRent: 0 }
    const pe = addUtcDays(new Date(`${next}T00:00:00Z`), -1).toISOString().slice(0, 10)
    rows.push({ sequence: i + 1, periodStart: ps, periodEnd: pe, amount: cycleAmount })
  }
  const amount = Number.isFinite(cycleAmount) ? cycleAmount : 0
  return {
    endDate: rows[rows.length - 1]?.periodEnd ?? null,
    rows,
    totalRent: Math.round(amount * 100) * count / 100,
  }
}

/** Display label for a space type: the custom name when the type is 'custom'. */
export function rentalSpaceTypeLabel(
  t: (key: string) => string,
  spaceType: string,
  customLabel?: string | null,
): string {
  if (spaceType === 'custom' && customLabel) return customLabel
  return t(`rentals.spaceTypes.${spaceType}`)
}

/** Human cycle label, e.g. "Monthly" or "Every 2 weeks". */
export function rentCycleLabel(
  t: (key: string, opts?: Record<string, unknown>) => string,
  cycle: string,
  customValue?: number | null,
  customUnit?: string | null,
): string {
  if (cycle === 'custom' && customValue && customUnit) {
    return t('rentals.cycles.customEvery', { count: customValue, unit: t(`rentals.customUnits.${customUnit}`) })
  }
  return t(`rentals.cycles.${cycle}`)
}
