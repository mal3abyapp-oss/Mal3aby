import { describe, it, expect } from 'vitest'
import { classifyOutstandingInvoices } from './finance'

// Finance IA consolidation directive section 52/68: dedicated coverage
// for the partial-payment classification the new Finance Overview
// cards rely on (Unpaid vs. Partially Paid invoice counts).
describe('classifyOutstandingInvoices', () => {
  it('counts a fully unpaid invoice (outstanding === total) as unpaid, not partial', () => {
    const result = classifyOutstandingInvoices([{ total: 300, outstanding: 300 }])
    expect(result).toEqual({ unpaidCount: 1, partialCount: 0 })
  })

  it('counts a partially paid invoice (0 < outstanding < total) as partial', () => {
    // directive section 52: pay 100 of 300 -> paid=100, outstanding=200, status=Partially Paid
    const result = classifyOutstandingInvoices([{ total: 300, outstanding: 200 }])
    expect(result).toEqual({ unpaidCount: 0, partialCount: 1 })
  })

  it('excludes a fully settled invoice (outstanding === 0) from both counts', () => {
    const result = classifyOutstandingInvoices([{ total: 300, outstanding: 0 }])
    expect(result).toEqual({ unpaidCount: 0, partialCount: 0 })
  })

  it('excludes a negative outstanding (over-refunded) invoice from both counts', () => {
    const result = classifyOutstandingInvoices([{ total: 300, outstanding: -50 }])
    expect(result).toEqual({ unpaidCount: 0, partialCount: 0 })
  })

  it('classifies a mixed batch correctly', () => {
    const result = classifyOutstandingInvoices([
      { total: 150, outstanding: 150 }, // unpaid
      { total: 300, outstanding: 100 }, // partial
      { total: 150, outstanding: 0 }, // settled, excluded
      { total: 200, outstanding: 200 }, // unpaid
      { total: 250, outstanding: 50 }, // partial
    ])
    expect(result).toEqual({ unpaidCount: 2, partialCount: 2 })
  })

  it('returns zero counts for an empty list', () => {
    expect(classifyOutstandingInvoices([])).toEqual({ unpaidCount: 0, partialCount: 0 })
  })

  it('treats an invoice where outstanding narrowly exceeds total as unpaid, not partial (defensive rounding case)', () => {
    const result = classifyOutstandingInvoices([{ total: 99.99, outstanding: 100 }])
    expect(result).toEqual({ unpaidCount: 1, partialCount: 0 })
  })
})
