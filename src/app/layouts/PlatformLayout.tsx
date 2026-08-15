import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '@/lib/utils'
import {
  LayoutDashboard,
  Building2,
  CreditCard,
  Wallet,
  RefreshCw,
  Sparkles,
  BarChart3,
  Bell,
  Inbox,
  ShieldCheck,
  Settings,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Platform Owner console shell — fully separate from AppLayout, never
// merged navigation. See docs/ARCHITECTURE.md#public-website--layout-strategy,
// docs/SCREEN_MAP.md Platform Owner Navigation.
// Route guard (platform_owner permission required) lands in Phase 3c.
interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

const navItems: NavItem[] = [
  { to: '/platform', label: 'نظرة عامة', icon: LayoutDashboard },
  { to: '/platform/clubs', label: 'الأندية', icon: Building2 },
  { to: '/platform/subscriptions', label: 'الاشتراكات', icon: CreditCard },
  { to: '/platform/plans', label: 'الخطط', icon: Sparkles },
  { to: '/platform/payments', label: 'المدفوعات', icon: Wallet },
  { to: '/platform/renewals', label: 'التجديدات', icon: RefreshCw },
  { to: '/platform/trials', label: 'التجارب المجانية', icon: Sparkles },
  { to: '/platform/leads', label: 'طلبات التواصل', icon: Inbox },
  { to: '/platform/reports', label: 'التقارير', icon: BarChart3 },
  { to: '/platform/alerts', label: 'التنبيهات', icon: Bell },
  { to: '/platform/audit', label: 'سجل التدقيق', icon: ShieldCheck },
  { to: '/platform/settings', label: 'الإعدادات', icon: Settings },
]

export function PlatformLayout() {
  return (
    <div className="flex min-h-screen bg-page-bg">
      <aside className="hidden w-64 shrink-0 border-e border-border bg-dark-secondary text-white md:flex md:flex-col">
        <div className="px-4 py-5">
          <p className="text-lg font-bold">Mala3by</p>
          <p className="text-xs text-white/50">Platform Owner Console</p>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/platform'}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white',
                  isActive && 'bg-accent text-accent-foreground hover:bg-accent/90',
                )
              }
            >
              <item.icon className="size-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center border-b border-border bg-surface px-4 md:hidden">
          <span className="font-bold text-text-primary">Mala3by — Platform</span>
        </header>
        <main className="flex-1 p-4">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
