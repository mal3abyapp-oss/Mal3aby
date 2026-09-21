// SalesPipelinePage -- Sales Intelligence Phase 9 (ADR-054). Leads
// grouped by pipeline stage, matching the funnel stages already
// enforced by sales_change_lead_status()'s legal-transition guard.
//
// KAN-1 fix (2026-09-19/20, owner brief), three real bugs confirmed
// before writing anything here:
//   1. The header count rendered data?.length -- the number of rows
//      THIS PAGE FETCHED (capped at p_limit: 20), not the real column
//      total. A column with 88 leads showed "20" forever. Fixed by
//      using search_sales_leads()'s own total_count column (already
//      returned on every row, unused by this page before this fix)
//      instead of the fetched array's own length.
//   2. STAGES was missing 'awaiting_owner_activation' and
//      'tenant_activated' -- any lead that reached those (post-
//      conversion) statuses simply had no column to appear in and
//      vanished from the board entirely, even though the dashboard's
//      own total counted them. Added both.
//   3. Score badges were rendered as raw adjacent JSX
//      ({name}{score && <span>{score}</span>}) with no separator --
//      confirmed exact match for the "Academy0" bug (a name
//      immediately followed by digits, no space). Fixed by reusing
//      SalesLeadsPage.tsx's own established StatusBadge pattern
//      instead of a bare inline <span>.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { ListLoadingSkeleton } from './ListLoadingSkeleton'

const STAGES = [
  'discovered', 'enriching', 'enriched', 'qualified', 'contact_ready', 'contacted',
  'replied', 'demo_scheduled', 'demo_completed', 'negotiation',
  'won', 'awaiting_owner_activation', 'tenant_activated', 'lost',
]

const PAGE_SIZE = 20

interface LeadRow {
  lead_id: string
  business_name: string
  status: string
  current_score: number | null
  current_score_band: string | null
  total_count: number
}

function scoreBandTone(band: string | null): 'danger' | 'warning' | 'neutral' {
  if (band === 'hot') return 'danger'
  if (band === 'warm') return 'warning'
  return 'neutral'
}

async function fetchByStage(status: string, offset: number): Promise<LeadRow[]> {
  const { data, error } = await supabase.rpc('search_sales_leads', {
    p_status: status,
    p_exclude_do_not_contact: false,
    p_limit: PAGE_SIZE,
    p_offset: offset,
  })
  if (error) throw error
  return data ?? []
}

function StageColumn({ stage }: { stage: string }) {
  const { t } = useTranslation()
  const [offset, setOffset] = useState(0)
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['sales-pipeline-stage', stage, offset],
    queryFn: () => fetchByStage(stage, offset),
  })

  const rows = data ?? []
  // total_count is the same value on every row of a given query
  // (search_sales_leads's own window-function count) -- 0 when the
  // stage is genuinely empty, since there are no rows to read it from.
  const totalCount = rows[0]?.total_count ?? 0
  const hasMore = offset + rows.length < totalCount

  return (
    <Card className="min-w-64 flex-shrink-0">
      <CardHeader><CardTitle className="text-sm">{t(`platform.sales.pipeline.stage.${stage}`)} ({totalCount})</CardTitle></CardHeader>
      <CardContent className="space-y-2">
        {isError ? (
          <ErrorState message={translateSupabaseError(error, t('platform.sales.pipeline.loadError'))} onRetry={() => refetch()} />
        ) : isLoading ? (
          <ListLoadingSkeleton rows={2} />
        ) : rows.length === 0 ? (
          <p className="text-xs text-text-secondary">—</p>
        ) : (
          <>
            {rows.map((l) => (
              <Link
                key={l.lead_id}
                to={`/platform/sales/leads/${l.lead_id}`}
                className="flex items-center justify-between gap-2 rounded-md border border-border-subtle p-2 text-sm hover:bg-surface-subtle"
              >
                <span className="truncate">{l.business_name}</span>
                {l.current_score != null && (
                  <StatusBadge tone={scoreBandTone(l.current_score_band)} label={String(l.current_score)} />
                )}
              </Link>
            ))}
            {hasMore && (
              <Button variant="outline" size="sm" className="w-full" onClick={() => setOffset(offset + PAGE_SIZE)}>
                {t('platform.sales.pipeline.showMore')}
              </Button>
            )}
          </>
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
