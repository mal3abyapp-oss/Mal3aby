import { useDirection } from '@/app/providers/DirectionProvider'
import { formatDate, formatNumber, type SupportedLocale } from '@/lib/i18n/config'

// RTL-bidi root-cause fix (see money-display.tsx for the original
// pattern this mirrors): lib/i18n/config.ts's formatDate() returns a
// PLAIN STRING with no bidi isolation. A plain string is exactly right
// for non-rendered call sites (CSV/filename/export use) but every
// *rendered* call site needs the same <bdi> isolation MoneyDisplay
// already gives currency -- a Gregorian date is Latin-digit content
// that can sit directly beside/inside Arabic sentence text (e.g.
// "صدر في: 3 سبتمبر 2026"), and without isolation the browser's bidi
// algorithm can visually reorder it depending on surrounding context.
// This defect class was fixed piecemeal ~10 times across billing,
// reports, dashboard, WhatsApp activity/audit logs, and the public
// invoice-verification page before this component existed -- use THIS
// for every rendered date instead of calling formatDate() directly.
export interface FormattedDateProps {
  /** ISO string or Date -- same as formatDate()'s own `instant` param. */
  value: string | Date | null | undefined
  /** IANA timezone. Required, matching formatDate()'s own contract --
   *  never format a raw instant without an explicit venue timezone. */
  timeZone: string
  options?: Intl.DateTimeFormatOptions
  /** Shown when `value` is null/undefined. Defaults to an em dash,
   *  matching the "—" placeholder already used at every call site this
   *  migrates. */
  fallback?: string
  className?: string
}

export function FormattedDate({ value, timeZone, options, fallback = '—', className }: FormattedDateProps) {
  const { locale } = useDirection()
  if (value === null || value === undefined) {
    return <>{fallback}</>
  }
  const formatted = formatDate(value, locale as SupportedLocale, timeZone, options)
  return (
    <span className={className}>
      <bdi>{formatted}</bdi>
    </span>
  )
}

// Companion to FormattedDate for the formatNumber() call sites (price-
// per-hour badges, etc.) -- same isolation rationale, plain numerals
// rather than a date/time string.
export interface FormattedNumberProps {
  value: number
  options?: Intl.NumberFormatOptions
  className?: string
}

export function FormattedNumber({ value, className }: FormattedNumberProps) {
  const { locale } = useDirection()
  const formatted = formatNumber(value, locale as SupportedLocale)
  return (
    <span className={className}>
      <bdi>{formatted}</bdi>
    </span>
  )
}
