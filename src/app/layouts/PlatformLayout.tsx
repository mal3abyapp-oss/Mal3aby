import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
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
  label: string
  icon: LucideIcon
}

interface NavSection {
  title: string | null
  items: NavItem[]
}

const navSections: NavSection[] = [
  {
    title: null,
    items: [{ to: '/platform', label: 'نظرة عامة', icon: LayoutDashboard }],
  },
  {
    title: 'الأندية',
    items: [
      { to: '/platform/clubs', label: 'كل الأندية', icon: Building2 },
      { to: '/platform/owners', label: 'أصحاب الأندية', icon: Users },
    ],
  },
  {
    title: 'التجارة',
    items: [
      { to: '/platform/plans', label: 'الخطط', icon: Sparkles },
      { to: '/platform/leads', label: 'طلبات التواصل', icon: Inbox },
    ],
  },
  {
    title: 'المراقبة',
    items: [
      { to: '/platform/reports', label: 'التقارير', icon: BarChart3 },
      { to: '/platform/alerts', label: 'التنبيهات', icon: Bell },
      { to: '/platform/trials', label: 'التجارب المجانية', icon: Award },
      { to: '/platform/audit', label: 'سجل التدقيق', icon: ShieldCheck },
    ],
  },
  {
    title: null,
    items: [{ to: '/platform/settings', label: 'الإعدادات', icon: Settings }],
  },
]

function PlatformNavList({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="flex flex-1 flex-col gap-4 px-2">
      {navSections.map((section, i) => (
        <div key={section.title ?? `section-${i}`} className="flex flex-col gap-1">
          {section.title && (
            <p className="px-3 pb-1 text-xs font-semibold text-white/40">{section.title}</p>
          )}
          {section.items.map((item) => (
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
        </div>
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
  // the exact same navSections/NavLink markup as the desktop sidebar
  // (no navigation model duplicated, just presented in two containers).
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
        {/* Master IA/UX audit (RTL phase): sheet.tsx's `side` variant is
            now direction-aware (logical CSS under the hood) -- "right"
            means "the reading-start edge" in both RTL and LTR, matching
            the sidebar's own `border-e` direction-awareness, so this
            stays correct if a user toggles to English. */}
        <SheetContent side="right" className="flex w-64 flex-col bg-dark-secondary p-0 text-white">
          <SheetTitle className="px-4 py-5 text-lg font-bold text-white">Mala3by — Platform</SheetTitle>
          <PlatformNavList onNavigate={() => setMobileNavOpen(false)} />
        </SheetContent>
      </Sheet>
    </div>
  )
}
