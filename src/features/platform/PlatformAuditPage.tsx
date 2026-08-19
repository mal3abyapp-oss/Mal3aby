import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { actionLabel, entityLabel } from '@/lib/domain/audit'
import { useDirection } from '@/app/providers/DirectionProvider'

// IA restructuring (Phase 3): two real findings from
// MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md fixed here --
// (1) r.action/r.entity_type were rendered completely raw
// ("platform_suspend_club", "clubs") instead of through a label map,
// unlike every other enum-bearing column in the Platform Owner tier;
// (2) club name was plain text, not a link, inconsistent with every
// sibling screen (Clubs/Owners/Alerts) which link into
// PlatformClubDetailPage -- this was flagged as a dead-end gap.
//
// Platform Owner Phase A directive (A4/A5/A6): the live audit found two
// further, more serious gaps -- audit_logs.actor_id exists on the table
// but was never selected (so "who did this" was unanswerable from the
// UI at all), and before/after were never selected either (so "what
// changed" was also unanswerable). Both are now resolved server-side by
// get_platform_audit_log() (actor name/email joined in one query, no
// N+1) and rendered here: a real actor column, and a "what changed"
// expandable diff of before/after for rows that have them. Also adds
// server-side filters (actor/action/entity/date range) instead of only
// ever paging through the whole unfiltered table.

const PAGE_SIZE = 200

interface AuditRow {
  id: string
  club_id: string | null
  club_name: string | null
  actor_id: string | null
  actor_name: string | null
  actor_email: string | null
  action: string
  entity_type: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  reason: string | null
  created_at: string
}

interface Filters {
  action: string
  entityType: string
  from: string
  to: string
}

async function fetchAudit(offset: number, filters: Filters): Promise<{ rows: AuditRow[]; hasMore: boolean }> {
  const { data, error } = await supabase.rpc('get_platform_audit_log', {
    p_limit: PAGE_SIZE,
    p_offset: offset,
    p_action: filters.action || undefined,
    p_entity_type: filters.entityType || undefined,
    p_from: filters.from ? new Date(filters.from).toISOString() : undefined,
    p_to: filters.to ? new Date(filters.to + 'T23:59:59').toISOString() : undefined,
  })
  if (error) throw error
  const rows = (data ?? []) as AuditRow[]
  return { rows, hasMore: rows.length === PAGE_SIZE }
}

// Renders a compact "what changed" diff for the fields present in
// before/after -- not raw JSON as the primary view (per directive A5:
// "لا تعرض raw JSON كحل نهائي للموظف"), but a plain key: old → new list.
// A collapsible "technical details" block still offers the raw JSON for
// deeper investigation.
function ChangeDiff({ before, after }: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const { t } = useTranslation()
  const [showRaw, setShowRaw] = useState(false)
  if (!before && !after) return <span className="text-text-secondary">—</span>

  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]))
  const changed = keys.filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]))

  return (
    <div className="flex flex-col gap-1 text-xs">
      {changed.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          {changed.slice(0, 4).map((k) => (
            <li key={k}>
              <span className="font-medium text-text-primary">{k}</span>:{' '}
              <span className="text-text-secondary">{before?.[k] === undefined ? '—' : String(before[k])}</span>
              {' → '}
              <span className="text-text-primary">{after?.[k] === undefined ? '—' : String(after[k])}</span>
            </li>
          ))}
          {changed.length > 4 && <li className="text-text-secondary">+{changed.length - 4} {t('platform.auditPage.moreFields')}</li>}
        </ul>
      ) : (
        <span className="text-text-secondary">{t('platform.auditPage.noFieldChanges')}</span>
      )}
      <button type="button" className="text-start text-accent-foreground hover:underline" onClick={() => setShowRaw((v) => !v)}>
        {showRaw ? t('platform.auditPage.hideTechnicalDetails') : t('platform.auditPage.showTechnicalDetails')}
      </button>
      {showRaw && (
        <pre className="max-w-xs overflow-x-auto rounded bg-page-bg p-2 text-[10px]">
          {JSON.stringify({ before, after }, null, 2)}
        </pre>
      )}
    </div>
  )
}

export function PlatformAuditPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const [pages, setPages] = useState(1)
  const [actionFilter, setActionFilter] = useState('')
  const [entityFilter, setEntityFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  const filters: Filters = useMemo(
    () => ({ action: actionFilter, entityType: entityFilter, from: fromDate, to: toDate }),
    [actionFilter, entityFilter, fromDate, toDate],
  )

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['platform-audit', pages, filters],
    queryFn: async () => {
      const results = await Promise.all(Array.from({ length: pages }, (_, i) => fetchAudit(i * PAGE_SIZE, filters)))
      const lastPage = results.at(-1)
      return { rows: results.flatMap((r) => r.rows), hasMore: lastPage?.hasMore ?? false }
    },
  })
  const rows = data?.rows ?? []

  function resetToFirstPage() {
    setPages(1)
  }

  const columns: DataTableColumn<AuditRow>[] = [
    { key: 'time', header: t('platform.auditPage.time'), render: (r) => new Date(r.created_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG') },
    {
      key: 'actor',
      header: t('platform.auditPage.actor'),
      render: (r) => (
        <div className="flex flex-col">
          <span className="text-text-primary">{r.actor_name ?? t('platform.auditPage.systemActor')}</span>
          {r.actor_email && <span className="text-xs text-text-secondary">{r.actor_email}</span>}
        </div>
      ),
    },
    {
      key: 'club',
      header: t('platform.auditPage.club'),
      render: (r) =>
        r.club_id ? (
          <Link to={`/platform/clubs/${r.club_id}`} className="text-accent-foreground hover:underline">
            {r.club_name ?? t('platform.auditPage.clubFallback')}
          </Link>
        ) : (
          t('platform.auditPage.platformLevel')
        ),
    },
    { key: 'action', header: t('platform.auditPage.action'), render: (r) => actionLabel(r.action, locale) },
    { key: 'entity', header: t('platform.auditPage.entity'), render: (r) => entityLabel(r.entity_type, locale) },
    { key: 'changes', header: t('platform.auditPage.whatChanged'), render: (r) => <ChangeDiff before={r.before} after={r.after} /> },
    { key: 'reason', header: t('platform.auditPage.reason'), render: (r) => r.reason ?? '—' },
  ]

  return (
    <div>
      <PageHeader title={t('platform.auditPage.title')} description={t('platform.auditPage.description')} />

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Input
          placeholder={t('platform.auditPage.filterAction')}
          value={actionFilter}
          onChange={(e) => {
            setActionFilter(e.target.value)
            resetToFirstPage()
          }}
        />
        <Input
          placeholder={t('platform.auditPage.filterEntity')}
          value={entityFilter}
          onChange={(e) => {
            setEntityFilter(e.target.value)
            resetToFirstPage()
          }}
        />
        <Input
          type="date"
          value={fromDate}
          onChange={(e) => {
            setFromDate(e.target.value)
            resetToFirstPage()
          }}
        />
        <Input
          type="date"
          value={toDate}
          onChange={(e) => {
            setToDate(e.target.value)
            resetToFirstPage()
          }}
        />
      </div>

      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} isLoading={isLoading} emptyTitle={t('platform.auditPage.emptyTitle')} />
      {data?.hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => setPages((p) => p + 1)} disabled={isFetching}>
            {isFetching ? t('platform.auditPage.loadingMore') : t('platform.auditPage.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}
