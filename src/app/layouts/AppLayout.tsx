import { Suspense, useEffect } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { useAuth } from '@/app/providers/AuthProvider'
import { RouteLoadingFallback } from '@/app/routing/RouteLoadingFallback'
import { supabase } from '@/lib/supabase/client'
import { GlobalSearch } from '@/features/search/GlobalSearch'
import { QuickActionsPalette } from '@/features/dashboard/QuickActionsPalette'
import { LanguageSwitcher } from '@/components/ui/language-switcher'
import { MasterAdminBanner } from '@/components/ui/master-admin-banner'
import { canSeeNavDomain, type NavDomain } from '@/lib/domain/navigation'
import { usePendingPaymentsCount } from '@/features/billing/usePendingPaymentsCount'
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
  Building2,
  ShieldCheck,
  IdCard,
  ShoppingCart,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Authenticated club-side app shell — desktop sidebar + mobile bottom nav.
// See docs/DESIGN_SYSTEM.md#app-shell--desktop and #mobile-rules,
// docs/SCREEN_MAP.md for the canonical nav item list.
//
// IA restructuring (Phase 3): sidebar is now permission-filtered by
// role via src/lib/domain/navigation.ts -- this was flagged as an
// intended-but-never-built Phase 2 task (see the removed comment that
// used to sit here) and confirmed as a real gap in
// MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md: every role previously saw
// all 9 items regardless of relevance (RLS always prevented any actual
// data leak -- this was a UX-clarity fix, not a security fix).
interface NavItem {
  to: string
  labelKey: string
  icon: LucideIcon
  domain: NavDomain
}

interface NavSection {
  titleKey: string | null
  items: NavItem[]
}

// Gate 10: labels moved to i18n keys (nav.*) resolved via t() inside
// the component -- these arrays stay static (no re-render cost from
// recreating them), only the label lookup is locale-aware.
//
// Finance IA consolidation directive (sections 1-84): the 5 flat
// "Finance" items (Billing, Outstanding, Pending Payments, Cash Shift,
// Subscription) collapse into ONE nav entry -- /app/finance, a real
// tabbed module (Overview/Payments & Collections/Invoices & Receipts/
// Cash Shifts & Treasury/Expenses/Reports) rather than a sidebar
// section grouping 5 competing top-level pages (directive section 84:
// "Do not leave Billing/Outstanding/Cash Shift/Pending Payments/
// Official Receipts as separate competing primary navigation items").
// Club's own platform-subscription status is a different concern
// (SaaS billing, not customer money) and keeps its own link, moved next
// to Settings where account-status concerns live.
const navSections: NavSection[] = [
  {
    titleKey: null,
    items: [
      { to: '/app', labelKey: 'nav.today', icon: LayoutDashboard, domain: 'today' },
      { to: '/app/bookings', labelKey: 'nav.bookings', icon: CalendarDays, domain: 'bookings' },
      { to: '/app/academy', labelKey: 'nav.academy', icon: GraduationCap, domain: 'academy' },
      // Club Memberships: a genuine top-level main domain, deliberately
      // never nested under Academy (directive Section 96/111).
      { to: '/app/memberships', labelKey: 'nav.memberships', icon: IdCard, domain: 'memberships' },
      { to: '/app/customers', labelKey: 'nav.customers', icon: Users, domain: 'customers' },
      // COMMERCIAL MODULE (2026-08-26) -- shop.view alone gates nav
      // visibility here (matching every other item's pattern); whether
      // the module is actually entitled+active for this club is a
      // separate check handled by RequireShopModule at the route level
      // (shows a friendly "not available" state rather than a 404/blank
      // page if a permission-holder clicks through before the club
      // owner or platform has turned it on).
      { to: '/app/shop', labelKey: 'nav.shop', icon: ShoppingCart, domain: 'shop' },
      { to: '/app/finance', labelKey: 'nav.finance', icon: Receipt, domain: 'finance' },
    ],
  },
  {
    titleKey: null,
    items: [
      { to: '/app/reports', labelKey: 'nav.reports', icon: BarChart3, domain: 'reports' },
      // IA restructuring (Phase 8): WhatsApp promoted to an independent
      // top-level sidebar item -- previously reachable only via
      // Settings' "الإشعارات" section, now has a real nav presence
      // matching the directive's "independent but connected module"
      // instruction.
      { to: '/app/whatsapp', labelKey: 'nav.whatsapp', icon: MessageCircle, domain: 'whatsapp' },
      { to: '/app/staff', labelKey: 'nav.staff', icon: UserCog, domain: 'staff' },
      // Master IA/UX audit (permission-model drift-risk phase): /app/fields
      // and /app/audit-log both already had real routes and a MorePage
      // (mobile "More") entry, but were entirely absent from this desktop
      // sidebar -- reachable on mobile, invisible on desktop for the exact
      // same role. Added here with MorePage's own domain gating ('settings')
      // so desktop and mobile now agree on who sees them.
      { to: '/app/fields', labelKey: 'nav.fields', icon: Building2, domain: 'settings' },
      { to: '/app/audit-log', labelKey: 'nav.auditLog', icon: ShieldCheck, domain: 'settings' },
      { to: '/app/settings', labelKey: 'nav.settings', icon: Settings, domain: 'settings' },
    ],
  },
]

