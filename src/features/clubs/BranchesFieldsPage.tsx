import { useTranslation } from 'react-i18next'
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
  const { t } = useTranslation()
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={t('clubs.branchesFieldsPage.title')}
        description={t('clubs.branchesFieldsPage.description')}
      />

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">{t('clubs.branchesFieldsPage.branchesHeading')}</h2>
        <BranchesCard />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-sm font-semibold text-text-secondary">{t('clubs.branchesFieldsPage.fieldsHeading')}</h2>
        <FieldsManagement />
      </section>
    </div>
  )
}
