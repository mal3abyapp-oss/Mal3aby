import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { ShoppingCart, Package, Boxes, Undo2, Settings, ClipboardCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// COMMERCIAL MODULE (2026-08-26) -- mirrors FinanceNav's exact
// pattern: horizontally scrollable strip, degrades correctly at 375px
// (no tabs squeezed off-screen), each tab a real routed screen.
interface ShopNavItem {
  to: string
  labelKey: string
  icon: LucideIcon
  end?: boolean
}

const SHOP_NAV: ShopNavItem[] = [
  { to: '/app/shop', labelKey: 'shop.nav.pos', icon: ShoppingCart, end: true },
  { to: '/app/shop/products', labelKey: 'shop.nav.products', icon: Package },
  { to: '/app/shop/inventory', labelKey: 'shop.nav.inventory', icon: Boxes },
  { to: '/app/shop/stock-count', labelKey: 'shop.nav.stockCount', icon: ClipboardCheck },
  { to: '/app/shop/sales', labelKey: 'shop.nav.sales', icon: Undo2 },
  { to: '/app/shop/settings', labelKey: 'shop.nav.settings', icon: Settings },
]

export function ShopNav() {
  const { t } = useTranslation()
  return (
    <nav className="mb-4 -mx-4 flex gap-1 overflow-x-auto rounded-none bg-muted p-1 px-4 md:mx-0 md:rounded-lg md:px-1">
      {SHOP_NAV.map((item) => (
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
