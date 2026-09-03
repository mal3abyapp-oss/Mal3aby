import { useDirection } from '@/app/providers/DirectionProvider'
import { formatCurrency, type SupportedLocale } from '@/lib/i18n/config'

// RTL-bidi root-cause fix -- companion to FormattedDate (formatted-date.tsx)
// and MoneyDisplay (money-display.tsx). lib/i18n/config.ts's
// formatCurrency() returns a PLAIN STRING with no bidi isolation, unlike
// MoneyDisplay which has always correctly wrapped its own (differently
// formatted -- always 2 decimals, no Intl currency symbol) output in
// <bdi>. formatCurrency() uses Intl's `style: 'currency'` with 0 decimal
// places, which several billing/reports/verification screens rely on
// specifically (e.g. showing "EGP 1,250" rather than "1,250.00 EGP") --
// this component is the drop-in <bdi>-wrapped replacement for THAT exact
// output shape. Prefer <MoneyDisplay> instead when a screen wants its
// tone/size variants and the always-2-decimal "amount CUR" shape;
// prefer this component when migrating an existing formatCurrency() call
// site that must keep formatCurrency()'s own formatting.
export interface FormattedCurrencyProps {
  value: number | null | undefined
  currencyCode?: string
  className?: string
  /** Shown when `value` is null/undefined. Defaults to an em dash,
   *  matching the "—" placeholder already used at every call site this
   *  migrates. */
  fallback?: string
}

export function FormattedCurrency({ value, currencyCode = 'EGP', className, fallback = '—' }: FormattedCurrencyProps) {
  const { locale } = useDirection()
  if (value === null || value === undefined) {
    return <>{fallback}</>
  }
  const formatted = formatCurrency(value, locale as SupportedLocale, currencyCode)
  return (
    <span className={className}>
      <bdi>{formatted}</bdi>
    </span>
  )
}
