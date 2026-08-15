import { PageHeader } from '@/components/ui/page-header'

// Content for routes intentionally deferred past V1 (see each call site's
// own comment for why — e.g. src/features/platform/pages.tsx). `note`
// should state the real reason (deferred / duplicates existing data),
// never imply a specific future phase will build it — corrected during
// the Final Release Gate (2026-08-15) after PlatformSettingsPage and
// friends were found rendering a stale "will be built in Phase 3c" claim
// for a phase that had already completed without building them.
export function PlaceholderPage({ title, note }: { title: string; note: string }) {
  return (
    <div>
      <PageHeader title={title} description={note} />
    </div>
  )
}
