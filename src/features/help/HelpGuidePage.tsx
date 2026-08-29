import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  CalendarDays,
  GraduationCap,
  IdCard,
  ShoppingCart,
  Receipt,
  BarChart3,
  MessageCircle,
  ScanLine,
  UserCog,
  ShieldCheck,
  Settings,
  LayoutDashboard,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react'

// "شرح الأداة" / How-to-use guide (last pre-launch request, 2026-08-29):
// user asked for an in-app tab explaining the tool with real
// screenshots, after I stated the real capability boundary (no screen-
// recording tool available in this environment -- static screenshots
// only). User picked "written tab + real screenshots" over the video-
// script-only and both-combined alternatives.
//
// Deliberately NOT gated by canSeeNavDomain/NavDomain -- this is
// reference/onboarding content, not a data screen with a permission
// boundary. Every authenticated club member (any role) can open it,
// same treatment as 'today'. Screenshots are real captures from a
// dedicated QA test club (public/help/*.png), not mockups/illustrations.
interface HelpModule {
  key: string
  icon: LucideIcon
  // Each step is a short instruction; stepsKey resolves to an array in
  // i18n (help.modules.<key>.steps), same pattern as howItWorksSteps on
  // the public HomePage.
  screenshot?: string
}

const MODULES: HelpModule[] = [
  { key: 'today', icon: LayoutDashboard, screenshot: '/help/today.png' },
  { key: 'bookings', icon: CalendarDays, screenshot: '/help/bookings.png' },
  { key: 'customers', icon: UserCog, screenshot: '/help/customer-360.png' },
  { key: 'academy', icon: GraduationCap, screenshot: '/help/academy.png' },
  { key: 'memberships', icon: IdCard, screenshot: '/help/memberships.png' },
  { key: 'shop', icon: ShoppingCart, screenshot: '/help/shop-pos.png' },
  { key: 'finance', icon: Receipt, screenshot: '/help/finance-overview.png' },
  { key: 'reports', icon: BarChart3, screenshot: '/help/reports.png' },
  { key: 'whatsapp', icon: MessageCircle, screenshot: '/help/whatsapp.png' },
  // No screenshot: /scan requires real camera access, which the QA
  // capture environment cannot grant -- steps-only for this module
  // rather than shipping a broken image link.
  { key: 'scan', icon: ScanLine },
  { key: 'staff', icon: UserCog, screenshot: '/help/staff.png' },
  { key: 'auditLog', icon: ShieldCheck, screenshot: '/help/audit-log.png' },
  { key: 'settings', icon: Settings, screenshot: '/help/settings.png' },
]

export function HelpGuidePage() {
  const { t } = useTranslation()
  const [activeKey, setActiveKey] = useState(MODULES[0].key)
  const active = MODULES.find((m) => m.key === activeKey) ?? MODULES[0]
  const steps = t(`help.modules.${active.key}.steps`, { returnObjects: true }) as string[]

  return (
    <div>
      <PageHeader title={t('help.title')} description={t('help.subtitle')} />

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        {/* Module list -- horizontal scroll strip on mobile, vertical
            side rail on desktop (same responsive shape as FinanceNav's
            sub-tabs, but kept as plain buttons since this list is much
            longer and works better as a two-pane master/detail here). */}
        <div className="flex gap-2 overflow-x-auto pb-1 lg:w-64 lg:shrink-0 lg:flex-col lg:overflow-visible lg:pb-0">
          {MODULES.map((mod) => (
            <button
              key={mod.key}
              type="button"
              onClick={() => setActiveKey(mod.key)}
              className={cn(
                'flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-start text-sm font-medium transition lg:shrink lg:w-full',
                mod.key === activeKey
                  ? 'border-accent bg-accent/10 text-text-primary'
                  : 'border-border bg-card text-text-secondary hover:bg-muted/40'
              )}
            >
              <mod.icon className="size-4 shrink-0" />
              <span className="whitespace-nowrap lg:whitespace-normal">{t(`help.modules.${mod.key}.title`)}</span>
              <ChevronRight className="ms-auto hidden size-4 shrink-0 opacity-50 lg:block rtl:rotate-180" />
            </button>
          ))}
        </div>

        {/* Content pane */}
        <Card className="flex-1">
          <CardContent className="p-5">
            <h2 className="text-lg font-bold text-text-primary">{t(`help.modules.${active.key}.title`)}</h2>
            <p className="mt-1 text-sm text-text-secondary">{t(`help.modules.${active.key}.summary`)}</p>

            {active.screenshot && (
              <div className="mt-4 overflow-hidden rounded-lg border border-border bg-muted/20">
                <img
                  src={active.screenshot}
                  alt={t(`help.modules.${active.key}.screenshotAlt`)}
                  className="w-full"
                  loading="lazy"
                />
              </div>
            )}

            <ol className="mt-5 flex flex-col gap-3">
              {Array.isArray(steps) &&
                steps.map((step, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-dark-base text-xs font-bold text-white">
                      {i + 1}
                    </span>
                    <span className="pt-0.5 text-sm text-text-primary">{step}</span>
                  </li>
                ))}
            </ol>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
