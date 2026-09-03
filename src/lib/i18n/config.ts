import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

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

// PERF-03 (bundle-size audit): the two "common" resource JSON files
// together were ~127KB gzip -- over a third of the whole main chunk --
// and BOTH were previously imported at module scope, so every visitor
// downloaded both languages' full translation catalog on first load
// regardless of which one they'd ever see. Fixed by loading only the
// resolved initial locale's JSON as a dynamic import() (Vite code-splits
// each into its own small chunk instead of inlining it into main), and
// loading the other locale's JSON lazily, on demand, the first time the
// UI actually switches to it -- see ensureLocaleLoaded() below, which is
// the single choke point every language switch (including this file's
// own wrapped changeLanguage()) routes through, so no call site can ever
// end up switching to a language whose strings haven't landed yet.
const resourceLoaders: Record<SupportedLocale, () => Promise<{ default: Record<string, unknown> }>> = {
  ar: () => import('./resources/ar/common.json'),
  en: () => import('./resources/en/common.json'),
}

const loadedLocales = new Set<SupportedLocale>()
const inFlightLoads = new Map<SupportedLocale, Promise<void>>()

/**
 * Low-level loader: fetches one locale's JSON and registers it with
 * i18next via addResourceBundle(). Requires i18next to already be past
 * .init() (addResourceBundle only exists after that runs) -- callers
 * outside this file should use ensureLocaleLoaded() below instead, which
 * guarantees that first. initI18n() itself calls this directly (never
 * ensureLocaleLoaded()) for its own fallback-bundle load specifically to
 * avoid re-entering initI18n() from inside its own in-flight promise.
 */
function loadLocaleBundle(locale: SupportedLocale): Promise<void> {
  if (loadedLocales.has(locale)) return Promise.resolve()

  const existing = inFlightLoads.get(locale)
  if (existing) return existing

  const promise = resourceLoaders[locale]()
    .then((mod) => {
      i18n.addResourceBundle(locale, 'common', mod.default, true, true)
      loadedLocales.add(locale)
    })
    .finally(() => {
      inFlightLoads.delete(locale)
    })
  inFlightLoads.set(locale, promise)
  return promise
}

/**
 * Ensures a locale's "common" resource bundle is registered with i18next
 * before anything tries to read from it. Safe to call repeatedly --
 * already-loaded (or currently loading) locales resolve immediately/once
 * without re-fetching or re-registering.
 *
 * Self-healing: i18n.addResourceBundle only exists once i18next has
 * actually run .init() (it's registered as part of that setup, not
 * present on a bare pre-init instance). A caller that imports the
 * default i18n export and calls changeLanguage()/ensureLocaleLoaded()
 * directly -- without ever awaiting initI18n() itself first -- would
 * otherwise hit "addResourceBundle is not a function". initI18n() is
 * memoized, so awaiting it here is a no-op once something else already
 * initialized it (the overwhelmingly common case in production, where
 * main.tsx always does so first).
 */
export function ensureLocaleLoaded(locale: SupportedLocale): Promise<void> {
  if (loadedLocales.has(locale)) return Promise.resolve()
  if (initPromise) return loadLocaleBundle(locale)
  return initI18n().then(() => loadLocaleBundle(locale))
}

/**
 * Reproduces i18next-browser-languagedetector's own 'localStorage' then
 * 'navigator' lookups (this file's actual `detection.order`), computed
 * synchronously so the initial dynamic import() can target the ONE
 * locale actually needed instead of always guessing 'ar'.
 *
 * Why not just default to 'ar' outright (matching DirectionProvider's
 * own simpler readInitialLocale())? Because DirectionProvider is only
 * mounted for the real app tree (see src/App.tsx) -- its effect calls
 * i18n.changeLanguage() on mount and DOES always win there regardless of
 * what gets detected here. But several existing tests (LoginPage.test.tsx,
 * PortalLoginPage.test.tsx -- see their own comments) render a page
 * directly WITHOUT DirectionProvider in the tree, and have always relied
 * on this exact navigator-based detection resolving to English in the
 * jsdom test environment. Matching the previous detector's real behavior
 * here keeps that pre-existing, documented test behavior intact; a real
 * browser's DirectionProvider mount corrects any mismatch immediately
 * after, exactly as it did before this file lazy-loaded resources.
 */
