import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Users, Receipt, Wallet, BarChart3, UserCog, Settings, ChevronLeft, CircleDollarSign } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

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
interface MoreItem {
  to: string
  label: string
  description: string
  icon: LucideIcon
}

const ITEMS: MoreItem[] = [
  { to: '/app/customers', label: 'العملاء', description: 'البحث عن العملاء وإدارة بياناتهم', icon: Users },
  { to: '/app/billing', label: 'الفواتير والمدفوعات', description: 'سجل الفواتير والمدفوعات والمستحقات', icon: Receipt },
  { to: '/app/outstanding', label: 'المستحقات', description: 'الفواتير غير المسددة بالكامل', icon: CircleDollarSign },
  { to: '/app/cash-shift', label: 'وردية النقدية', description: 'فتح وإغلاق وردية الصندوق النقدي', icon: Wallet },
  { to: '/app/reports', label: 'التقارير', description: 'تقارير الإيرادات والإشغال والأكاديمية', icon: BarChart3 },
  { to: '/app/staff', label: 'الموظفون', description: 'إدارة الموظفين وأدوارهم', icon: UserCog },
  { to: '/app/settings', label: 'الإعدادات', description: 'النادي والفروع والملاعب والأكاديمية', icon: Settings },
]

export function MorePage() {
  return (
    <div>
      <PageHeader title="المزيد" />
      <div className="flex flex-col gap-2">
        {ITEMS.map((item) => (
          <Link key={item.to} to={item.to}>
            <Card className="transition hover:bg-muted/40">
              <CardContent className="flex items-center gap-3 p-4">
                <item.icon className="size-5 shrink-0 text-text-secondary" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{item.label}</p>
                  <p className="truncate text-sm text-text-secondary">{item.description}</p>
                </div>
                <ChevronLeft className="size-4 shrink-0 text-text-secondary" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  )
}
