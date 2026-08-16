import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import arCommon from './resources/ar/common.json'
import enCommon from './resources/en/common.json'

// Gate 10 — i18n foundation. Doc 3 requires: translation resources,
// a language switcher, persistence, fallback, interpolation,
// pluralization, RTL/LTR switching WITHOUT a page reload, and
// locale-aware numbers/dates/times/currency. Explicitly forbidden:
// duplicate per-language pages/components for the same screen — every
// screen stays one component, driven by these resource files via the
// `useTranslation()` hook, never a parallel ArabicPage/EnglishPage
// split.
//
// Namespace strategy: a single "common" namespace holds shared
// chrome (nav, buttons, auth) to start. As Gate 10's sweep continues
// into individual feature areas, each feature adds its OWN namespace
// (e.g. "bookings", "academy") rather than growing "common" without
// bound — this keeps translation files reviewable and lets a
// screen only load the namespaces it actually needs.
export const SUPPORTED_LOCALES = ['ar', 'en'] as const
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number]

export const LOCALE_STORAGE_KEY = 'mala3by.locale'

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      ar: { common: arCommon },
      en: { common: enCommon },
    },
    // Arabic is this product's baseline (RTL-first, per
    // DirectionProvider's own established convention) — English is the
    // opt-in toggle, never the default a new/undetected user lands on.
    fallbackLng: 'ar',
    defaultNS: 'common',
    ns: ['common'],
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LOCALE_STORAGE_KEY,
      caches: ['localStorage'],
    },
    interpolation: {
      // React already escapes output -- i18next's own escaping would
      // double-escape Arabic/English text unnecessarily.
      escapeValue: false,
    },
    returnEmptyString: false,
  })

export default i18n

/** Locale-aware number formatting -- never hand-formatted digits (which silently produce Western numerals in an Arabic context or vice versa depending on the source string). */
export function formatNumber(value: number, locale: SupportedLocale): string {
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US').format(value)
}

/** Locale-aware currency formatting. Currency code stays EGP regardless of display locale (the club's own configured currency, not the UI language) -- only the numeral script/grouping changes. */
export function formatCurrency(value: number, locale: SupportedLocale, currencyCode = 'EGP'): string {
  return new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {
    style: 'currency',
    currency: currencyCode,
    maximumFractionDigits: 0,
  }).format(value)
}

/** Locale-aware date formatting. Always takes an explicit IANA timezone (per Gate 1's Time Model — never format a raw instant without one) so a date reads correctly for the venue, not the viewer's own browser zone. */
export function formatDate(instant: string | Date, locale: SupportedLocale, timeZone: string, options?: Intl.DateTimeFormatOptions): string {
  const d = typeof instant === 'string' ? new Date(instant) : instant
  return new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-US', { timeZone, ...options }).format(d)
}
