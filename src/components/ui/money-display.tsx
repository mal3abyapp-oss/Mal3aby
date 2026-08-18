import { cn } from '@/lib/utils'
import { useDirection } from '@/app/providers/DirectionProvider'

// Financial figures must always be immediately legible — never buried in
// small secondary text. See docs/DESIGN_SYSTEM.md#billing--outstanding-ux.
export interface MoneyDisplayProps {
  amount: number
  currency?: string
  size?: 'sm' | 'md' | 'lg'
  tone?: 'default' | 'danger' | 'success'
  className?: string
}

const sizeClass = { sm: 'text-sm', md: 'text-base font-semibold', lg: 'text-2xl font-bold' } as const
const toneClass = {
  default: 'text-text-primary',
  danger: 'text-status-danger',
  success: 'text-status-success',
} as const

export function MoneyDisplay({ amount, currency = 'EGP', size = 'md', tone = 'default', className }: MoneyDisplayProps) {
  // English-localization sweep: was hardcoded to 'ar-EG' regardless of
  // the app's active language, so English-mode screens showed
  // Arabic-Indic digits. DirectionProvider is mounted globally above
  // the router (App.tsx), so every consumer of this component --
  // authenticated app pages and public-site pages alike -- has it in
  // context.
  const { locale } = useDirection()
  const formatted = new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'ar-EG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)

  return (
    <span className={cn('tabular-nums', sizeClass[size], toneClass[tone], className)}>
      {/* Master IA/UX audit (RTL phase): money is a Latin-digit value
          that can appear directly beside/inside Arabic sentence text
          (e.g. "المتبقي: 220.00 EGP") -- without bidi isolation the
          browser's bidi algorithm can visually reorder it inside RTL
          context (the exact bug class StatCard already guards against
          for composite values, see stat-card.tsx). <bdi> isolates this
          span's internal direction from its surrounding context so it
          always reads left-to-right regardless of where it's embedded. */}
      <bdi>{formatted} {currency}</bdi>
    </span>
  )
}
