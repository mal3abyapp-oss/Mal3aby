import { PageHeader } from '@/components/ui/page-header'
import { PlatformSubscriptionCard } from '@/features/clubs/PlatformSubscriptionCard'
import { FieldsManagement } from '@/features/clubs/FieldsManagement'

// Full club settings CRUD (name, branches, tax info, invoice settings)
// beyond fields/pricing is not yet built — no dedicated route/phase owns
// it explicitly. PlatformSubscriptionCard (Phase 3b) and FieldsManagement
// (Phase 5 — fields/operating-hours/pricing has no dedicated /app/fields
// route in SCREEN_MAP.md, only a permission-table route group) both live
// here.
export function ClubPage() {
  return (
    <div>
      <PageHeader title="النادي" description="إعدادات النادي وحالة الاشتراك والملاعب" />
      <div className="grid gap-4 md:grid-cols-2">
        <PlatformSubscriptionCard />
      </div>
      <div className="mt-4">
        <FieldsManagement />
      </div>
    </div>
  )
}
