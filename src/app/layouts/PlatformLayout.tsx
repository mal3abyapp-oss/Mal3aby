import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import {
  LayoutDashboard,
  Building2,
  Users,
  CreditCard,
  Wallet,
  RefreshCw,
  Sparkles,
  BarChart3,
  Bell,
  Inbox,
  ShieldCheck,
  Settings,
  Menu,
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
  { to: '/platform/owners', label: 'أصحاب الأندية', icon: Users },
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

function PlatformNavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-1 flex-col gap-1 px-2">
      {navItems.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/platform'}
          onClick={onNavigate}
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
  )
}

export function PlatformLayout() {
  // Owner-level review finding (P1): this shell's sidebar was
  // `hidden ... md:flex` with NO mobile fallback at all -- below the
  // md breakpoint (768px) a Platform Owner had literally zero way to
  // navigate away from whichever page they landed on (no bottom nav,
  // no hamburger, nothing), unlike AppLayout which has always had a
  // mobile bottom nav. Fixed with a hamburger + slide-in Sheet reusing
  // the exact same navItems/NavLink markup as the desktop sidebar (no
  // navigation model duplicated, just presented in two containers).
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  return (
    <div className="flex min-h-screen bg-page-bg">
      <aside className="hidden w-64 shrink-0 border-e border-border bg-dark-secondary text-white md:flex md:flex-col">
        <div className="px-4 py-5">
          <p className="text-lg font-bold">Mala3by</p>
          <p className="text-xs text-white/50">Platform Owner Console</p>
        </div>
        <PlatformNavList />
      </aside>

      <div className="flex flex-1 flex-col">
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-4 md:hidden">
          <span className="font-bold text-text-primary">Mala3by — Platform</span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="فتح قائمة التنقل"
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu className="size-5" />
          </Button>
        </header>
        <main className="flex-1 p-4">
          <Outlet />
        </main>
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        {/* sheet.tsx's `side` variant is physical (left/right), not
            logical -- this app is Arabic/RTL-primary, so "right" is the
            correct reading-start edge here. Matches the sidebar's own
            `border-e` (logical end-border) direction-awareness in spirit
            without needing a new variant on the shared component. */}
        <SheetContent side="right" className="flex w-64 flex-col bg-dark-secondary p-0 text-white">
          <SheetTitle className="px-4 py-5 text-lg font-bold text-white">Mala3by — Platform</SheetTitle>
          <PlatformNavList onNavigate={() => setMobileNavOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
  )
}
