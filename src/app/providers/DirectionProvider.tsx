import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

// RTL-first per docs/DESIGN_SYSTEM.md#rtl--internationalization — Arabic/RTL
// is the default; English/LTR is a toggle, not the baseline the app is
// mirrored from. See docs/DECISIONS.md ADR-010.
type Direction = 'rtl' | 'ltr'
type Locale = 'ar' | 'en'

interface DirectionContextValue {
  locale: Locale
  direction: Direction
  setLocale: (locale: Locale) => void
}

const DirectionContext = createContext<DirectionContextValue | null>(null)

export function DirectionProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>('ar')
  const direction: Direction = locale === 'ar' ? 'rtl' : 'ltr'

  useEffect(() => {
    document.documentElement.dir = direction
    document.documentElement.lang = locale
  }, [direction, locale])

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
