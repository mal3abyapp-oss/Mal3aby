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
//
// Control Plane V1, Phase 9: this page used to keep accumulating every
// fetched page into one ever-growing client-side array via a `pages`
// counter and Promise.all/flatMap re-fetch-everything-so-far pattern --
// a real, confirmed scale risk at `audit_logs` = 2,197 rows today and
// growing on every mutating action platform-wide, per the deep dive
// (Section 16/26). Now real page-replace pagination, matching
// PlatformClubsPage.tsx's established convention (real server-side
// total_count from the RPC, Prev/Next replacing the current page
// instead of appending to it). Every existing filter (actor/action/
// entity/date range) is preserved exactly -- only the pagination
// mechanism underneath changed.

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
  actorId: string
}

// Acceptance-sweep fix (2026-08-30), platform-owner acceptance
// finding #5: get_platform_audit_log() has supported p_actor_id and
// p_club_id since it was first written, but this page's own Filters
// interface only ever wired action/entityType/from/to -- despite this
// file's own header comment (line 30) already claiming "server-side
// filters (actor/action/entity/date range)" existed. p_club_id stays
// unwired here deliberately: club-scoped audit is already solved on
// PlatformClubDetailPage's own Audit tab (fetchClubAudit), and this
// global page's existing clickable club-name link already gets a
// platform owner there in one click. p_actor_id had no equivalent path
// at all -- "did this specific staff member do anything unusual across
// every club" was unanswerable -- so actor is now filterable the same
// way club already was: click a name in the table to filter by them
// (actor_id is already present on every row, no new lookup UI needed).
async function fetchAudit(page: number, filters: Filters): Promise<{ rows: AuditRow[]; totalCount: number }> {
  const { data, error } = await supabase.rpc('get_platform_audit_log', {
    p_limit: PAGE_SIZE,
    p_offset: page * PAGE_SIZE,
    p_actor_id: filters.actorId || undefined,
    p_action: filters.action || undefined,
    p_entity_type: filters.entityType || undefined,
    p_from: filters.from ? new Date(filters.from).toISOString() : undefined,
    p_to: filters.to ? new Date(filters.to + 'T23:59:59').toISOString() : undefined,
  })
  if (error) throw error
  const rows = (data ?? []) as (AuditRow & { total_count?: number })[]
  return { rows, totalCount: Number(rows[0]?.total_count ?? 0) }
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
  const [page, setPage] = useState(0)
  const [actionFilter, setActionFilter] = useState('')
  const [entityFilter, setEntityFilter] = useState('')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [actorFilter, setActorFilter] = useState<{ id: string; label: string } | null>(null)

  const filters: Filters = useMemo(
    () => ({ action: actionFilter, entityType: entityFilter, from: fromDate, to: toDate, actorId: actorFilter?.id ?? '' }),
    [actionFilter, entityFilter, fromDate, toDate, actorFilter],
  )

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['platform-audit', page, filters],
    queryFn: () => fetchAudit(page, filters),
    placeholderData: (prev) => prev,
  })
  const rows = data?.rows ?? []
  const totalCount = data?.totalCount ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  function resetToFirstPage() {
    setPage(0)
  }

  const columns: DataTableColumn<AuditRow>[] = [
    { key: 'time', header: t('platform.auditPage.time'), render: (r) => new Date(r.created_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG') },
    {
      key: 'actor',
      header: t('platform.auditPage.actor'),
      render: (r) =>
        r.actor_id ? (
          <button
            type="button"
            className="flex flex-col text-start hover:underline"
            title={t('platform.auditPage.filterByThisActor')}
            aria-label={t('platform.auditPage.filterByThisActor')}
            onClick={() => {
              setActorFilter({ id: r.actor_id!, label: r.actor_name ?? r.actor_email ?? r.actor_id! })
              resetToFirstPage()
            }}
          >
            <span className="text-accent-foreground">{r.actor_name ?? t('platform.auditPage.systemActor')}</span>
            {r.actor_email && <span className="text-xs text-text-secondary">{r.actor_email}</span>}
          </button>
        ) : (
          <div className="flex flex-col">
            <span className="text-text-primary">{t('platform.auditPage.systemActor')}</span>
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

      {actorFilter && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-accent-foreground/30 bg-accent/5 p-2 text-sm">
          <span>{t('platform.auditPage.filteredByActor', { name: actorFilter.label })}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setActorFilter(null)
              resetToFirstPage()
            }}
          >
            {t('platform.auditPage.clearActorFilter')}
          </Button>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="flex flex-col gap-1">
          <label htmlFor="platform-audit-filter-action" className="sr-only">
            {t('platform.auditPage.filterAction')}
          </label>
          <Input
            id="platform-audit-filter-action"
            placeholder={t('platform.auditPage.filterAction')}
            value={actionFilter}
            onChange={(e) => {
              setActionFilter(e.target.value)
              resetToFirstPage()
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="platform-audit-filter-entity" className="sr-only">
            {t('platform.auditPage.filterEntity')}
          </label>
          <Input
            id="platform-audit-filter-entity"
            placeholder={t('platform.auditPage.filterEntity')}
            value={entityFilter}
            onChange={(e) => {
              setEntityFilter(e.target.value)
              resetToFirstPage()
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="platform-audit-filter-from" className="sr-only">
            {t('platform.auditPage.filterFromDate', { defaultValue: 'From date' })}
          </label>
          <Input
            id="platform-audit-filter-from"
            type="date"
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value)
              resetToFirstPage()
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="platform-audit-filter-to" className="sr-only">
            {t('platform.auditPage.filterToDate', { defaultValue: 'To date' })}
          </label>
          <Input
            id="platform-audit-filter-to"
            type="date"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value)
              resetToFirstPage()
            }}
          />
        </div>
      </div>

      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} isLoading={isLoading} emptyTitle={t('platform.auditPage.emptyTitle')} />
      {totalCount > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-text-secondary">
          <span>{t('platform.auditPage.resultCount', { count: totalCount })}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page === 0 || isFetching} onClick={() => setPage((p) => p - 1)}>
              {t('platform.clubsPage.prevPage')}
            </Button>
            <span>{t('platform.clubsPage.pageOf', { page: page + 1, total: totalPages })}</span>
            <Button variant="outline" size="sm" disabled={page + 1 >= totalPages || isFetching} onClick={() => setPage((p) => p + 1)}>
              {t('platform.clubsPage.nextPage')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
