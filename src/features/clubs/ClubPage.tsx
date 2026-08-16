import { PageHeader } from '@/components/ui/page-header'
import { PlatformSubscriptionCard } from '@/features/clubs/PlatformSubscriptionCard'
import { ClubSettingsCard } from '@/features/clubs/ClubSettingsCard'
import { FieldsManagement } from '@/features/clubs/FieldsManagement'

// V1 Implementation Gap Audit (2026-08-16): docs/SCREEN_MAP.md specs
// "Club/Branch Settings | clubs | Desktop | Club Owner" as a locked V1
// screen -- ClubSettingsCard closes that gap (club name/currency/timezone
// + first branch name/address/phone). PlatformSubscriptionCard (Phase 3b)
// and FieldsManagement (Phase 5 -- fields/operating-hours/pricing has no
// dedicated /app/fields route in SCREEN_MAP.md, only a permission-table
// route group) both continue to live here.
export function ClubPage() {
  return (
    <div>
      <PageHeader title="النادي" description="إعدادات النادي وحالة الاشتراك والملاعب" />
      <div className="grid gap-4 md:grid-cols-2">
        <PlatformSubscriptionCard />
        <ClubSettingsCard />
      </div>
      <div className="mt-4">
        <FieldsManagement />
      </div>
    </div>
  )
}
