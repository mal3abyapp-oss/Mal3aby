import { describe, it, expect } from 'vitest'
import { filterPublicCommercialPlans, NEW_COMMERCIAL_TIER_MIN_DISPLAY_ORDER, computeAnnualDiscountsByFamily } from './billing'

// Regression coverage for the 2026-09-05 P0 fix: SubscriptionPage.tsx
// and HomePage.tsx were live-leaking the 2 surviving legacy plans
// (Monthly 499 EGP, Annual 4,499 EGP) to new/existing customers on
// authenticated and public commercial surfaces because they queried
// public_plans with no display_order filter, unlike PricingPage.tsx.
// This asserts the shared filter (now used by all three surfaces)
// keeps legacy plans out and lets every real commercial tier through,
// so this class of bug can't silently reappear on a future 4th surface.

const LEGACY_MONTHLY = { id: 'legacy-monthly', price: 499, display_order: 1 }
const LEGACY_ANNUAL = { id: 'legacy-annual', price: 4499, display_order: 4 }
const STARTER_MONTHLY = { id: 'starter-monthly', price: 1790, display_order: 10 }
const STARTER_ANNUAL = { id: 'starter-annual', price: 18000, display_order: 11 }
const GROWTH_MONTHLY = { id: 'growth-monthly', price: 2990, display_order: 20 }
const GROWTH_ANNUAL = { id: 'growth-annual', price: 30000, display_order: 21 }
const PRO_MONTHLY = { id: 'pro-monthly', price: 4990, display_order: 30 }
const PRO_ANNUAL = { id: 'pro-annual', price: 50000, display_order: 31 }

const ALL_PLAN_ROWS = [
  LEGACY_MONTHLY,
  LEGACY_ANNUAL,
  STARTER_MONTHLY,
  STARTER_ANNUAL,
  GROWTH_MONTHLY,
  GROWTH_ANNUAL,
  PRO_MONTHLY,
  PRO_ANNUAL,
]

describe('filterPublicCommercialPlans', () => {
  it('excludes the legacy 499 EGP monthly plan', () => {
    const result = filterPublicCommercialPlans(ALL_PLAN_ROWS)
    expect(result.find((p) => p.price === 499)).toBeUndefined()
  })

  it('excludes the legacy 4,499 EGP annual plan', () => {
    const result = filterPublicCommercialPlans(ALL_PLAN_ROWS)
    expect(result.find((p) => p.price === 4499)).toBeUndefined()
  })

  it('resolves all 6 real commercial tier prices correctly', () => {
    const result = filterPublicCommercialPlans(ALL_PLAN_ROWS)
    const prices = result.map((p) => p.price).sort((a, b) => a - b)
    expect(prices).toEqual([1790, 2990, 4990, 18000, 30000, 50000])
  })

  it('keeps every real tier: Starter/Growth/Pro monthly + annual', () => {
    const result = filterPublicCommercialPlans(ALL_PLAN_ROWS)
    expect(result).toHaveLength(6)
    expect(result).toEqual(
      expect.arrayContaining([STARTER_MONTHLY, STARTER_ANNUAL, GROWTH_MONTHLY, GROWTH_ANNUAL, PRO_MONTHLY, PRO_ANNUAL]),
    )
  })

  it('treats a null display_order as legacy (excluded), not as a new tier', () => {
    const result = filterPublicCommercialPlans([{ id: 'unknown', price: 1, display_order: null }])
    expect(result).toHaveLength(0)
  })

  it('the shared threshold constant is 10, matching the documented legacy/current boundary', () => {
    expect(NEW_COMMERCIAL_TIER_MIN_DISPLAY_ORDER).toBe(10)
  })
})

// Regression coverage for the 2026-09-05 P0 fix: HomePage.tsx's
// landing-page pricing preview showed a hardcoded "Save 25%" English
// discount label (stale, from an earlier pricing model) instead of the
// real ~16.2-16.5% annual discount on the approved Starter/Growth/Pro
// prices. This asserts the real percentages are computed correctly and
// match what a customer should actually see, rounded to 1 decimal.
describe('computeAnnualDiscountsByFamily', () => {
  const NAMED_PLAN_ROWS = [
    { name: 'Starter', billing_interval: 'month', price: 1790 },
    { name: 'Starter (Annual)', billing_interval: 'year', price: 18000 },
    { name: 'Growth', billing_interval: 'month', price: 2990 },
    { name: 'Growth (Annual)', billing_interval: 'year', price: 30000 },
    { name: 'Pro', billing_interval: 'month', price: 4990 },
    { name: 'Pro (Annual)', billing_interval: 'year', price: 50000 },
  ]

  it('computes the correct Starter annual discount (~16.2%), not the stale "25%"', () => {
    const result = computeAnnualDiscountsByFamily(NAMED_PLAN_ROWS)
    expect(result.get('Starter')).toBeCloseTo(16.2, 1)
  })

  it('computes the correct Growth annual discount (~16.4%), not the stale "25%"', () => {
    const result = computeAnnualDiscountsByFamily(NAMED_PLAN_ROWS)
    expect(result.get('Growth')).toBeCloseTo(16.4, 1)
  })

  it('computes the correct Pro annual discount (~16.5%), not the stale "25%"', () => {
    const result = computeAnnualDiscountsByFamily(NAMED_PLAN_ROWS)
    expect(result.get('Pro')).toBeCloseTo(16.5, 1)
  })

  it('never returns 25 (the old hardcoded, now-wrong value) for any real tier', () => {
    const result = computeAnnualDiscountsByFamily(NAMED_PLAN_ROWS)
    for (const pct of result.values()) {
      expect(pct).not.toBe(25)
    }
  })

  it('skips a monthly-only plan family with no annual sibling (e.g. Enterprise has no DB row at all)', () => {
    const result = computeAnnualDiscountsByFamily([{ name: 'Starter', billing_interval: 'month', price: 1790 }])
    expect(result.size).toBe(0)
  })

  it('skips a row with a null name rather than throwing', () => {
    const result = computeAnnualDiscountsByFamily([{ name: null, billing_interval: 'year', price: 18000 }])
    expect(result.size).toBe(0)
  })
})
