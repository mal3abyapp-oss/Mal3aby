import { Suspense } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/app/providers/AuthProvider'
import { PortalClubProvider, usePortalClub } from '@/app/providers/PortalClubProvider'
import { CalendarDays, GraduationCap, Wallet, QrCode, User, LogOut } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { LanguageSwitcher } from '@/components/ui/language-switcher'
import { RouteLoadingFallback } from '@/app/routing/RouteLoadingFallback'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useDirection } from '@/app/providers/DirectionProvider'

// Gate 3 — Unified User Dashboard shell. Deliberately separate from
// AppLayout (the staff/employee product): a customer/guardian is never
// a club_membership row and must never see staff navigation (billing
// management, staff list, settings, reports). Mobile-first — a
// customer is far more likely to be on a phone than a desk.
interface NavItem {
  to: string
  labelKey: string
  icon: LucideIcon
}

// IA restructuring (Phase 10): "حجوزاتي" now points at a real, stable
// /portal/bookings route instead of the claim-gated index (/portal) --
// confirmed in the audit that no direct URL for "my bookings" existed
// independent of PortalRoot's claim-gate check. The index route still
// exists and still renders the same page for a first-time visit
// (RequirePortalAuth guarantees the gate has already resolved by the
// time any nav click is even possible), so this is a pure improvement,
// not a behavior change for existing users.
const navItems: NavItem[] = [
  { to: '/portal/bookings', labelKey: 'portal.nav.bookings', icon: CalendarDays },
  { to: '/portal/academy', labelKey: 'portal.nav.academy', icon: GraduationCap },
  { to: '/portal/payments', labelKey: 'portal.nav.payments', icon: Wallet },
  { to: '/portal/qr', labelKey: 'portal.nav.qr', icon: QrCode },
  { to: '/portal/profile', labelKey: 'portal.nav.profile', icon: User },
]

export function PortalLayout() {
  const { t } = useTranslation()
  const { signOut } = useAuth()

  return (
    <PortalClubProvider>
      <div className="flex min-h-screen flex-col bg-page-bg">
        <header className="sticky top-0 z-30 flex flex-col gap-2 border-b border-border bg-surface px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-lg font-bold">ملعبي | Mal3aby</span>
            <div className="flex items-center gap-3">
              <LanguageSwitcher />
              <button
                onClick={() => void signOut()}
                className="flex items-center gap-1.5 text-sm text-text-secondary hover:text-status-danger"
              >
                <LogOut className="size-4" />
                {t('portal.logout')}
              </button>
            </div>
          </div>
          <PortalClubSwitcher />
        </header>

        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-4 pb-24">
          <Suspense fallback={<RouteLoadingFallback />}>
            <Outlet />
          </Suspense>
        </main>

        <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-surface">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs ${
                  isActive ? 'text-accent-foreground' : 'text-text-secondary'
                }`
              }
            >
              <item.icon className="size-5" />
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>
      </div>
    </PortalClubProvider>
  )
}

// Multi-Club E2E audit (2026-08-24): a customer linked to more than one
// club had no way to see which club's data they were looking at, or to
// switch -- every portal page silently merged all linked clubs' rows
// into one flat list. Shown only when there is genuinely more than one
// linked club (the overwhelming common case, a single-club customer,
// sees nothing new here). Mirrors the staff-side club switcher's own
// visibility rule (AppLayout only shows its switcher when
// memberships.length > 1) rather than inventing a different threshold.
function PortalClubSwitcher() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { customerMemberships, activeClubId, setActiveClubId } = usePortalClub()

  if (customerMemberships.length <= 1) return null

  return (
    <Select value={activeClubId ?? ''} onValueChange={setActiveClubId}>
      <SelectTrigger className="h-8 w-full text-sm" aria-label={t('portal.clubSwitcher.label')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {customerMemberships.map((m) => (
          <SelectItem key={m.clubId} value={m.clubId}>
            {locale === 'en' ? (m.clubName ?? m.clubNameAr ?? m.clubId) : (m.clubNameAr ?? m.clubId)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
