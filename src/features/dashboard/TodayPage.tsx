import { PageHeader } from '@/components/ui/page-header'
import { PlaceholderPage } from '@/components/ui/placeholder-page'
import { FirstRunChecklist } from '@/features/dashboard/FirstRunChecklist'

// Full Reception/Manager dashboard content is Phase 9's scope. The
// First-Run Checklist is a concrete Phase 3d deliverable and doesn't
// depend on Phase 9's dashboard widgets, so it's placed here now rather
// than waiting.
export function TodayPage() {
  return (
    <div>
      <PageHeader title="اليوم" />
      <FirstRunChecklist />
      <PlaceholderPage title="لوحة التحكم اليومية" phase="Phase 9" />
    </div>
  )
}
