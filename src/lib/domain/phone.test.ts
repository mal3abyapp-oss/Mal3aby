import { describe, it, expect } from 'vitest'
import { normalizePhone, convertArabicDigits, isE164, formatPhoneForDisplay } from './phone'

// Dedicated automated tests for phone normalization (directive's
// explicit test requirement) -- the single highest-leverage pure
// function in the codebase given the P0 phone-identity directive: this
// session's WhatsApp closure work depended entirely on it. The exact
// authorized test scenario ("Country AE, input 0502061209 -> expected
// +971502061209") is included verbatim as its own test case.
describe('convertArabicDigits', () => {
  it('converts Eastern Arabic-Indic digits to ASCII', () => {
    expect(convertArabicDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789')
  })

  it('converts Persian digits to ASCII', () => {
    expect(convertArabicDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789')
  })

  it('leaves ASCII digits and other characters untouched', () => {
    expect(convertArabicDigits('+201116505553')).toBe('+201116505553')
  })

  it('handles a mixed Arabic-Indic + ASCII string (real staff-entry case)', () => {
    expect(convertArabicDigits('٠١١٢-345-6789')).toBe('0112-345-6789')
  })
})

describe('normalizePhone', () => {
  it('the directive-authorized live test scenario: country AE, local input 0502061209 -> +971502061209', () => {
    const result = normalizePhone('0502061209', 'AE')
    expect(result.valid).toBe(true)
    expect(result.e164).toBe('+971502061209')
    expect(result.country).toBe('AE')
  })

  it('normalizes a local Egyptian number under country EG', () => {
    const result = normalizePhone('01116505553', 'EG')
    expect(result.valid).toBe(true)
    expect(result.e164).toBe('+201116505553')
  })

  it('normalizes Arabic-Indic digit input identically to ASCII input', () => {
    const ascii = normalizePhone('01116505553', 'EG')
    const arabic = normalizePhone('٠١١١٦٥٠٥٥٥٣', 'EG')
    expect(arabic.valid).toBe(true)
    expect(arabic.e164).toBe(ascii.e164)
  })

  it('never re-interprets an explicit international "+" number under a different country context', () => {
    // A UAE number entered with its own + prefix must stay a UAE
    // number even when the club's default country is Egypt -- directive
    // section 9's explicit rule.
    const result = normalizePhone('+971502061209', 'EG')
    expect(result.valid).toBe(true)
    expect(result.e164).toBe('+971502061209')
    expect(result.country).toBe('AE')
  })

  it('converts a "00" international prefix to "+" before parsing', () => {
    const result = normalizePhone('00971502061209', 'EG')
    expect(result.valid).toBe(true)
    expect(result.e164).toBe('+971502061209')
  })

  it('strips spaces, hyphens, and parentheses from input', () => {
    const result = normalizePhone('(011) 165-05553', 'EG')
    expect(result.valid).toBe(true)
    expect(result.e164).toBe('+201116505553')
  })

  it('returns reason "empty" for null/undefined/blank input', () => {
    expect(normalizePhone(null, 'EG').reason).toBe('empty')
    expect(normalizePhone(undefined, 'EG').reason).toBe('empty')
    expect(normalizePhone('   ', 'EG').reason).toBe('empty')
  })

  it('returns reason "too_short" for input under 5 characters', () => {
    const result = normalizePhone('123', 'EG')
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('too_short')
  })

  it('returns reason "invalid_for_country" for a syntactically plausible but invalid number', () => {
    const result = normalizePhone('0000000000', 'EG')
    expect(result.valid).toBe(false)
    expect(result.reason).toBe('invalid_for_country')
  })

  it('never returns a fabricated e164/national value when invalid', () => {
    const result = normalizePhone('123', 'EG')
    expect(result.e164).toBeNull()
    expect(result.national).toBeNull()
  })
})

describe('isE164', () => {
  it('accepts a well-formed E.164 string', () => {
    expect(isE164('+201116505553')).toBe(true)
    expect(isE164('+971502061209')).toBe(true)
  })

  it('rejects a local/national-format number', () => {
    expect(isE164('01116505553')).toBe(false)
  })

  it('rejects null/undefined/empty', () => {
    expect(isE164(null)).toBe(false)
    expect(isE164(undefined)).toBe(false)
    expect(isE164('')).toBe(false)
  })

  it('rejects a "+" with a leading zero (invalid E.164 shape)', () => {
    expect(isE164('+0116505553')).toBe(false)
  })
})

describe('formatPhoneForDisplay', () => {
  it('formats a canonical E.164 number for human display', () => {
    const result = formatPhoneForDisplay('+201116505553')
    expect(result).not.toBe('')
    expect(result).not.toBe('+201116505553') // should be the formatted international form, not the raw E.164
  })

  it('returns an empty string for null/undefined', () => {
    expect(formatPhoneForDisplay(null)).toBe('')
    expect(formatPhoneForDisplay(undefined)).toBe('')
  })
})
