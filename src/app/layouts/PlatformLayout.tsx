import { Suspense, useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
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
  Menu,
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

function PlatformNavList({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const { isPlatformOwner, platformPermissionKeys } = useAuth()
  const permissionSet = new Set(platformPermissionKeys)
  // A real platform_owner always sees the full nav, exactly as before
  // this change -- least-privilege filtering only ever applies to a
  // staff caller (isPlatformOwner === false, isPlatformStaff === true,
  // per RequirePlatformOwner already having required one or the other
  // to reach this shell at all).
  const canSee = (item: NavItem) =>
    isPlatformOwner || !item.requiredPermissions || item.requiredPermissions.some((key) => permissionSet.has(key))
  return (
    <nav className="flex flex-1 flex-col gap-4 px-2">
      {navSections.map((section, i) => {
        const visibleItems = section.items.filter(canSee)
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
  // Owner-level review finding (P1): this shell's sidebar was
  // `hidden ... md:flex` with NO mobile fallback at all -- below the
  // md breakpoint (768px) a Platform Owner had literally zero way to
  // navigate away from whichever page they landed on (no bottom nav,
  // no hamburger, nothing), unlike AppLayout which has always had a
  // mobile bottom nav. Fixed with a hamburger + slide-in Sheet reusing
  // the exact same navSections/NavLink markup as the desktop sidebar
  // (no navigation model duplicated, just presented in two containers).
  const { t } = useTranslation()
  const { signOut } = useAuth()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

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
        <header className="flex h-14 items-center justify-between border-b border-border bg-surface px-4 md:hidden">
          <span className="font-bold text-text-primary">Mal3aby — Platform</span>
          <div className="flex items-center gap-2">
            <LanguageSwitcher />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('platform.openNavAria')}
              onClick={() => setMobileNavOpen(true)}
            >
              <Menu className="size-5" />
            </Button>
          </div>
        </header>
        {/* PERSONA COUNCIL AUDIT (2026-08-25) -- Platform Owner persona
            finding: this shell had no cross-page search entry point at
            all, unlike AppLayout's own desktop header (mirrors that
            same layout: a dedicated bar, desktop-only, above main). */}
        <header className="hidden h-14 items-center gap-4 border-b border-border bg-surface px-4 md:flex">
          <PlatformGlobalSearch />
        </header>
        <main className="min-w-0 flex-1 p-4">
          <Suspense fallback={<RouteLoadingFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>

      <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
        {/* Master IA/UX audit (RTL phase): sheet.tsx's `side` variant is
            now direction-aware (logical CSS under the hood) -- "right"
            means "the reading-start edge" in both RTL and LTR, matching
            the sidebar's own `border-e` direction-awareness, so this
            stays correct if a user toggles to English. */}
        <SheetContent side="right" className="flex w-64 flex-col bg-dark-secondary p-0 text-white">
          <SheetTitle className="px-4 py-5 text-lg font-bold text-white">Mal3aby — Platform</SheetTitle>
          <PlatformNavList onNavigate={() => setMobileNavOpen(false)} />
          <button
            onClick={() => void signOut()}
            className="flex items-center gap-3 border-t border-white/10 px-5 py-4 text-sm font-medium text-white/60 hover:text-white"
          >
            <LogOut className="size-4" />
            {t('nav.logout')}
          </button>
        </SheetContent>
      </Sheet>
    </div>
  )
}
