import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { LayoutDashboard, HandCoins, ReceiptText, Wallet, BarChart3, Receipt } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Finance IA consolidation directive: the single sub-navigation for the
// whole /app/finance module. Deliberately a horizontally scrollable
// strip (not a grid, not 6 items forced onto one line) so it degrades
// correctly on a 375px viewport (directive section 42: "no 6 tabs
// squeezed off-screen") -- overflow-x-auto on the nav itself, each tab
// keeps a comfortable tap target and whitespace-nowrap label.
interface FinanceNavItem {
  to: string
  labelKey: string
  icon: LucideIcon
  end?: boolean
}

const FINANCE_NAV: FinanceNavItem[] = [
  { to: '/app/finance', labelKey: 'finance.nav.overview', icon: LayoutDashboard, end: true },
  { to: '/app/finance/payments', labelKey: 'finance.nav.payments', icon: HandCoins },
  { to: '/app/finance/invoices', labelKey: 'finance.nav.invoices', icon: ReceiptText },
  { to: '/app/finance/cash', labelKey: 'finance.nav.cash', icon: Wallet },
  { to: '/app/finance/expenses', labelKey: 'finance.nav.expenses', icon: Receipt },
  { to: '/app/finance/reports', labelKey: 'finance.nav.reports', icon: BarChart3 },
]

export function FinanceNav() {
  const { t } = useTranslation()
  return (
    <nav className="mb-4 -mx-4 flex gap-1 overflow-x-auto rounded-none bg-muted p-1 px-4 md:mx-0 md:rounded-lg md:px-1">
      {FINANCE_NAV.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all',
              isActive
                ? 'bg-background text-foreground shadow'
                : 'text-muted-foreground hover:text-foreground',
            )
          }
        >
          <item.icon className="size-4" />
          {t(item.labelKey)}
        </NavLink>
      ))}
    </nav>
  )
}
