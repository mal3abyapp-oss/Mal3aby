// Canonical phone-number normalization (P0 directive: E.164 identity).
//
// This is the ONE place phone parsing logic lives on the frontend --
// every screen that accepts a phone number (public booking, staff
// customer create/edit, quick booking, academy/guardian forms, portal
// profile, club/branch/platform contact settings) must go through
// normalizePhone() rather than hand-rolling its own regex. See
// docs/DECISIONS.md ADR-012 for the historical normalize_mobile()
// gap this replaces (no country-code handling at all).
//
// Architecture (per directive section 2/11/14):
//   RAW INPUT -> country context -> normalize -> validate -> E.164
// libphonenumber-js is a real, widely-used phone parsing library --
// this module does not hand-roll international parsing logic.
//
// Postgres cannot run this library, so the database enforces only a
// lightweight FORMAT check (starts with '+', digits, sane length --
// see the phone_e164_format_check constraints in the migrations) as a
// backstop against any write path that skips this module. The actual
// parsing/validation authority is always this file.

import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js'

export interface NormalizePhoneResult {
  valid: boolean
  /** E.164 canonical form, e.g. "+201116505553". Only set when valid. */
  e164: string | null
  /** ISO 3166-1 alpha-2 country actually used to parse, e.g. "EG". */
  country: CountryCode | null
  /** National-format display value, e.g. "01116505553". Only set when valid. */
  national: string | null
  /** Machine-readable reason when invalid; null when valid. */
  reason: 'empty' | 'too_short' | 'invalid_for_country' | 'unparseable' | null
}

/**
 * Converts Eastern Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩) and Persian digits
 * (۰۱۲۳۴۵۶۷۸۹) to plain ASCII digits. Directive section 7 -- mandatory,
 * must run before any parsing.
 */
export function convertArabicDigits(input: string): string {
  const easternArabic = '٠١٢٣٤٥٦٧٨٩'
  const persian = '۰۱۲۳۴۵۶۷۸۹'
  return input.replace(/[٠-٩۰-۹]/g, (ch) => {
    const easternIdx = easternArabic.indexOf(ch)
    if (easternIdx !== -1) return String(easternIdx)
    const persianIdx = persian.indexOf(ch)
    if (persianIdx !== -1) return String(persianIdx)
    return ch
  })
}

/**
 * Normalizes a raw, user-entered phone number into canonical E.164.
 *
 * @param rawPhone   The raw input, in any of: local format ("01116505553"),
 *                   Arabic-Indic digits, spaces/hyphens/parens, "00" prefix,
 *                   or explicit "+" international format.
 * @param country    The country context to interpret a LOCAL number under
 *                   (e.g. the club's default country, or an explicit
 *                   override the user picked). Ignored if rawPhone already
 *                   contains an explicit "+" or "00" international prefix --
 *                   directive section 9: explicit international input is
 *                   never re-interpreted under a different country.
 */
export function normalizePhone(rawPhone: string | null | undefined, country: CountryCode | null | undefined): NormalizePhoneResult {
  const empty: NormalizePhoneResult = { valid: false, e164: null, country: null, national: null, reason: 'empty' }
  if (!rawPhone) return empty

  // Section 7: Arabic/Persian digit conversion happens first, always.
  let cleaned = convertArabicDigits(rawPhone).trim()
  if (!cleaned) return empty

  // Section 8: strip spaces, hyphens, parentheses -- but preserve a
  // leading '+' and all digits, which is all libphonenumber needs.
  cleaned = cleaned.replace(/[\s\-().]/g, '')
  if (!cleaned) return empty

  // Section 9: "00" international prefix -> "+" before parsing.
  if (cleaned.startsWith('00')) {
    cleaned = '+' + cleaned.slice(2)
  }

  if (cleaned.length < 5) {
    return { valid: false, e164: null, country: null, national: null, reason: 'too_short' }
  }

  const isExplicitInternational = cleaned.startsWith('+')

  try {
    // Explicit "+"/international input is parsed without a country
    // hint (directive section 9: never re-add/guess a country code
    // for input that's already international). Local input is parsed
    // under the given country context (directive section 10: proper
    // country-aware national-trunk-prefix handling, not a blind
    // "strip leading 0").
    const parsed = isExplicitInternational
      ? parsePhoneNumberFromString(cleaned)
      : parsePhoneNumberFromString(cleaned, country ?? undefined)

    if (!parsed || !parsed.isValid()) {
      return { valid: false, e164: null, country: null, national: null, reason: 'invalid_for_country' }
    }

    return {
      valid: true,
      e164: parsed.number, // already E.164, e.g. "+201116505553"
      country: parsed.country ?? null,
      national: parsed.formatNational(),
      reason: null,
    }
  } catch {
    return { valid: false, e164: null, country: null, national: null, reason: 'unparseable' }
  }
}

/** True if `value` is already a syntactically well-formed E.164 string. */
export function isE164(value: string | null | undefined): value is string {
  if (!value) return false
  return /^\+[1-9]\d{6,14}$/.test(value)
}

/**
 * Human-friendly display formatting for an already-canonical E.164
 * number. Never mutates the stored value -- display only (directive
 * section 40).
 */
export function formatPhoneForDisplay(e164: string | null | undefined): string {
  if (!e164) return ''
  const parsed = parsePhoneNumberFromString(e164)
  return parsed ? parsed.formatInternational() : e164
}
