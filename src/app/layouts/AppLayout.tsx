import { NavLink, Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useAuth } from '@/app/providers/AuthProvider'
import { supabase } from '@/lib/supabase/client'
import { GlobalSearch } from '@/features/search/GlobalSearch'
import { QuickActionsPalette } from '@/features/dashboard/QuickActionsPalette'
import { LanguageSwitcher } from '@/components/ui/language-switcher'
import {
  CalendarDays,
  GraduationCap,
  Users,
  Receipt,
  BarChart3,
  UserCog,
  Settings,
  LayoutDashboard,
  ScanLine,
  MoreHorizontal,
  LogOut,
  MessageCircle,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Authenticated club-side app shell — desktop sidebar + mobile bottom nav.
// See docs/DESIGN_SYSTEM.md#app-shell--desktop and #mobile-rules,
// docs/SCREEN_MAP.md for the canonical nav item list.
// Sidebar items should be permission-filtered once auth exists (Phase 2) —
// see docs/DESIGN_SYSTEM.md#app-shell--desktop "if no permission, don't show".
interface NavItem {
  to: string
  labelKey: string
  icon: LucideIcon
}

// Gate 10: labels moved to i18n keys (nav.*) resolved via t() inside
// the component -- these arrays stay static (no re-render cost from
// recreating them), only the label lookup is locale-aware.
const sidebarItems: NavItem[] = [
  { to: '/app', labelKey: 'nav.today', icon: LayoutDashboard },
  { to: '/app/bookings', labelKey: 'nav.bookings', icon: CalendarDays },
  { to: '/app/academy', labelKey: 'nav.academy', icon: GraduationCap },
  { to: '/app/customers', labelKey: 'nav.customers', icon: Users },
  { to: '/app/billing', labelKey: 'nav.billing', icon: Receipt },
  { to: '/app/reports', labelKey: 'nav.reports', icon: BarChart3 },
  { to: '/app/whatsapp', labelKey: 'nav.whatsapp', icon: MessageCircle },
  { to: '/app/staff', labelKey: 'nav.staff', icon: UserCog },
  { to: '/app/settings', labelKey: 'nav.settings', icon: Settings },
]

const mobileNavItems: NavItem[] = [
  { to: '/app', labelKey: 'nav.today', icon: LayoutDashboard },
  { to: '/app/bookings', labelKey: 'nav.bookings', icon: CalendarDays },
  { to: '/scan', labelKey: 'nav.scan', icon: ScanLine },
  { to: '/app/academy', labelKey: 'nav.academy', icon: GraduationCap },
  { to: '/app/more', labelKey: 'nav.more', icon: MoreHorizontal },
]

async function fetchSubscriptionSummary(clubId: string) {
  const { data, error } = await supabase
    .from('club_platform_subscription_summary')
    .select('*')
    .eq('club_id', clubId)
    .maybeSingle()
  if (error) throw error
  return data
}

export function AppLayout() {
  const { t } = useTranslation()
  const { memberships, currentMembership, currentClubId, setCurrentClubId, signOut } = useAuth()
  const { data: subSummary } = useQuery({
    queryKey: ['app-subscription-summary', currentClubId],
    queryFn: () => fetchSubscriptionSummary(currentClubId!),
    enabled: !!currentClubId,
  })

  const daysRemaining = subSummary?.end_at
    ? Math.ceil((new Date(subSummary.end_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null

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
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center justify-between px-5 py-3 border-t border-white/10">
          <LanguageSwitcher className="text-white/60 hover:text-white" />
        </div>
        <button
          onClick={() => void signOut()}
          className="flex items-center gap-3 px-5 py-4 text-sm font-medium text-white/60 hover:text-white"
        >
          <LogOut className="size-4" />
          {t('nav.logout')}
        </button>
      </aside>

      <div className="flex flex-1 flex-col">
        {/* Top bar: mobile shows brand, desktop shows Global Search */}
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-4 md:hidden">
          <span className="font-bold text-text-primary">ملعبي | Mala3by</span>
          <LanguageSwitcher />
        </header>
        <header className="hidden h-14 items-center gap-4 border-b border-border bg-surface px-4 md:flex">
          <GlobalSearch />
          <QuickActionsPalette />
          <LanguageSwitcher className="ms-auto" />
        </header>

        {subSummary?.subscription_kind === 'trial' && subSummary.effective_access === 'full' && (
          <div className="flex items-center justify-between gap-3 bg-status-info/10 px-4 py-2 text-sm text-status-info">
            <span>تجربتك المجانية تنتهي خلال {daysRemaining} يوم</span>
            <NavLink to="/app/subscription" className="font-medium hover:underline">
              عرض الاشتراك
            </NavLink>
          </div>
        )}
        {subSummary?.effective_access === 'blocked' && (
          <div className="flex items-center justify-between gap-3 bg-status-danger/10 px-4 py-2 text-sm text-status-danger">
            <span>
              {subSummary.subscription_kind === 'trial'
                ? 'انتهت التجربة المجانية — تواصل معنا لتفعيل الاشتراك'
                : 'الاشتراك منتهٍ — تواصل معنا لتفعيل الاشتراك'}
            </span>
            <NavLink to="/app/subscription" className="font-medium hover:underline">
              عرض الاشتراك
            </NavLink>
          </div>
        )}
        {subSummary?.effective_access === 'grace' && (
          <div className="flex items-center justify-between gap-3 bg-status-warning/10 px-4 py-2 text-sm text-status-warning">
            <span>اشتراكك في فترة السماح — العمليات الجديدة موقوفة مؤقتًا</span>
            <NavLink to="/app/subscription" className="font-medium hover:underline">
              عرض الاشتراك
            </NavLink>
          </div>
        )}

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
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>
      </div>
    </div>
  )
}
