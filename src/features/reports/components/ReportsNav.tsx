import { NavLink, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  CalendarCheck2,
  Landmark,
  GraduationCap,
  Users,
  BarChart3,
  ShoppingCart,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Master IA/UX audit (Reports decomposition phase): replaces the old
// single Tabs.Root (all 9 reports as siblings sharing one active-tab
// state in one 1127-line file) with real routed screens.
//
// NAVIGATION/TABS/RTL AUDIT (2026-08-23): the previous version of this
// component grouped these 6 destinations into FOUR separately-boxed
// pill clusters (each its own `bg-muted p-1 rounded-lg` div, with
// section-title labels floating above two of them), laid out with
// `flex flex-wrap gap-4` on the parent. Confirmed live at a real
// viewport (666px): this wrapped onto two visual rows with uneven
// group widths -- exactly the "متقطع / غير متوازن" (fragmented /
// unbalanced) complaint. That layout was never actually a Tabs
// pattern; it read as 4 unrelated toolbars.
//
// This is genuinely ONE primary navigation -- a visitor is choosing
// between 6 sibling report destinations for the currently-active
// club, one at a time, never several simultaneously -- so it now
// renders as ONE single-row tab bar, matching the exact same
// overflow-x-auto scrollable pattern already proven correct in the
// shared TabsList component (components/ui/tabs.tsx) and reused by
// FinanceReportsPage's own report switcher: on a narrow viewport the
// row scrolls horizontally within itself rather than wrapping the
// page or breaking into multiple rows. "Financial Reports" remains a
// single link into its own sub-tab hub (FinanceReportsPage) rather
// than 7 separate top-level entries -- unchanged decision from the
// Finance IA consolidation directive, just no longer visually
// separated into its own box.
interface ReportNavItem {
  to: string
  labelKey: string
  icon: LucideIcon
  end?: boolean
}

const REPORT_NAV_ITEMS: ReportNavItem[] = [
  { to: '/app/reports', labelKey: 'reports.nav.overview', icon: LayoutDashboard, end: true },
  { to: '/app/reports/bookings', labelKey: 'reports.nav.bookings', icon: CalendarCheck2 },
  { to: '/app/reports/occupancy', labelKey: 'reports.nav.occupancy', icon: Landmark },
  { to: '/app/finance/reports', labelKey: 'reports.nav.financialReports', icon: BarChart3 },
  { to: '/app/reports/academy', labelKey: 'reports.nav.academy', icon: GraduationCap },
  { to: '/app/reports/customers', labelKey: 'reports.nav.customers', icon: Users },
  { to: '/app/reports/shop', labelKey: 'reports.nav.shop', icon: ShoppingCart },
]

// Dead-end nav fix: router.tsx still registers 6 standalone financial
// report routes (revenue, collections, payment-methods, exceptions,
// official-receipts, reconciliation -- kept live for old bookmarks/
// deep-links, e.g. OwnerFinanceTransparency.tsx navigates straight to
// /app/reports/exceptions from the Dashboard). Each of those pages
// renders this same ReportsNav, but none of the 6 legacy slugs appear
// in REPORT_NAV_ITEMS above (intentionally -- the Finance IA directive
// says one "Financial Reports" entry, not 7). Without this map, a user
// landing on e.g. /app/reports/reconciliation had no way to reach any
// of its 5 financial-report siblings from this nav bar at all: the
// "Financial Reports" link went to /app/finance/reports?tab=revenue by
// default, silently dropping them back to Revenue instead of where
// they were. This map lets "Financial Reports" (a) light up as active
// while on any of these legacy routes, and (b) deep-link into the
// matching tab of the FinanceReportsPage hub via ?tab=, so the lateral
// path is real instead of merely present.
const LEGACY_FINANCIAL_REPORT_TABS: Record<string, string> = {
  '/app/reports/revenue': 'revenue',
  '/app/reports/collections': 'collections',
  '/app/reports/payment-methods': 'payment-methods',
  '/app/reports/exceptions': 'exceptions',
  '/app/reports/official-receipts': 'official-receipts',
  '/app/reports/reconciliation': 'reconciliation',
}

export function ReportsNav() {
  const { t } = useTranslation()
  const location = useLocation()
  const legacyTab = LEGACY_FINANCIAL_REPORT_TABS[location.pathname]

  return (
    <nav
      aria-label={t('reports.title')}
      className="mb-4 flex max-w-full items-center gap-1 overflow-x-auto rounded-lg bg-muted p-1"
    >
      {REPORT_NAV_ITEMS.map((item) => {
        const isFinancialReports = item.to === '/app/finance/reports'
        const to = isFinancialReports && legacyTab ? `${item.to}?tab=${legacyTab}` : item.to
        return (
          <NavLink
            key={item.to}
            to={to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-all',
                isActive || (isFinancialReports && legacyTab)
                  ? 'bg-background text-foreground shadow'
                  : 'text-muted-foreground hover:text-foreground',
              )
            }
          >
            <item.icon className="size-4" />
            {t(item.labelKey)}
          </NavLink>
        )
      })}
    </nav>
  )
}
