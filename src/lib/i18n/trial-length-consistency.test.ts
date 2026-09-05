import { describe, it, expect } from 'vitest'
import en from './resources/en/common.json'
import ar from './resources/ar/common.json'

// OWNER DECISION (2026-09-05): the platform's official free-trial
// length is 14 days. platform_settings.default_trial_days was
// previously 7 while a mix of copy said "7 days" and one string
// (pricing.trialFunnelHint) already correctly said "14-day" -- a real,
// live, self-contradictory product state (see FINAL_OWNER_DECISIONS_
// REQUIRED.md and MAL3ABY_DESIGN_REMEDIATION_REPORT.md for the full
// investigation). This test asserts every trial-length-bearing i18n
// string in both locales now agrees on 14, and guards against a future
// change silently reintroducing "7" in one location while missing
// another -- exactly the class of drift that happened here.

// Every key whose STRING VALUE claims a specific trial length (not
// unrelated "7 days" strings like WhatsApp-failure windows or
// membership-expiry warnings, which legitimately say 7 and must not be
// touched by this test), addressed as a dot-joined path string.
const TRIAL_LENGTH_KEY_PATHS = [
  'publicSite.home.trialBadge',
  'publicSite.home.finalCta.subtitle',
  'publicSite.pricing.trialFunnelHint',
  'publicSite.terms.section2.body',
  'onboarding.success.trialActivated',
]

function getByPath(obj: unknown, path: string): string {
  let current: unknown = obj
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null) {
      throw new Error(`i18n key path ${path} does not resolve — missing segment "${segment}"`)
    }
    current = (current as Record<string, unknown>)[segment]
  }
  if (typeof current !== 'string') {
    throw new Error(`i18n key path ${path} did not resolve to a string`)
  }
  return current
}

describe('trial-length i18n consistency (EN)', () => {
  it.each(TRIAL_LENGTH_KEY_PATHS)('%s contains "14", not "7", as the trial length', (path) => {
    const value = getByPath(en, path)
    expect(value).toMatch(/\b14\b/)
    expect(value).not.toMatch(/\b7\b(?=[\s-](?:day|days))/i)
  })
})

describe('trial-length i18n consistency (AR)', () => {
  it.each(TRIAL_LENGTH_KEY_PATHS)('%s contains "14"/"١٤", not "7"/"٧", as the trial length', (path) => {
    const value = getByPath(ar, path)
    expect(value).toMatch(/14|١٤/)
    expect(value).not.toMatch(/7 أيام|٧ أيام/)
  })
})

describe('trial-length consistency across EN/AR', () => {
  it('every trial-length key path resolves in both locales (no locale silently missing the fix)', () => {
    for (const path of TRIAL_LENGTH_KEY_PATHS) {
      expect(() => getByPath(en, path)).not.toThrow()
      expect(() => getByPath(ar, path)).not.toThrow()
    }
  })
})
