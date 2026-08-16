import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'
import { CalendarDays, GraduationCap, QrCode, User, LogOut } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Gate 3 — Unified User Dashboard shell. Deliberately separate from
// AppLayout (the staff/employee product): a customer/guardian is never
// a club_membership row and must never see staff navigation (billing
// management, staff list, settings, reports). Mobile-first — a
// customer is far more likely to be on a phone than a desk.
interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

const navItems: NavItem[] = [
  { to: '/portal', label: 'حجوزاتي', icon: CalendarDays },
  { to: '/portal/academy', label: 'أكاديميتي', icon: GraduationCap },
  { to: '/portal/qr', label: 'رمزي', icon: QrCode },
  { to: '/portal/profile', label: 'حسابي', icon: User },
]

export function PortalLayout() {
  const { signOut } = useAuth()

  return (
    <div className="flex min-h-screen flex-col bg-page-bg">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-border bg-surface px-4 py-3">
        <span className="text-lg font-bold">ملعبي | Mala3by</span>
        <button
          onClick={() => void signOut()}
          className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-status-danger"
        >
          <LogOut className="size-4" />
          خروج
        </button>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-4 pb-24">
        <Outlet />
      </main>

      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-surface">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/portal'}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs ${
                isActive ? 'text-accent-foreground' : 'text-text-secondary'
              }`
            }
          >
            <item.icon className="size-5" />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  )
}
