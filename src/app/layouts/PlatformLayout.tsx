import { Suspense, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { LanguageSwitcher } from '@/components/ui/language-switcher'
import { useAuth } from '@/app/providers/AuthProvider'
import { RouteLoadingFallback } from '@/app/routing/RouteLoadingFallback'
import { PlatformGlobalSearch } from '@/features/platform/PlatformGlobalSearch'
import {
  LayoutDashboard,
  Building2,
  Users,
  Sparkles,
  Inbox,
  BarChart3,
  Bell,
  Award,
  ShieldCheck,
  Settings,
  LogOut,
  UserCog,
  KeyRound,
  History,
  Radar,
  ListChecks,
  Kanban,
  Megaphone,
  CalendarClock,
  SlidersHorizontal,
  MessageCircle,
  MoreHorizontal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

// Platform Owner console shell — fully separate from AppLayout, never
// merged navigation. See docs/ARCHITECTURE.md#public-website--layout-strategy,
// docs/SCREEN_MAP.md Platform Owner Navigation.
//
// IA restructuring (Phase 4): confirmed in
// MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md -- 13 flat nav items, 4 of
// them permanent placeholder dead-ends interleaved with real screens,
// no grouping, icon reuse (Sparkles used for both Plans and Trials),
// zero live signal despite Overview already computing exactly the
// counts a badge would show. Fixed per the target IA §1: 3 of the 4
// placeholders are now redirects (their sidebar entries removed
// entirely, not just hidden -- their content lives on real screens
// linked from Overview/Reports/Alerts instead); the 4th
// (Settings) is now a real screen. Remaining 10 real items grouped
// into 4 sections instead of one flat list. Trials' icon changed to
// Award (was duplicating Plans' Sparkles).
interface NavItem {
  to: string
  labelKey: string
  icon: LucideIcon
  // PLATFORM STAFF AUTH FIX (Control Plane V1, Phase 1): least-privilege
  // nav visibility for the newly-reachable platform-staff tier. `null`
  // means "always visible to anyone who can reach this console" (a real
  // platform_owner, or any staff role at all) -- used only for items
  // with no meaningful staff-permission boundary (Overview itself).
  // Otherwise, the item is hidden from a staff caller unless they hold
  // at least one of the listed platform_permissions.key values -- a
  // real platform_owner always passes (isPlatformOwner short-circuits
  // the check entirely, see requiresPermission below), so this can only
  // ever narrow a STAFF caller's nav, never the owner's.
  requiredPermissions: string[] | null
}

interface NavSection {
  titleKey: string | null
  items: NavItem[]
}

const navSections: NavSection[] = [
  {
    titleKey: null,
    items: [{ to: '/platform', labelKey: 'platform.nav.overview', icon: LayoutDashboard, requiredPermissions: null }],
  },
  {
    titleKey: 'platform.nav.sectionClubs',
    items: [
      { to: '/platform/clubs', labelKey: 'platform.nav.allClubs', icon: Building2, requiredPermissions: ['platform.club.view'] },
      { to: '/platform/owners', labelKey: 'platform.nav.clubOwners', icon: Users, requiredPermissions: ['platform.club.view'] },
    ],
  },
  {
    titleKey: 'platform.nav.sectionCommerce',
    items: [
      { to: '/platform/plans', labelKey: 'platform.nav.plans', icon: Sparkles, requiredPermissions: ['platform.finance.view', 'platform.finance.manage'] },
      { to: '/platform/leads', labelKey: 'platform.nav.leads', icon: Inbox, requiredPermissions: ['platform.club.view'] },
    ],
  },
  {
    titleKey: 'platform.nav.sectionMonitoring',
    items: [
      { to: '/platform/reports', labelKey: 'platform.nav.reports', icon: BarChart3, requiredPermissions: ['platform.finance.view'] },
      { to: '/platform/alerts', labelKey: 'platform.nav.alerts', icon: Bell, requiredPermissions: ['platform.club.view'] },
      { to: '/platform/whatsapp', labelKey: 'platform.nav.platformWhatsapp', icon: MessageCircle, requiredPermissions: ['platform.whatsapp_platform.manage'] },
      { to: '/platform/trials', labelKey: 'platform.nav.trials', icon: Award, requiredPermissions: ['platform.subscription.view'] },
      { to: '/platform/audit', labelKey: 'platform.nav.auditLog', icon: ShieldCheck, requiredPermissions: ['platform.audit.view'] },
      // PLATFORM OWNER AUTONOMOUS COMPLETION -- Phase E (2026-08-29):
      // directive Section 22, a practical read-only support session
      // history screen. Grouped with Audit Log -- both are
      // read-only historical logs of privileged platform actions.
      { to: '/platform/support-history', labelKey: 'platform.nav.supportHistory', icon: History, requiredPermissions: ['platform.audit.view', 'platform.support.start_view', 'platform.support.start_manage'] },
    ],
  },
  // PLATFORM STAFF + PLATFORM ROLES & PERMISSIONS (2026-08-26) -- a
  // genuine SECOND authorization domain from Club Staff/Roles (directive
  // Section 1: "Do not mix club roles with platform roles"), so it gets
  // its own nav section rather than being folded into an existing one.
  {
    titleKey: 'platform.nav.sectionStaffAccess',
    items: [
      { to: '/platform/staff', labelKey: 'platform.nav.platformStaff', icon: UserCog, requiredPermissions: ['platform.staff.view'] },
      { to: '/platform/roles', labelKey: 'platform.nav.platformRoles', icon: KeyRound, requiredPermissions: ['platform.role.view'] },
    ],
  },
  // Sales Intelligence (ADR-054, 2026-09-04) -- its own nav section,
  // matching the same "genuinely separate bounded context gets its own
  // section" convention already used for Staff & Access above. No
  // dedicated platform_permissions keys exist yet for Sales Intelligence
  // specifically (it predates/sits outside the platform_staff_memberships
  // permission catalog) -- scoped to platform.club.view as the closest
  // real, already-seeded permission a "can see tenant-facing commercial
  // activity" staff member would hold, rather than inventing a new
  // permission key unilaterally (a genuine product decision, flagged in
  // FINAL_OWNER_DECISIONS_REQUIRED.md).
  {
    titleKey: 'platform.nav.sectionSalesIntelligence',
    items: [
      { to: '/platform/sales', labelKey: 'platform.nav.salesDashboard', icon: Radar, requiredPermissions: ['platform.club.view'] },
      { to: '/platform/sales/discover', labelKey: 'platform.nav.salesDiscover', icon: Sparkles, requiredPermissions: ['platform.club.view'] },
      { to: '/platform/sales/leads', labelKey: 'platform.nav.salesLeads', icon: ListChecks, requiredPermissions: ['platform.club.view'] },
      { to: '/platform/sales/pipeline', labelKey: 'platform.nav.salesPipeline', icon: Kanban, requiredPermissions: ['platform.club.view'] },
      { to: '/platform/sales/campaigns', labelKey: 'platform.nav.salesCampaigns', icon: Megaphone, requiredPermissions: ['platform.club.view'] },
      { to: '/platform/sales/followups', labelKey: 'platform.nav.salesFollowups', icon: CalendarClock, requiredPermissions: ['platform.club.view'] },
      { to: '/platform/sales/settings', labelKey: 'platform.nav.salesSettings', icon: SlidersHorizontal, requiredPermissions: ['platform.settings.manage'] },
    ],
  },
  {
    titleKey: null,
    items: [{ to: '/platform/settings', labelKey: 'platform.nav.settings', icon: Settings, requiredPermissions: ['platform.settings.view', 'platform.settings.manage'] }],
  },
]

const allNavItems = navSections.flatMap((section) => section.items)
const mobilePrimaryPaths = new Set(['/platform', '/platform/clubs', '/platform/sales', '/platform/alerts'])
const mobilePrimaryNavItems = [...mobilePrimaryPaths]
  .map((path) => allNavItems.find((item) => item.to === path))
  .filter((item): item is NavItem => Boolean(item))

function canSeePlatformNavItem(item: NavItem, isPlatformOwner: boolean, permissionSet: ReadonlySet<string>) {
  return isPlatformOwner || !item.requiredPermissions || item.requiredPermissions.some((key) => permissionSet.has(key))
}

function PlatformNavList({ onNavigate, excludePaths }: { onNavigate?: () => void; excludePaths?: ReadonlySet<string> }) {
  const { t } = useTranslation()
  const { isPlatformOwner, platformPermissionKeys } = useAuth()
  const permissionSet = new Set(platformPermissionKeys)

  return (
    <nav className="flex flex-1 flex-col gap-4 px-2">
      {navSections.map((section, i) => {
        const visibleItems = section.items
          .filter((item) => canSeePlatformNavItem(item, isPlatformOwner, permissionSet))
          .filter((item) => !excludePaths?.has(item.to))
        if (visibleItems.length === 0) return null
        return (
          <div key={section.titleKey ?? `section-${i}`} className="flex flex-col gap-1">
            {section.titleKey && (
              <h2 className="px-3 pb-1 text-xs font-semibold text-white/40">{t(section.titleKey)}</h2>
            )}
            {visibleItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/platform' || item.to === '/platform/sales'}
                onClick={onNavigate}
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
          </div>
        )
      })}
    </nav>
  )
}

export function PlatformLayout() {
  const { t } = useTranslation()
  const location = useLocation()
  const { signOut, isPlatformOwner, platformPermissionKeys } = useAuth()
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false)
  const permissionSet = new Set(platformPermissionKeys)
  const visibleMobilePrimaryItems = mobilePrimaryNavItems.filter((item) =>
    canSeePlatformNavItem(item, isPlatformOwner, permissionSet),
  )

  const isPrimaryRouteActive = (item: NavItem) => {
    if (item.to === '/platform') return location.pathname === '/platform'
    if (item.to === '/platform/clubs') {
      return location.pathname === '/platform/clubs' || location.pathname.startsWith('/platform/clubs/')
    }
    return location.pathname === item.to
  }
  const isMoreActive = !visibleMobilePrimaryItems.some(isPrimaryRouteActive)

  return (
    <div className="flex min-h-screen bg-page-bg">
      <aside className="hidden w-64 shrink-0 border-e border-border bg-dark-secondary text-white md:flex md:flex-col">
        <div className="px-4 py-5">
          <p className="text-lg font-bold">Mal3aby</p>
          <p className="text-xs text-white/50">Platform Owner Console</p>
        </div>
        <PlatformNavList />
        {/* Master IA/UX audit (RTL sweep phase): confirmed a real gap --
            AppLayout (club side), PortalLayout, and PublicLayout all
            have a LanguageSwitcher; PlatformLayout was the only shell
            missing one entirely, leaving Platform Owner users with no
            in-UI way to switch to English at all. Same placement
            pattern as AppLayout's sidebar footer. */}
        <div className="flex items-center justify-between border-t border-white/10 px-5 py-3">
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

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Mobile header remains intentionally light: primary navigation
            lives in the persistent bottom bar below. */}
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-4 md:hidden">
          <span className="font-bold text-text-primary">Mal3aby — Platform</span>
          <LanguageSwitcher />
        </header>
        {/* PERSONA COUNCIL AUDIT (2026-08-25) -- Platform Owner persona
            finding: this shell had no cross-page search entry point at
            all, unlike AppLayout's own desktop header (mirrors that
            same layout: a dedicated bar, desktop-only, above main). */}
        <header className="hidden h-14 items-center gap-4 border-b border-border bg-surface px-4 md:flex">
          <PlatformGlobalSearch />
        </header>
        <main className="min-w-0 flex-1 p-4 pb-[calc(6rem+env(safe-area-inset-bottom))] md:pb-4">
          <Suspense fallback={<RouteLoadingFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      {/* Mobile Platform navigation intentionally mirrors the proven
          AppLayout pattern: a small set of high-frequency destinations
          is always one tap away, and every other existing destination
          remains available under More. navSections stays the single
          source of truth for routes and permissions. */}
      <nav
        aria-label={t('nav.mobileNavAria')}
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="mx-auto flex max-w-lg items-stretch">
          {visibleMobilePrimaryItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to !== '/platform/clubs'}
              className={({ isActive }) =>
                cn(
                  'flex min-h-16 flex-1 flex-col items-center justify-center gap-1 px-1 py-2 text-center text-[11px] font-medium text-text-secondary transition-colors',
                  isActive && 'bg-accent/10 text-accent-foreground',
                )
              }
            >
              <item.icon className="size-5" />
              <span className="max-w-full truncate">{t(item.labelKey)}</span>
            </NavLink>
          ))}
          <button
            type="button"
            aria-label={t('nav.more')}
            aria-expanded={mobileMoreOpen}
            onClick={() => setMobileMoreOpen(true)}
            className={cn(
              'flex min-h-16 flex-1 flex-col items-center justify-center gap-1 px-1 py-2 text-center text-[11px] font-medium text-text-secondary transition-colors',
              (mobileMoreOpen || isMoreActive) && 'bg-accent/10 text-accent-foreground',
            )}
          >
            <MoreHorizontal className="size-5" />
            <span className="max-w-full truncate">{t('nav.more')}</span>
          </button>
        </div>
      </nav>

      <Sheet open={mobileMoreOpen} onOpenChange={setMobileMoreOpen}>
        <SheetContent
          side="bottom"
          className="flex max-h-[85dvh] flex-col gap-0 rounded-t-2xl border-t border-border bg-dark-secondary p-0 text-white md:hidden"
        >
          <div className="shrink-0 border-b border-white/10 px-4 py-4">
            <SheetTitle className="text-lg font-bold text-white">{t('nav.more')}</SheetTitle>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3">
            <PlatformNavList onNavigate={() => setMobileMoreOpen(false)} excludePaths={mobilePrimaryPaths} />
          </div>
          <div
            className="shrink-0 border-t border-white/10 px-2 pt-2"
            style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
          >
            <button
              onClick={() => void signOut()}
              className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              <LogOut className="size-4" />
              {t('nav.logout')}
            </button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  )
}
