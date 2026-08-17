import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Users, Receipt, Wallet, BarChart3, UserCog, Settings, ChevronRight, CircleDollarSign, Building2, ShieldCheck, MessageCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '@/app/providers/AuthProvider'
import { canSeeNavDomain, type NavDomain } from '@/lib/domain/navigation'

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
  label: string
  description: string
  icon: LucideIcon
  domain: NavDomain
}

const ITEMS: MoreItem[] = [
  { to: '/app/customers', label: 'العملاء', description: 'البحث عن العملاء وإدارة بياناتهم', icon: Users, domain: 'customers' },
  { to: '/app/billing', label: 'الفواتير والمدفوعات', description: 'سجل الفواتير والمدفوعات والمستحقات', icon: Receipt, domain: 'finance' },
  { to: '/app/outstanding', label: 'المستحقات', description: 'الفواتير غير المسددة بالكامل', icon: CircleDollarSign, domain: 'finance' },
  { to: '/app/cash-shift', label: 'وردية النقدية', description: 'فتح وإغلاق وردية الصندوق النقدي', icon: Wallet, domain: 'finance' },
  { to: '/app/reports', label: 'التقارير', description: 'تقارير الإيرادات والإشغال والأكاديمية', icon: BarChart3, domain: 'reports' },
  { to: '/app/fields', label: 'الفروع والملاعب', description: 'فروع النادي، الملاعب، مواعيد العمل، والأسعار', icon: Building2, domain: 'settings' },
  { to: '/app/whatsapp', label: 'واتساب', description: 'الاتصال، النشاط، وضوابط الإرسال', icon: MessageCircle, domain: 'whatsapp' },
  { to: '/app/staff', label: 'الموظفون', description: 'إدارة الموظفين وأدوارهم', icon: UserCog, domain: 'staff' },
  { to: '/app/audit-log', label: 'سجل التدقيق', description: 'سجل كل العمليات الحساسة في النادي', icon: ShieldCheck, domain: 'settings' },
  { to: '/app/settings', label: 'الإعدادات', description: 'هوية النادي، الأكاديمية، المدفوعات، والاشتراك', icon: Settings, domain: 'settings' },
]

export function MorePage() {
  const { currentMembership } = useAuth()
  const visibleItems = ITEMS.filter((item) => canSeeNavDomain(currentMembership?.roleKey, item.domain))

  return (
    <div>
      <PageHeader title="المزيد" />
      <div className="flex flex-col gap-2">
        {visibleItems.map((item) => (
          <Link key={item.to} to={item.to}>
            <Card className="transition hover:bg-muted/40">
              <CardContent className="flex items-center gap-3 p-4">
                <item.icon className="size-5 shrink-0 text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{item.label}</p>
                  <p className="truncate text-sm text-text-secondary">{item.description}</p>
                </div>
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