function detectInitialLocale(): SupportedLocale {
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
    if (stored === 'ar' || stored === 'en') return stored
  }
  if (typeof navigator !== 'undefined') {
    const navLangs = [...(navigator.languages ?? []), (navigator as unknown as { userLanguage?: string }).userLanguage, navigator.language].filter(
      (v): v is string => Boolean(v),
    )
    const firstEn = navLangs.find((v) => v.toLowerCase().startsWith('en'))
    if (firstEn) return 'en'
    if (navLangs.length > 0) return 'ar'
  }
  // Arabic is this product's baseline (RTL-first, per DirectionProvider's
  // own established convention) — English is the opt-in toggle, never
  // the default a new/undetected user lands on.
  return 'ar'
}

let initPromise: Promise<typeof i18n> | null = null
let initDone = false

/**
 * Synchronous readiness check -- lets a caller (DirectionProvider's own
 * effect) skip an extra .then() microtask hop when init has already
 * completed, instead of always going through initI18n().then(...). That
 * hop is invisible in production but matters for tests that render
 * synchronously and assert immediately after (no waitFor): React
 * Testing Library's render()/act() flush does not wait out an arbitrary
 * number of chained microtasks, only however many a plain, un-wrapped
 * i18n.changeLanguage() call itself needs -- exactly what this restores
 * once resources are already loaded.
 */
export function isI18nReady(): boolean {
  return initDone
}

/**
 * Resolves the initial locale, loads ONLY that locale's resource bundle,
 * then initializes i18next with just that one bundle in `resources`.
 * Call this once, before the app renders (see src/main.tsx) -- render
 * stays fully synchronous from React's perspective (no Suspense needed)
 * because we await this promise first rather than letting i18next
 * resolve resources after init.
 */
export function initI18n(): Promise<typeof i18n> {
  if (initPromise) return initPromise

  const initialLocale = detectInitialLocale()

  initPromise = (async () => {
    const initialResource = await resourceLoaders[initialLocale]()
    loadedLocales.add(initialLocale)

    await i18n
      .use(LanguageDetector)
      .use(initReactI18next)
      .init({
        resources: {
          [initialLocale]: { common: initialResource.default },
        },
        lng: initialLocale,
        // Arabic is this product's baseline (RTL-first, per
        // DirectionProvider's own established convention) — English is
        // the opt-in toggle, never the default a new/undetected user
        // lands on.
        fallbackLng: 'ar',
        defaultNS: 'common',
        ns: ['common'],
        detection: {
          order: ['localStorage', 'navigator'],
          lookupLocalStorage: LOCALE_STORAGE_KEY,
          // Deliberately NOT ['localStorage'] here (unlike the original
          // pre-lazy-load config, which did cache here too -- harmlessly
          // on baseline only because the RAW navigator value it cached,
          // e.g. 'en-US', never exactly matched DirectionProvider's own
          // readInitialLocale() strict `=== 'en'` check). This call
          // passes an explicit, already-NORMALIZED `lng` (see
          // detectInitialLocale() above) -- letting the detector cache
          // THAT would write a clean 'en'/'ar' that DOES match, silently
          // overriding whatever the user actually chose via a real
          // setLocale() call with whatever this auto-detection guessed
          // for bundle-loading purposes. DirectionProvider.setLocale()
          // remains the app's single, deliberate writer of
          // LOCALE_STORAGE_KEY (per its own header comment) -- this
          // detector instance only ever READS it (detection.order still
          // checks localStorage first, so an explicit prior user choice
          // is still respected for which bundle loads initially).
          caches: [],
        },
        interpolation: {
          // React already escapes output -- i18next's own escaping would
          // double-escape Arabic/English text unnecessarily.
          escapeValue: false,
        },
        returnEmptyString: false,
      })

    // fallbackLng is 'ar': if the initial locale ever ends up being
    // something else and 'ar' isn't loaded yet, make sure the fallback
    // bundle itself is never missing (keeps "fallback behavior stays as
    // safe as before" true even under lazy loading). Uses
    // loadLocaleBundle() directly, NOT ensureLocaleLoaded() -- that
    // public wrapper would re-enter initI18n() here (initPromise is
    // already set at this point, but initDone isn't yet), and by the
    // time it noticed that and awaited initPromise instead, it would be
    // awaiting this very in-flight async body from inside itself: a
    // deadlock. addResourceBundle is already safe to call directly here
    // regardless -- the .init() call right above this already completed.
    if (initialLocale !== 'ar') {
      await loadLocaleBundle('ar')
    }

    initDone = true
    return i18n
  })()

  return initPromise
}