const mobileNavItems: NavItem[] = [
  { to: '/app', labelKey: 'nav.today', icon: LayoutDashboard, domain: 'today' },
  { to: '/app/bookings', labelKey: 'nav.bookings', icon: CalendarDays, domain: 'bookings' },
  { to: '/scan', labelKey: 'nav.scan', icon: ScanLine, domain: 'scan' },
  { to: '/app/academy', labelKey: 'nav.academy', icon: GraduationCap, domain: 'academy' },
  { to: '/app/more', labelKey: 'nav.more', icon: MoreHorizontal, domain: 'today' },
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
  const { t, i18n } = useTranslation()
  const { memberships, currentMembership, currentClubId, setCurrentClubId, signOut, supportSession, refreshSupportSession } = useAuth()
  const isEnglish = i18n.language === 'en'
  const location = useLocation()

  // MASTER ADMIN / PLATFORM SUPPORT CONTEXT: re-verify against the
  // server on every route change while support mode is active, so a
  // session that expired (or was ended in another tab) mid-use never
  // leaves a stale "you have access" banner/state -- directive Section
  // 15's "never trust localStorage alone" applies continuously, not just
  // at mount.
  useEffect(() => {
    if (supportSession) void refreshSupportSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname])
  const { data: subSummary } = useQuery({
    queryKey: ['app-subscription-summary', currentClubId],
    queryFn: () => fetchSubscriptionSummary(currentClubId!),
    enabled: !!currentClubId,
  })
  // HIGH-ROI UX PASS 01, supplementary item 3 (Pending Payments live
  // badge) + item 9 (English club switcher, design audit finding: the
  // switcher always showed clubNameAr/roleNameAr even in English mode
  // despite clubName/roleName -- the real English values -- already
  // being fetched by AuthProvider and simply never used here).
  const { data: pendingPaymentsCount = 0 } = usePendingPaymentsCount()

  const daysRemaining = subSummary?.end_at
    ? Math.ceil((new Date(subSummary.end_at).getTime() - Date.now()) / (24 * 60 * 60 * 1000))
    : null

  const visibleNavSections = navSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => canSeeNavDomain(currentMembership?.permissionKeys, item.domain)),
    }))
    .filter((section) => section.items.length > 0)
  const visibleMobileNavItems = mobileNavItems.filter((item) => canSeeNavDomain(currentMembership?.permissionKeys, item.domain))

  return (
    <div className="flex min-h-screen flex-col bg-page-bg">
      {/* MASTER ADMIN / PLATFORM SUPPORT CONTEXT: full-width, above
          everything else -- directive Section 4/19 requires this banner
          to be persistent across every /app page and never mistakable
          for a normal club session. Placed above the sidebar+content
          row (not inside `main`) so it can never scroll out of view
          alongside page content and never competes with the sidebar's
          own fixed width. */}
      <MasterAdminBanner />
      <div className="flex min-h-0 flex-1">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 border-e border-border bg-dark-base text-white md:flex md:flex-col">
        <div className="px-4 py-5 text-lg font-bold">ملعبي | Mal3aby</div>

        {memberships.length > 0 && (
          <div className="px-2 pb-3">
            <select
              className="w-full rounded-md border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white"
              value={currentMembership?.clubId ?? ''}
              onChange={(e) => setCurrentClubId(e.target.value)}
            >
              {memberships.map((m) => (
                <option key={m.clubId} value={m.clubId} className="text-black">
                  {isEnglish ? (m.clubName || m.clubNameAr) : m.clubNameAr}
                </option>
              ))}
            </select>
            {currentMembership && (
              <p className="mt-1 px-1 text-xs text-white/50">
                {isEnglish ? (currentMembership.roleName || currentMembership.roleNameAr) : currentMembership.roleNameAr}
              </p>
            )}
          </div>
        )}

        <nav className="flex flex-1 flex-col gap-4 px-2">
          {visibleNavSections.map((section, i) => (
            <div key={section.titleKey ?? `section-${i}`} className="flex flex-col gap-1">
              {section.titleKey && (
                <p className="px-3 pb-1 text-xs font-semibold text-white/40">{t(section.titleKey)}</p>
              )}
              {section.items.map((item) => (
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
                  <span className="flex-1">{t(item.labelKey)}</span>
                  {item.to === '/app/finance' && pendingPaymentsCount > 0 && (
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-status-warning text-[11px] font-semibold text-white">
                      {pendingPaymentsCount}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
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

      {/* min-w-0 fix (real mobile bug found via live QA browser E2E, MASTER
          OPERATIONAL SIMPLIFICATION DIRECTIVE section 38): a flex child
          with no explicit min-width defaults to min-width:auto, which
          means it refuses to shrink below its content's intrinsic width.
          Any wide content deep inside main (a data table with many
          columns, in this case Cash Shift's history table) was pushing
          this whole column -- and with it the entire page body -- to
          ~1100px wide on a 375px viewport, causing horizontal overflow
          site-wide on mobile. The table's own overflow-x-auto wrapper
          was correct and did its job; the bug was one level up, this
          flex container never letting the page shrink to the viewport
          in the first place. */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top bar: mobile shows brand, desktop shows Global Search */}
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-4 md:hidden">
          <span className="font-bold text-text-primary">ملعبي | Mal3aby</span>
          <LanguageSwitcher />
        </header>
        <header className="hidden h-14 items-center gap-4 border-b border-border bg-surface px-4 md:flex">
          <GlobalSearch />
          <QuickActionsPalette />
          <LanguageSwitcher className="ms-auto" />
        </header>

        {subSummary?.subscription_kind === 'trial' && subSummary.effective_access === 'full' && (
          <div className="flex items-center justify-between gap-3 bg-status-info/10 px-4 py-2 text-sm text-status-info">
            <span>{t('appShell.trialEnding', { days: daysRemaining })}</span>
            <NavLink to="/app/subscription" className="font-medium hover:underline">
              {t('appShell.viewSubscription')}
            </NavLink>
          </div>
        )}
        {subSummary?.effective_access === 'blocked' && (
          <div className="flex items-center justify-between gap-3 bg-status-danger/10 px-4 py-2 text-sm text-status-danger">
            <span>
              {subSummary.subscription_kind === 'trial'
                ? t('appShell.trialExpired')
                : t('appShell.subscriptionExpired')}
            </span>
            <NavLink to="/app/subscription" className="font-medium hover:underline">
              {t('appShell.viewSubscription')}
            </NavLink>
          </div>
        )}
        {subSummary?.effective_access === 'grace' && (
          <div className="flex items-center justify-between gap-3 bg-status-warning/10 px-4 py-2 text-sm text-status-warning">
            <span>{t('appShell.subscriptionGrace')}</span>
            <NavLink to="/app/subscription" className="font-medium hover:underline">
              {t('appShell.viewSubscription')}
            </NavLink>
          </div>
        )}

        <main className="flex-1 p-4 pb-20 md:pb-4">
          <Suspense fallback={<RouteLoadingFallback />}>
            <Outlet />
          </Suspense>
        </main>

        {/* Mobile bottom nav */}
        <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border bg-surface md:hidden">
          {visibleMobileNavItems.map((item) => (
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
              <span className="relative">
                <item.icon className={cn('size-5', item.to === '/scan' && 'size-6 text-status-success')} />
                {item.to === '/app/more' && pendingPaymentsCount > 0 && (
                  <span className="absolute -end-1.5 -top-1 flex size-2.5 items-center justify-center rounded-full bg-status-warning" />
                )}
              </span>
              {t(item.labelKey)}
            </NavLink>
          ))}
        </nav>
      </div>
      </div>
    </div>
  )
}
