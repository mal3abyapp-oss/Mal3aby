import { describe, it, expect } from 'vitest'
import { filterPublicCommercialPlans, NEW_COMMERCIAL_TIER_MIN_DISPLAY_ORDER } from './billing'

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