// Single choke point for changing i18next's active language: guarantees
// the target locale's resource bundle is loaded BEFORE i18next actually
// switches, so there is never a flash of missing-key fallback text after
// a switch. DirectionProvider (the app's only call site for driving
// language changes) and any test calling i18n.changeLanguage() directly
// both go through this wrapper, since it replaces the instance method
// rather than requiring every caller to remember a separate helper.
const originalChangeLanguage = i18n.changeLanguage.bind(i18n)
i18n.changeLanguage = ((lng?: string, callback?: (error: unknown, t: unknown) => void) => {
  const locale = lng as SupportedLocale | undefined
  // Already-loaded locale (the overwhelmingly common case: the fallback
  // locale is always preloaded by initI18n(), and a locale switched to
  // once stays loaded) calls straight through with no extra microtask
  // hop -- keeps changeLanguage()'s timing indistinguishable from before
  // this file lazy-loaded resources, which React Testing Library's
  // render()/act() flush (and DirectionProvider's own fire-and-forget
  // `void i18n.changeLanguage(locale)` effect) both depend on resolving
  // within the same synchronous-ish flush.
  if (locale && (locale === 'ar' || locale === 'en') && !loadedLocales.has(locale)) {
    return ensureLocaleLoaded(locale).then(() => originalChangeLanguage(lng, callback))
  }
  return originalChangeLanguage(lng, callback)
}) as typeof i18n.changeLanguage

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

// Production audit finding H-1 (RTL-bidi gap) root-cause fix: every
// *rendered* formatDate()/formatNumber()/formatCurrency() call site
// should go through <FormattedDate>/<FormattedNumber>/<FormattedCurrency>
// (src/components/ui/formatted-date.tsx, formatted-currency.tsx), which
// wrap the output in <bdi> the same way <MoneyDisplay> always has. The
// one shape those React components can't cover is a value interpolated
// into an i18next t() string (e.g. t('bookings.page.pricePerHourNow',
// { price: ... })) -- t() only accepts a string, never a React node.
// lib/domain/billing.ts's formatMoney() already solved exactly this for
// currency, using the same FSI/PDI Unicode isolate marks <bdi> uses
// under the hood, embedded directly in the returned string so they
// survive interpolation. These are that same fix for dates/numbers --
// use ONLY when the value must be interpolated into a t()-built string;
// every other rendered call site should use the React components.
const ISOLATE_FSI = '⁦'
const ISOLATE_PDI = '⁩'
export function formatDateIsolated(instant: string | Date, locale: SupportedLocale, timeZone: string, options?: Intl.DateTimeFormatOptions): string {
  return `${ISOLATE_FSI}${formatDate(instant, locale, timeZone, options)}${ISOLATE_PDI}`
}
export function formatNumberIsolated(value: number, locale: SupportedLocale): string {
  return `${ISOLATE_FSI}${formatNumber(value, locale)}${ISOLATE_PDI}`
}
