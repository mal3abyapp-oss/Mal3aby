import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Users, Receipt, BarChart3, UserCog, Settings, ChevronRight, Building2, ShieldCheck, MessageCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '@/app/providers/AuthProvider'
import { canSeeNavDomain, type NavDomain } from '@/lib/domain/navigation'
import { usePendingPaymentsCount } from '@/features/billing/usePendingPaymentsCount'

// Section M: mobile bottom nav stays minimal (اليوم/الحجوزات/مسح/
// الأكاديمية) -- lower-frequency screens live behind "المزيد" instead
// of crowding the primary nav. Previously /app/more had no route at
// all (a dead link on every mobile session) -- this is the destination.
//
// IA restructuring (Phase 3): "المستحقات" (Outstanding) added --
// confirmed in MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md as a fully
// built screen with ZERO navigation entry points anywhere (not
// sidebar, not mobile nav, not here). A page whose entire purpose is
// surfacing money owed to the club was completely undiscoverable.
//
// IA restructuring (Phase 5): "الفروع والملاعب" and "سجل التدقيق" added
// -- both gained real routes (/app/fields, /app/audit-log) when they
// were extracted out of Settings, but neither had been added to this
// list yet, which would have made them just as undiscoverable on
// mobile as Outstanding was before Phase 3. Settings' description
// updated to match its narrowed scope (branches/fields/staff/audit all
// moved to their own destinations).
//
// IA restructuring (Phase 8): "واتساب" added -- gained its own route
// (/app/whatsapp) when promoted out of Settings into an independent
// top-level module; same discoverability requirement as the Phase 5
// additions above.
//
// IA restructuring (Phase 11, role-based nav visibility re-verification):
// confirmed real gap -- this list was NEVER role-filtered, unlike
// AppLayout's desktop sidebar (Phase 3) which correctly hides items a
// role has no use for. A coach or scanner account on mobile saw
// "الفواتير والمدفوعات"/"الموظفون"/"الإعدادات" etc. in "المزيد" even
// though the exact same items were already correctly hidden from them
// on desktop -- same UX-clarity class of issue Phase 3 fixed for the
// sidebar, just never applied here. Each item now carries the same
// NavDomain tag its sidebar counterpart uses and is filtered with the
// same canSeeNavDomain() helper -- one shared role->domain mapping, not
// a second one invented for mobile.
interface MoreItem {
  to: string
  labelKey: string
  descriptionKey: string
  icon: LucideIcon
  domain: NavDomain
}

const ITEMS: MoreItem[] = [
  { to: '/app/customers', labelKey: 'nav.customers', descriptionKey: 'dashboard.more.customersDesc', icon: Users, domain: 'customers' },
  { to: '/app/finance', labelKey: 'nav.finance', descriptionKey: 'dashboard.more.financeDesc', icon: Receipt, domain: 'finance' },
  { to: '/app/reports', labelKey: 'nav.reports', descriptionKey: 'dashboard.more.reportsDesc', icon: BarChart3, domain: 'reports' },
  { to: '/app/fields', labelKey: 'nav.fields', descriptionKey: 'dashboard.more.fieldsDesc', icon: Building2, domain: 'settings' },
  { to: '/app/whatsapp', labelKey: 'nav.whatsapp', descriptionKey: 'dashboard.more.whatsappDesc', icon: MessageCircle, domain: 'whatsapp' },
  { to: '/app/staff', labelKey: 'nav.staff', descriptionKey: 'dashboard.more.staffDesc', icon: UserCog, domain: 'staff' },
  { to: '/app/audit-log', labelKey: 'nav.auditLog', descriptionKey: 'dashboard.more.auditLogDesc', icon: ShieldCheck, domain: 'settings' },
  { to: '/app/settings', labelKey: 'nav.settings', descriptionKey: 'dashboard.more.settingsDesc', icon: Settings, domain: 'settings' },
]

export function MorePage() {
  const { t } = useTranslation()
  const { currentMembership } = useAuth()
  const visibleItems = ITEMS.filter((item) => canSeeNavDomain(currentMembership?.roleKey, item.domain))
  // HIGH-ROI UX PASS 01, Priority 3: a live, tenant-scoped count next to
  // "Pending Payments" -- previously a plain list row indistinguishable
  // from a low-urgency item like Cash Shift despite being a
  // time-sensitive queue (a real customer's payment-hold countdown is
  // running while a proof sits unreviewed).
  const { data: pendingPaymentsCount = 0 } = usePendingPaymentsCount()

  return (
    <div>
      <PageHeader title={t('nav.more')} />
      <div className="flex flex-col gap-2">
        {visibleItems.map((item) => (
          <Link key={item.to} to={item.to}>
            <Card className="transition hover:bg-muted/40">
              <CardContent className="flex items-center gap-3 p-4">
                <item.icon className="size-5 shrink-0 text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{t(item.labelKey)}</p>
                  <p className="truncate text-sm text-text-secondary">{t(item.descriptionKey)}</p>
                </div>
                {item.to === '/app/finance' && pendingPaymentsCount > 0 && (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-status-warning text-xs font-semibold text-white">
                    {pendingPaymentsCount}
                  </span>
                )}
                {/* Master IA/UX audit (RTL phase): base icon is the
                    LTR-correct "forward" direction (right), rtl:
                    rotate-180 flips it for RTL. Verified live in both
                    directions after an earlier version had this
                    backwards (base icon must already be LTR-correct
                    for rtl:rotate-180 to work). */}
                <ChevronRight className="size-4 shrink-0 text-text-secondary rtl:rotate-180" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
