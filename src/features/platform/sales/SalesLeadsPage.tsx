// SalesLeadsPage -- Sales Intelligence Phase 3/8 (ADR-054). The full
// filterable lead list, mirroring PlatformClubsPage's URLSearchParams
// + debounced-search + DataTable pagination pattern exactly.
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'

const PAGE_SIZE = 25

interface LeadRow {
  lead_id: string
  business_name: string
  business_type: string | null
  city: string | null
  country: string | null
  status: string
  current_score: number | null
  current_score_band: string | null
  website: string | null
  public_phone: string | null
  rating: number | null
  review_count: number | null
  first_discovered_at: string
  total_count: number
}

const STATUS_VALUES = [
  'discovered', 'enriching', 'enriched', 'qualified', 'contact_ready', 'contacted',
  'replied', 'demo_scheduled', 'demo_completed', 'negotiation', 'won', 'lost', 'do_not_contact',
]

function scoreBandTone(band: string | null): 'danger' | 'warning' | 'neutral' {
  if (band === 'hot') return 'danger'
  if (band === 'warm') return 'warning'
  return 'neutral'
}

async function searchLeads(params: { search: string; status: string; minScore: string; city: string; page: number }) {
  const { data, error } = await supabase.rpc('search_sales_leads', {
    p_search: params.search || null,
    p_status: params.status === 'all' ? null : params.status,
    p_min_score: params.minScore ? Number(params.minScore) : null,
    p_city: params.city || null,
    p_limit: PAGE_SIZE,
    p_offset: params.page * PAGE_SIZE,
  })
  if (error) throw error
  const rows = (data ?? []) as LeadRow[]
  return { rows, totalCount: rows[0]?.total_count ?? 0 }
}

export function SalesLeadsPage() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [page, setPage] = useState(0)
  const [searchInput, setSearchInput] = useState(searchParams.get('q') ?? '')
  const [debouncedSearch, setDebouncedSearch] = useState(searchInput)

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const statusFilter = searchParams.get('status') ?? 'all'
  const cityFilter = searchParams.get('city') ?? ''
  const minScoreFilter = searchParams.get('minScore') ?? ''

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams)
    if (!value || value === 'all') next.delete(key)
    else next.set(key, value)
    setSearchParams(next)
    setPage(0)
  }

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['sales-leads-search', debouncedSearch, statusFilter, cityFilter, minScoreFilter, page],
    queryFn: () => searchLeads({ search: debouncedSearch, status: statusFilter, minScore: minScoreFilter, city: cityFilter, page }),
    placeholderData: (prev) => prev,
  })

  const leads = data?.rows ?? []
  const totalCount = data?.totalCount ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  const columns: DataTableColumn<LeadRow>[] = [
    {
      key: 'business',
      header: t('platform.sales.leads.columns.business'),
      render: (l: LeadRow) => (
        <Link to={`/platform/sales/leads/${l.lead_id}`} className="font-medium text-accent-foreground hover:underline">
          {l.business_name}
        </Link>
      ),
    },
    { key: 'type', header: t('platform.sales.leads.columns.type'), render: (l: LeadRow) => l.business_type ?? '—' },
    { key: 'location', header: t('platform.sales.leads.columns.location'), render: (l: LeadRow) => [l.city, l.country].filter(Boolean).join(', ') || '—' },
    {
      key: 'status',
      header: t('platform.sales.leads.columns.status'),
      render: (l: LeadRow) => <StatusBadge tone="info" label={t(`platform.sales.pipeline.stage.${l.status}`)} />,
    },
    {
      key: 'score',
      header: t('platform.sales.leads.columns.score'),
      render: (l: LeadRow) =>
        l.current_score != null ? (
          <StatusBadge tone={scoreBandTone(l.current_score_band)} label={`${l.current_score} · ${t(`platform.sales.leads.scoreBand.${l.current_score_band}`)}`} />
        ) : (
          '—'
        ),
    },
    { key: 'rating', header: t('platform.sales.leads.columns.rating'), render: (l: LeadRow) => (l.rating != null ? `${l.rating} (${l.review_count ?? 0})` : '—') },
  ]

  return (
    <div className="space-y-6">
      <PageHeader title={t('platform.sales.leads.title')} description={t('platform.sales.leads.description')} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <Input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder={t('platform.sales.leads.searchPlaceholder')}
        />
        <Select value={statusFilter} onValueChange={(v) => updateParam('status', v)}>
          <SelectTrigger><SelectValue placeholder={t('platform.sales.leads.statusLabel')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('common.all')}</SelectItem>
            {STATUS_VALUES.map((s) => (
              <SelectItem key={s} value={s}>{t(`platform.sales.pipeline.stage.${s}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={cityFilter}
          onChange={(e) => updateParam('city', e.target.value)}
          placeholder={t('platform.sales.leads.cityLabel')}
        />
        <Input
          type="number"
          value={minScoreFilter}
          onChange={(e) => updateParam('minScore', e.target.value)}
          placeholder={t('platform.sales.leads.scoreLabel')}
        />
      </div>

      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('platform.sales.leads.loadError'))} onRetry={() => refetch()} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={leads}
            rowKey={(l) => l.lead_id}
            isLoading={isLoading}
            emptyTitle={t('platform.sales.leads.emptyTitle')}
            emptyDescription={t('platform.sales.leads.emptyDescription')}
          />

          {totalCount > 0 && (
            <div className="mt-4 flex items-center justify-between text-sm text-text-secondary">
              <span>{totalCount}</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page === 0 || isFetching} onClick={() => setPage((p) => p - 1)}>
                  {t('common.previous')}
                </Button>
                <span>{page + 1} / {totalPages}</span>
                <Button variant="outline" size="sm" disabled={page + 1 >= totalPages || isFetching} onClick={() => setPage((p) => p + 1)}>
                  {t('common.next')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
