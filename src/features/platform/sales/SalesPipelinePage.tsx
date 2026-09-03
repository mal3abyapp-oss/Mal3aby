// SalesPipelinePage -- Sales Intelligence Phase 9 (ADR-054). Leads
// grouped by pipeline stage, matching the funnel stages already
// enforced by sales_change_lead_status()'s legal-transition guard.
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const STAGES = [
  'discovered', 'enriching', 'enriched', 'qualified', 'contact_ready', 'contacted',
  'replied', 'demo_scheduled', 'demo_completed', 'negotiation', 'won', 'lost',
]

interface LeadRow {
  lead_id: string
  business_name: string
  status: string
  current_score: number | null
}

async function fetchByStage(status: string): Promise<LeadRow[]> {
  const { data, error } = await supabase.rpc('search_sales_leads', {
    p_status: status,
    p_exclude_do_not_contact: false,
    p_limit: 20,
  })
  if (error) throw error
  return data ?? []
}

function StageColumn({ stage }: { stage: string }) {
  const { t } = useTranslation()
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['sales-pipeline-stage', stage],
    queryFn: () => fetchByStage(stage),
  })

  return (
    <Card className="min-w-64 flex-shrink-0">
      <CardHeader><CardTitle className="text-sm">{t(`platform.sales.pipeline.stage.${stage}`)} ({data?.length ?? 0})</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {isError ? (
          <ErrorState message={translateSupabaseError(error, t('platform.sales.pipeline.loadError'))} onRetry={() => refetch()} />
        ) : isLoading ? (
          <p className="text-xs text-text-secondary">{t('common.loading')}</p>
        ) : (data ?? []).length === 0 ? (
          <p className="text-xs text-text-secondary">—</p>
        ) : (
          (data ?? []).map((l) => (
            <Link
              key={l.lead_id}
              to={`/platform/sales/leads/${l.lead_id}`}
              className="block rounded-md border border-border-subtle p-2 text-sm hover:bg-surface-subtle"
            >
              {l.business_name}
              {l.current_score != null && <span className="ms-2 text-xs text-text-secondary">{l.current_score}</span>}
            </Link>
          ))
        )}
      </CardContent>
    </Card>
  )
}

export function SalesPipelinePage() {
  const { t } = useTranslation()
  return (
    <div className="space-y-6">
      <PageHeader title={t('platform.sales.pipeline.title')} description={t('platform.sales.pipeline.description')} />
      <div className="flex gap-4 overflow-x-auto pb-4">
        {STAGES.map((stage) => (
          <StageColumn key={stage} stage={stage} />
        ))}
      </div>
    </div>
  )
}
