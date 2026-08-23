import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { DirectionProvider as RadixDirectionProvider } from '@radix-ui/react-direction'
import '@/lib/i18n/config'
import { LOCALE_STORAGE_KEY, type SupportedLocale } from '@/lib/i18n/config'

// RTL-first per docs/DESIGN_SYSTEM.md#rtl--internationalization — Arabic/RTL
// is the default; English/LTR is a toggle, not the baseline the app is
// mirrored from. See docs/DECISIONS.md ADR-010.
//
// Gate 10: this provider is now the single source of truth for BOTH
// direction and i18next's active language — setLocale() drives i18next
// (so every useTranslation() consumer re-renders with new strings) AND
// flips document.dir/lang, all in one call, with no page reload. This
// is deliberately the only place that calls i18n.changeLanguage() —
// components should call useDirection().setLocale(), never the i18next
// instance directly, so direction and language can never drift apart.
type Direction = 'rtl' | 'ltr'
type Locale = SupportedLocale

interface DirectionContextValue {
  locale: Locale
  direction: Direction
  setLocale: (locale: Locale) => void
}

const DirectionContext = createContext<DirectionContextValue | null>(null)

function readInitialLocale(): Locale {
  const stored = typeof window !== 'undefined' ? window.localStorage.getItem(LOCALE_STORAGE_KEY) : null
  return stored === 'en' ? 'en' : 'ar'
}

export function DirectionProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation()
  const [locale, setLocaleState] = useState<Locale>(readInitialLocale)
  const direction: Direction = locale === 'ar' ? 'rtl' : 'ltr'

  useEffect(() => {
    document.documentElement.dir = direction
    document.documentElement.lang = locale
  }, [direction, locale])

  useEffect(() => {
    if (i18n.language !== locale) {
      void i18n.changeLanguage(locale)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locale])

  function setLocale(next: Locale) {
    setLocaleState(next)
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next)
  }

  return (
    <DirectionContext.Provider value={{ locale, direction, setLocale }}>
      {/* NAVIGATION/TABS/RTL AUDIT (2026-08-23) -- proven root cause of
          "tabs render LTR despite the page being RTL": @radix-ui/react-
          direction's own useDirection() hook (used internally by every
          Radix primitive -- Tabs, Select, DropdownMenu, Dialog, Sheet)
          defaults to "ltr" whenever no <DirectionProvider> from THAT
          package wraps the tree, regardless of document.documentElement.
          dir. Confirmed live: a rendered TabsList had a literal
          dir="ltr" HTML attribute Radix set on itself, overriding the
          inherited RTL from <html dir="rtl">, because this provider was
          never wired -- our own DirectionProvider above only ever set
          document.documentElement.dir, which Radix's internal hook
          never reads. This single wrapper fixes every Radix consumer at
          once (no per-component patching), staying in sync with the
          same `direction` this provider already computes -- one source
          of truth, never able to drift from the app's real locale. */}
      <RadixDirectionProvider dir={direction}>{children}</RadixDirectionProvider>
    </DirectionContext.Provider>
  )
}

export function useDirection() {
  const ctx = useContext(DirectionContext)
  if (!ctx) throw new Error('useDirection must be used within DirectionProvider')
  return ctx
}
