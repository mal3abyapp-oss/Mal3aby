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

  // Release-hardening regression coverage (2026-09-05): the mission's
  // independent reviewer flagged that a zero-price monthly sibling
  // would divide by zero (0/0 -> NaN, or non-zero/0 -> Infinity),
  // unreachable with real production data but a real latent defect.
  // Every case below must produce a result the UI can safely render
  // (i.e. either omitted entirely, or a finite, sane percentage) --
  // never NaN, never Infinity, never a misleading number.

  it('monthly price = 0: omits the family entirely rather than dividing by zero', () => {
    const result = computeAnnualDiscountsByFamily([
      { name: 'Broken', billing_interval: 'month', price: 0 },
      { name: 'Broken (Annual)', billing_interval: 'year', price: 18000 },
    ])
    expect(result.has('Broken')).toBe(false)
    expect(result.size).toBe(0)
  })

  it('annual price = 0: omits the family (a free "annual plan" is not a real discount to display)', () => {
    const result = computeAnnualDiscountsByFamily([
      { name: 'Broken', billing_interval: 'month', price: 1790 },
      { name: 'Broken (Annual)', billing_interval: 'year', price: 0 },
    ])
    expect(result.has('Broken')).toBe(false)
    expect(result.size).toBe(0)
  })

  it('null monthly price: omits the family rather than computing NaN', () => {
    const result = computeAnnualDiscountsByFamily([
      { name: 'Broken', billing_interval: 'month', price: null },
      { name: 'Broken (Annual)', billing_interval: 'year', price: 18000 },
    ])
    expect(result.has('Broken')).toBe(false)
  })

  it('null annual price: omits the family rather than computing NaN', () => {
    const result = computeAnnualDiscountsByFamily([
      { name: 'Broken', billing_interval: 'month', price: 1790 },
      { name: 'Broken (Annual)', billing_interval: 'year', price: null },
    ])
    expect(result.has('Broken')).toBe(false)
  })

  it('negative monthly price: omits the family (never flips a negative denominator into a nonsense percentage)', () => {
    const result = computeAnnualDiscountsByFamily([
      { name: 'Broken', billing_interval: 'month', price: -100 },
      { name: 'Broken (Annual)', billing_interval: 'year', price: 18000 },
    ])
    expect(result.has('Broken')).toBe(false)
  })

  it('missing monthly pair entirely: omits the family, does not throw', () => {
    const result = computeAnnualDiscountsByFamily([{ name: 'Orphan (Annual)', billing_interval: 'year', price: 18000 }])
    expect(result.has('Orphan')).toBe(false)
    expect(result.size).toBe(0)
  })

  // Independent-review finding (2026-09-05, release-hardening pass):
  // an annual price priced HIGHER than 12x the monthly price (a
  // plausible plans-table data-entry mistake, not currently hit by
  // live prod data) produced a finite but NEGATIVE discountPct, which
  // passed the original Number.isFinite guard and would have rendered
  // as nonsense like "Save -316.7%" in success-styled green text on a
  // live pricing card -- a misleading number, not a crash, so the
  // original "never NaN/Infinity" guard alone didn't catch it.
  it('annual price higher than 12x monthly (data-entry mistake): omits the family rather than showing a negative "savings"', () => {
    const result = computeAnnualDiscountsByFamily([
      { name: 'Mistake', billing_interval: 'month', price: 100 },
      { name: 'Mistake (Annual)', billing_interval: 'year', price: 5000 }, // 12x monthly = 1200; 5000 >> 1200
    ])
    expect(result.has('Mistake')).toBe(false)
  })

  it('annual price exactly equal to 12x monthly (zero real discount): omits the family rather than showing "Save 0%"', () => {
    const result = computeAnnualDiscountsByFamily([
      { name: 'NoDiscount', billing_interval: 'month', price: 1000 },
      { name: 'NoDiscount (Annual)', billing_interval: 'year', price: 12000 },
    ])
    expect(result.has('NoDiscount')).toBe(false)
  })

  // Independent-review finding, second pass: a raw discount so small it
  // rounds DOWN to displayed "0" (e.g. raw 0.02%) is the same
  // misleading-display problem as an exact 12x match, just reached via
  // hyper-precise pricing rather than an exact ratio -- unreachable
  // with any real product price today, but the guard must check the
  // ROUNDED value actually shown, not just the raw pre-rounding sign.
  it('a raw positive discount that rounds down to displayed "0": omits the family, never shows "Save 0%"', () => {
    // monthly=1,000,000 * 12 = 12,000,000 annual-equivalent; annual=11,999,997.6
    // -> raw discount ~0.00002%, rounds to 0.0 via Math.round(x*10)/10
    const result = computeAnnualDiscountsByFamily([
      { name: 'RoundsToZero', billing_interval: 'month', price: 1_000_000 },
      { name: 'RoundsToZero (Annual)', billing_interval: 'year', price: 11_999_997.6 },
    ])
    expect(result.has('RoundsToZero')).toBe(false)
  })

  it('never returns NaN or Infinity for ANY input in the full edge-case matrix', () => {
    const edgeCases = [
      [{ name: 'A', billing_interval: 'month', price: 0 }, { name: 'A (Annual)', billing_interval: 'year', price: 100 }],
      [{ name: 'B', billing_interval: 'month', price: 100 }, { name: 'B (Annual)', billing_interval: 'year', price: 0 }],
      [{ name: 'C', billing_interval: 'month', price: null }, { name: 'C (Annual)', billing_interval: 'year', price: 100 }],
      [{ name: 'D', billing_interval: 'month', price: 100 }, { name: 'D (Annual)', billing_interval: 'year', price: null }],
      [{ name: 'E', billing_interval: 'month', price: -50 }, { name: 'E (Annual)', billing_interval: 'year', price: 100 }],
      [{ name: 'F (Annual)', billing_interval: 'year', price: 100 }],
      [{ name: 'G', billing_interval: 'month', price: 100 }, { name: 'G (Annual)', billing_interval: 'year', price: 5000 }], // negative discount
      [{ name: 'H', billing_interval: 'month', price: 1000 }, { name: 'H (Annual)', billing_interval: 'year', price: 12000 }], // exactly 0% discount
    ]
    for (const rows of edgeCases) {
      const result = computeAnnualDiscountsByFamily(rows)
      for (const pct of result.values()) {
        expect(Number.isFinite(pct)).toBe(true)
        expect(Number.isNaN(pct)).toBe(false)
        // Not just finite -- also never a nonsensical <=0 "savings" percentage.
        expect(pct).toBeGreaterThan(0)
      }
    }
  })

  it('valid approved Starter/Growth/Pro values all still resolve to finite, correct, non-25% percentages (final sanity check)', () => {
    const result = computeAnnualDiscountsByFamily(NAMED_PLAN_ROWS)
    expect(result.size).toBe(3)
    for (const [family, pct] of result.entries()) {
      expect(Number.isFinite(pct)).toBe(true)
      expect(pct).toBeGreaterThan(0)
      expect(pct).toBeLessThan(100)
      expect(pct).not.toBe(25)
      expect(['Starter', 'Growth', 'Pro']).toContain(family)
    }
  })
})
