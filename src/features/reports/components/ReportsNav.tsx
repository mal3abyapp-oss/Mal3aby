import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Wallet,
  HandCoins,
  Banknote,
  ReceiptText,
  CalendarCheck2,
  Landmark,
  GraduationCap,
  Users,
  ShieldCheck,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Master IA/UX audit (Reports decomposition phase): replaces the old
// single Tabs.Root (all 9 reports as siblings sharing one active-tab
// state in one 1127-line file) with real routed screens grouped under
// labeled sections -- matching the target structure the audit
// recommended (Overview / التشغيل / المالية / الأكاديمية والعملاء).
// Each report is now its own screen/route with its own bundle, own
// state, no shared active-tab coupling -- "one primary responsibility
// per screen" applied for real, not just visually.
interface ReportNavItem {
  to: string
  labelKey: string
  icon: LucideIcon
  end?: boolean
}

interface ReportNavGroup {
  titleKey: string | null
  items: ReportNavItem[]
}

const REPORT_NAV: ReportNavGroup[] = [
  { titleKey: null, items: [{ to: '/app/reports', labelKey: 'reports.nav.overview', icon: LayoutDashboard, end: true }] },
  {
    titleKey: 'reports.nav.sectionOperations',
    items: [
      { to: '/app/reports/bookings', labelKey: 'reports.nav.bookings', icon: CalendarCheck2 },
      { to: '/app/reports/occupancy', labelKey: 'reports.nav.occupancy', icon: Landmark },
    ],
  },
  {
    titleKey: 'reports.nav.sectionFinance',
    items: [
      { to: '/app/reports/revenue', labelKey: 'reports.nav.revenue', icon: Wallet },
      { to: '/app/reports/collections', labelKey: 'reports.nav.collections', icon: HandCoins },
      { to: '/app/reports/payment-methods', labelKey: 'reports.nav.paymentMethods', icon: Banknote },
      { to: '/app/reports/exceptions', labelKey: 'reports.nav.exceptions', icon: ReceiptText },
      { to: '/app/reports/official-receipts', labelKey: 'reports.nav.officialReceipts', icon: ShieldCheck },
    ],
  },
  {
    titleKey: 'reports.nav.sectionAcademyCustomers',
    items: [
      { to: '/app/reports/academy', labelKey: 'reports.nav.academy', icon: GraduationCap },
      { to: '/app/reports/customers', labelKey: 'reports.nav.customers', icon: Users },
    ],
  },
]

export function ReportsNav() {
  const { t } = useTranslation()
  return (
    <nav className="mb-4 flex flex-wrap gap-4">
      {REPORT_NAV.map((group, i) => (
        <div key={group.titleKey ?? `group-${i}`} className="flex flex-col gap-1">
          {group.titleKey && <p className="px-1 text-xs font-medium text-text-secondary">{t(group.titleKey)}</p>}
          <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-all',
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
          </div>
        </div>
      ))}
    </nav>
  )
}
