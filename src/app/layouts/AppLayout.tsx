import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { useAuth } from '@/app/providers/AuthProvider'
import {
  CalendarDays,
  GraduationCap,
  Users,
  Receipt,
  BarChart3,
  Building2,
  UserCog,
  Settings,
  LayoutDashboard,
  ScanLine,
  MoreHorizontal,
  LogOut,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Authenticated club-side app shell — desktop sidebar + mobile bottom nav.
// See docs/DESIGN_SYSTEM.md#app-shell--desktop and #mobile-rules,
// docs/SCREEN_MAP.md for the canonical nav item list.
// Sidebar items should be permission-filtered once auth exists (Phase 2) —
// see docs/DESIGN_SYSTEM.md#app-shell--desktop "if no permission, don't show".
interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

const sidebarItems: NavItem[] = [
  { to: '/app', label: 'اليوم', icon: LayoutDashboard },
  { to: '/app/bookings', label: 'الحجوزات', icon: CalendarDays },
  { to: '/app/academy', label: 'الأكاديمية', icon: GraduationCap },
  { to: '/app/customers', label: 'العملاء', icon: Users },
  { to: '/app/billing', label: 'الفواتير والمدفوعات', icon: Receipt },
  { to: '/app/reports', label: 'التقارير', icon: BarChart3 },
  { to: '/app/club', label: 'النادي', icon: Building2 },
  { to: '/app/staff', label: 'الموظفون', icon: UserCog },
  { to: '/app/settings', label: 'الإعدادات', icon: Settings },
]

const mobileNavItems: NavItem[] = [
  { to: '/app', label: 'اليوم', icon: LayoutDashboard },
  { to: '/app/bookings', label: 'الحجوزات', icon: CalendarDays },
  { to: '/scan', label: 'مسح', icon: ScanLine },
  { to: '/app/academy', label: 'الأكاديمية', icon: GraduationCap },
  { to: '/app/more', label: 'المزيد', icon: MoreHorizontal },
]

export function AppLayout() {
  const { memberships, currentMembership, setCurrentClubId, signOut } = useAuth()

  return (
    <div className="flex min-h-screen bg-page-bg">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 border-e border-border bg-dark-base text-white md:flex md:flex-col">
        <div className="px-4 py-5 text-lg font-bold">ملعبي | Mala3by</div>

        {memberships.length > 0 && (
          <div className="px-2 pb-3">
            <select
              className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white"
              value={currentMembership?.clubId ?? ''}
              onChange={(e) => setCurrentClubId(e.target.value)}
            >
              {memberships.map((m) => (
                <option key={m.clubId} value={m.clubId} className="text-black">
                  {m.clubNameAr}
                </option>
              ))}
            </select>
            {currentMembership && (
              <p className="mt-1 px-1 text-xs text-white/50">{currentMembership.roleNameAr}</p>
            )}
          </div>
        )}

        <nav className="flex flex-1 flex-col gap-1 px-2">
          {sidebarItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/app'}
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

        <button
          onClick={() => void signOut()}
          className="flex items-center gap-3 px-5 py-4 text-sm font-medium text-white/60 hover:text-white"
        >
          <LogOut className="size-4" />
          تسجيل الخروج
        </button>
      </aside>

      <div className="flex flex-1 flex-col">
        {/* Top bar (mobile: shows brand; desktop: reserved for search/actions in later phases) */}
        <header className="flex h-14 items-center border-b border-border bg-surface px-4 md:hidden">
          <span className="font-bold text-text-primary">ملعبي | Mala3by</span>
        </header>

        <main className="flex-1 p-4 pb-20 md:pb-4">
          <Outlet />
        </main>

        {/* Mobile bottom nav */}
        <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface md:hidden">
          {mobileNavItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/app'}
              className={({ isActive }) =>
                cn(
                  'flex flex-1 flex-col items-center gap-1 py-2 text-xs text-text-secondary',
                  isActive && 'text-accent-foreground',
                  item.to === '/scan' && 'font-semibold',
                )
              }
            >
              <item.icon className={cn('size-5', item.to === '/scan' && 'size-6 text-status-success')} />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  )
}
