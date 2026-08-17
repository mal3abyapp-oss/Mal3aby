import { PageHeader } from '@/components/ui/page-header'
import { BranchesCard } from '@/features/clubs/BranchesCard'
import { FieldsManagement } from '@/features/clubs/FieldsManagement'

// IA restructuring (Phase 5): "إعدادات الحجوزات" (fields/operating
// hours/pricing) was buried inside SettingsPage alongside 7 other
// unrelated administrative domains -- confirmed in
// MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md as real operational
// infrastructure management, not settings (it already had its own
// sub-dialogs for hours/pricing, large enough to be a first-class
// screen on its own). Branches moved here alongside it -- "where is
// this club's physical footprint" (branches + the fields inside them)
// is one coherent domain, matching the target IA's "الفروع والملاعب"
// grouping. Branches previously lived in Settings' "النادي" section;
// that section now covers only true club-identity settings (name,
// currency, timezone).
export function BranchesFieldsPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="الفروع والملاعب" description="فروع النادي، الملاعب، مواعيد العمل، والأسعار" />

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">الفروع</h2>
        <BranchesCard />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">الملاعب</h2>
        <FieldsManagement />
      </section>
    </div>
  )
}
