import { NavLink } from 'react-router-dom'
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
  label: string
  icon: LucideIcon
  end?: boolean
}

interface ReportNavGroup {
  title: string | null
  items: ReportNavItem[]
}

const REPORT_NAV: ReportNavGroup[] = [
  { title: null, items: [{ to: '/app/reports', label: 'نظرة عامة', icon: LayoutDashboard, end: true }] },
  {
    title: 'التشغيل',
    items: [
      { to: '/app/reports/bookings', label: 'الحجوزات', icon: CalendarCheck2 },
      { to: '/app/reports/occupancy', label: 'إشغال الملاعب', icon: Landmark },
    ],
  },
  {
    title: 'المالية',
    items: [
      { to: '/app/reports/revenue', label: 'الإيرادات', icon: Wallet },
      { to: '/app/reports/collections', label: 'التحصيلات', icon: HandCoins },
      { to: '/app/reports/payment-methods', label: 'تسوية طرق الدفع', icon: Banknote },
      { to: '/app/reports/exceptions', label: 'الاستثناءات المالية', icon: ReceiptText },
    ],
  },
  {
    title: 'الأكاديمية والعملاء',
    items: [
      { to: '/app/reports/academy', label: 'الأكاديمية', icon: GraduationCap },
      { to: '/app/reports/customers', label: 'العملاء', icon: Users },
    ],
  },
]

export function ReportsNav() {
  return (
    <nav className="mb-4 flex flex-wrap gap-4">
      {REPORT_NAV.map((group, i) => (
        <div key={group.title ?? `group-${i}`} className="flex flex-col gap-1">
          {group.title && <p className="px-1 text-xs font-medium text-text-secondary">{group.title}</p>}
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
                {item.label}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  )
}
