import { describe, expect, it } from 'vitest'
import { addHoursToTime, escalatedAmount, fullYearsBetween, previewRentalSchedule, rentalPeriodStart } from './rental'

describe('rentalPeriodStart', () => {
  it('computes each cycle type from the contract start', () => {
    expect(rentalPeriodStart('2026-01-15', { cycle: 'daily' }, 3)).toBe('2026-01-18')
    expect(rentalPeriodStart('2026-01-15', { cycle: 'monthly' }, 2)).toBe('2026-03-15')
    expect(rentalPeriodStart('2026-01-15', { cycle: 'quarterly' }, 1)).toBe('2026-04-15')
    expect(rentalPeriodStart('2026-01-15', { cycle: 'semi_annual' }, 1)).toBe('2026-07-15')
    expect(rentalPeriodStart('2026-01-15', { cycle: 'annual' }, 2)).toBe('2028-01-15')
    expect(rentalPeriodStart('2026-01-15', { cycle: 'custom', customValue: 2, customUnit: 'week' }, 1)).toBe('2026-01-29')
    expect(rentalPeriodStart('2026-01-15', { cycle: 'custom', customValue: 10, customUnit: 'day' }, 2)).toBe('2026-02-04')
    expect(rentalPeriodStart('2026-01-15', { cycle: 'custom', customValue: 2, customUnit: 'month' }, 3)).toBe('2026-07-15')
  })

  it('clamps month ends like Postgres instead of drifting', () => {
    expect(rentalPeriodStart('2026-01-31', { cycle: 'monthly' }, 1)).toBe('2026-02-28')
    expect(rentalPeriodStart('2026-01-31', { cycle: 'monthly' }, 2)).toBe('2026-03-31')
    expect(rentalPeriodStart('2024-02-29', { cycle: 'annual' }, 1)).toBe('2025-02-28')
  })

  it('rejects an incomplete custom cycle', () => {
    expect(rentalPeriodStart('2026-01-15', { cycle: 'custom' }, 1)).toBeNull()
  })
})

describe('previewRentalSchedule', () => {
  it('builds contiguous inclusive periods and the contract end date', () => {
    const p = previewRentalSchedule('2026-07-29', { cycle: 'monthly' }, 12, 15000)
    expect(p.rows).toHaveLength(12)
    expect(p.rows[0]).toEqual({ sequence: 1, periodStart: '2026-07-29', periodEnd: '2026-08-28', amount: 15000 })
    expect(p.rows[1]?.periodStart).toBe('2026-08-29')
    expect(p.endDate).toBe('2027-07-28')
    expect(p.totalRent).toBe(180000)
  })

  it('handles a single-day hall booking', () => {
    const p = previewRentalSchedule('2026-10-10', { cycle: 'daily' }, 1, 20000)
    expect(p.endDate).toBe('2026-10-10')
    expect(p.totalRent).toBe(20000)
  })

  it('returns an empty preview for invalid input', () => {
    expect(previewRentalSchedule('', { cycle: 'monthly' }, 3, 100).rows).toHaveLength(0)
    expect(previewRentalSchedule('2026-01-01', { cycle: 'monthly' }, 0, 100).endDate).toBeNull()
  })
})

describe('rentals v2 helpers', () => {
  it('compounds the annual increase per full contract year like the server', () => {
    expect(fullYearsBetween('2026-10-01', '2027-09-30')).toBe(0)
    expect(fullYearsBetween('2026-10-01', '2027-10-01')).toBe(1)
    expect(escalatedAmount(10000, 10, '2026-10-01', '2027-10-01')).toBe(11000)
    expect(escalatedAmount(10000, 10, '2026-10-01', '2028-10-01')).toBe(12100)
    const p = previewRentalSchedule('2026-10-01', { cycle: 'monthly' }, 24, 10000, 10)
    expect(p.rows[11]!.amount).toBe(10000)
    expect(p.rows[12]!.amount).toBe(11000)
    expect(p.totalRent).toBe(252000)
  })

  it('previews an hourly booking as one same-day installment', () => {
    const p = previewRentalSchedule('2026-10-10', { cycle: 'hourly' }, 4, 2000)
    expect(p.endDate).toBe('2026-10-10')
    expect(p.rows).toHaveLength(1)
    expect(p.totalRent).toBe(8000)
    expect(previewRentalSchedule('2026-10-10', { cycle: 'hourly' }, 25, 2000).endDate).toBeNull()
  })

  it('adds hours to a time without passing midnight', () => {
    expect(addHoursToTime('18:00', 4)).toBe('22:00')
    expect(addHoursToTime('20:00', 4)).toBe('24:00')
    expect(addHoursToTime('21:30', 4)).toBeNull()
  })
})
