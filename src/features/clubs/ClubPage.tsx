import { PageHeader } from '@/components/ui/page-header'
import { PlatformSubscriptionCard } from '@/features/clubs/PlatformSubscriptionCard'

// Full club settings CRUD (name, branches, tax info, invoice settings) is
// not yet built — a real owning phase for that isn't explicitly scheduled
// as its own item in IMPLEMENTATION_PLAN.md beyond what Phase 2/5 already
// cover incidentally; the PlatformSubscriptionCard here is the concrete
// Phase 3b frontend deliverable ("a minimal Club Settings 'Platform
// Subscription' read-only summary card only").
export function ClubPage() {
  return (
    <div>
      <PageHeader title="النادي" description="إعدادات النادي وحالة الاشتراك" />
      <div className="grid gap-4 md:grid-cols-2">
        <PlatformSubscriptionCard />
      </div>
    </div>
  )
}
