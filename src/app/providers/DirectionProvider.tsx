import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
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
      {children}
    </DirectionContext.Provider>
  )
}

export function useDirection() {
  const ctx = useContext(DirectionContext)
  if (!ctx) throw new Error('useDirection must be used within DirectionProvider')
  return ctx
}
