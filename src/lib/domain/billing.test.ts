import { describe, it, expect } from 'vitest'
import { formatMoney } from './billing'

// Customer 360 directive's automated-test requirement ("customer
// financial totals") plus a real defect this session's live QA found:
// Customer360Page's Financial Account tab initially rendered a raw,
// untranslated i18n key ("customers.detail.outstanding") because the
// key had no English fallback -- caught only by opening the browser,
// not by any existing test. formatMoney itself was correct throughout
// (confirmed live: ٠٫٠٠ EGP uses the real Arabic-Indic decimal
// separator U+066B, not a display bug), but had zero test coverage of
// its own despite being the single function every money value in
// Customer 360 (and Billing, Booking, Academy) renders through.
describe('formatMoney', () => {
  it('formats a whole number with 2 decimal places in English locale', () => {
    expect(formatMoney(980, 'EGP', 'en')).toBe('⁦980.00 EGP⁩')
  })

  it('formats a whole number with 2 decimal places in Arabic locale using Arabic-Indic digits', () => {
    const result = formatMoney(980, 'EGP', 'ar')
    // U+066B is the real Arabic decimal separator, distinct from a comma
    expect(result).toContain('٫')
    expect(result).toContain('٩٨٠')
  })

  it('formats zero identically in both locales but with locale-appropriate digits', () => {
    expect(formatMoney(0, 'EGP', 'en')).toBe('⁦0.00 EGP⁩')
    expect(formatMoney(0, 'EGP', 'ar')).toContain('٠')
  })

  it('rounds to 2 decimal places rather than truncating', () => {
    expect(formatMoney(150.005, 'EGP', 'en')).toContain('150.0')
  })

  it('wraps the value in FSI/PDI bidi isolation marks so it renders correctly inside RTL surrounding text', () => {
    const result = formatMoney(250, 'EGP', 'en')
    expect(result.startsWith('⁦')).toBe(true)
    expect(result.endsWith('⁩')).toBe(true)
  })

  it('defaults to EGP currency and Arabic locale when not specified', () => {
    const result = formatMoney(100)
    expect(result).toContain('EGP')
    expect(result).toContain('١٠٠')
  })

  it('never collapses a negative outstanding/refund amount to a positive display (sign preserved)', () => {
    const result = formatMoney(-50, 'EGP', 'en')
    expect(result).toContain('-50.00')
  })
})
