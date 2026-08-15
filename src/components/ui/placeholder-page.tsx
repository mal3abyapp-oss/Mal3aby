import { PageHeader } from '@/components/ui/page-header'

// Temporary content for routes not yet built by their owning phase.
// Removed as each phase lands real content — see docs/IMPLEMENTATION_PLAN.md.
export function PlaceholderPage({ title, phase }: { title: string; phase: string }) {
  return (
    <div>
      <PageHeader title={title} description={`سيتم بناء هذه الشاشة في ${phase}`} />
    </div>
  )
}
