import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useDirection } from '@/app/providers/DirectionProvider'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CLUB_STATUS_LABELS, ACCESS_TONE, ACCESS_LABEL } from '@/features/platform/labels'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'

// Master IA/UX audit (Platform Owner phase, Audit 5): a hard `.limit(100)`
// silently dropped any club beyond the 100th with zero indication a cutoff
// happened -- a real data-loss-from-view risk once the platform grows past
// this number, not just today. Fixed with simple offset-based "load more"
// pagination rather than a full page-number component, since no shared
// pagination primitive exists in this codebase yet (DataTable is
// deliberately bounded/dumb per its own header comment) and this screen's
// flat, most-recent-first list shape doesn't need page jumping.
const PAGE_SIZE = 100

// Platform Owner Phase B directive (B1/B2): Overview's StatCards used to
// all link here with zero filter, landing on the exact same undifferentiated
// list regardless of which card was clicked -- a real dead-end confirmed by
// the live audit. This screen now reads `status`/`access`/`reason`/`created`
// query params (a stable, documented contract Overview's cards write to)
// and applies them client-side after the batched access fetch -- club count
// is small enough today that a second RPC round-trip per filter isn't
// justified, and this keeps the single get_platform_clubs_access() call
// as the only access-resolving round trip per page, consistent with the
// N+1 fix from Phase A.
type StatusFilter = 'all' | 'active' | 'suspended' | 'closed'
type AccessFilter = 'all' | 'full' | 'grace' | 'blocked'
type ReasonFilter = 'all' | 'no_subscription' | 'admin_suspended' | 'in_grace' | 'expired' | 'active'
type CreatedFilter = 'all' | 'this_month'

interface ClubRow {
  id: string
  name_ar: string
  club_code: string
  status: string
  created_at: string
  access: string
  reason: string
  flaggedDuplicate: boolean
  flaggedDuplicateReason: string | null
}

// FINAL PRODUCT COMPLETENESS ROUND (2026-08-25) -- Platform Owner
// persona: complete_new_club_onboarding() has flagged real, computed
// duplicate-name signups since before this audit (flagged_duplicate/
// flagged_duplicate_reason, set at signup time -- see that RPC's own
// body) -- but no screen anywhere in the platform console ever
// selected or rendered those columns. Investigated the signup flow
// first, per the explicit "don't build new architecture" constraint:
// clubs.status is a hard 3-value enum (active/suspended/closed, no
// "pending" state exists or is added here) and a new club is
// deliberately created 'active' immediately (the self-serve trial
// model this platform is built on) -- changing either of those is a
// real architecture change this round is not authorized to make.
// flagged_duplicate is the one real, already-computed "needs review"
// signal that was simply never surfaced -- fixed by making it visible
// here and on the Overview exception cards (see PlatformOverviewPage),
// with the existing suspend/reactivate actions (already fully built on
// Club Detail) as the real accept/reject mechanism -- no new RPC, no
// new enum value, no new workflow.
async function fetchClubs(offset: number): Promise<{ rows: ClubRow[]; hasMore: boolean }> {
  const { data: clubs, error } = await supabase
    .from('clubs')
    .select('id, name_ar, club_code, status, created_at, flagged_duplicate, flagged_duplicate_reason')
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)

  if (error) throw error
  if (!clubs) return { rows: [], hasMore: false }

  // Phase A directive (A3): this used to call get_club_platform_access()
  // once PER CLUB via Promise.all, re-run in full on every "load more"
  // click -- cost grew with total pages loaded, not just the newest page.
  // Batched into a single RPC call per page instead.
  const clubIds = clubs.map((c) => c.id)
  const { data: accessRows, error: accessError } =
    clubIds.length > 0
      ? await supabase.rpc('get_platform_clubs_access', { p_club_ids: clubIds })
      : { data: [] as { club_id: string; access: string; reason: string }[], error: null }
  if (accessError) throw accessError
  const accessByClub = new Map((accessRows ?? []).map((r) => [r.club_id, { access: r.access, reason: r.reason }]))
  const withAccess: ClubRow[] = clubs.map((c) => ({
    id: c.id,
    name_ar: c.name_ar,
    club_code: c.club_code,
    status: c.status,
    created_at: c.created_at,
    access: accessByClub.get(c.id)?.access ?? 'blocked',
    reason: accessByClub.get(c.id)?.reason ?? 'no_subscription',
    flaggedDuplicate: c.flagged_duplicate ?? false,
    flaggedDuplicateReason: c.flagged_duplicate_reason,
  }))

  return { rows: withAccess, hasMore: clubs.length === PAGE_SIZE }
}

export function PlatformClubsPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const [pages, setPages] = useState(1)
  const [searchParams, setSearchParams] = useSearchParams()
  const [search, setSearch] = useState('')

  const statusFilter = (searchParams.get('status') as StatusFilter) || 'all'
  const accessFilter = (searchParams.get('access') as AccessFilter) || 'all'
  const reasonFilter = (searchParams.get('reason') as ReasonFilter) || 'all'
  const createdFilter = (searchParams.get('created') as CreatedFilter) || 'all'

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams)
    if (value === 'all') next.delete(key)
    else next.set(key, value)
    setSearchParams(next)
  }

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['platform-clubs', pages],
    queryFn: async () => {
      const results = await Promise.all(Array.from({ length: pages }, (_, i) => fetchClubs(i * PAGE_SIZE)))
      const lastPage = results.at(-1)
      return { rows: results.flatMap((r) => r.rows), hasMore: lastPage?.hasMore ?? false }
    },
  })
  const allClubs = data?.rows ?? []

  // FINAL PRODUCT COMPLETENESS ROUND (2026-08-25): flaggedOnly reads the
  // same ?flagged=1 deep-link pattern as the other filters (see
  // PlatformOverviewPage's new exception card), a plain boolean rather
  // than extending the existing filter-union types since this is a
  // single yes/no signal, not another multi-value dimension.
  const flaggedOnly = searchParams.get('flagged') === '1'

  const clubs = useMemo(() => {
    const monthStart = new Date()
    monthStart.setDate(1)
    monthStart.setHours(0, 0, 0, 0)
    const q = search.trim().toLowerCase()

    return allClubs.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (accessFilter !== 'all' && c.access !== accessFilter) return false
      if (reasonFilter !== 'all' && c.reason !== reasonFilter) return false
      if (createdFilter === 'this_month' && new Date(c.created_at) < monthStart) return false
      if (flaggedOnly && !c.flaggedDuplicate) return false
      if (q && !c.name_ar.toLowerCase().includes(q) && !c.club_code.toLowerCase().includes(q)) return false
      return true
    })
  }, [allClubs, statusFilter, accessFilter, reasonFilter, createdFilter, flaggedOnly, search])

  const columns: DataTableColumn<ClubRow>[] = [
    {
      key: 'name',
      header: t('platform.clubsPage.columns.club'),
      render: (c) => (
        <div className="flex items-center gap-2">
          <Link to={`/platform/clubs/${c.id}`} className="font-medium text-accent-foreground hover:underline">
            {c.name_ar}
          </Link>
          {/* FINAL PRODUCT COMPLETENESS ROUND (2026-08-25) -- Platform
              Owner persona: flagged_duplicate has been computed at
              every signup since before this audit and was never
              surfaced anywhere -- this is the real "needs review"
              signal a Platform Owner needs to keep control over new
              signups without a new approval workflow/architecture. */}
          {c.flaggedDuplicate && (
            <StatusBadge tone="warning" label={t('platform.clubsPage.flaggedDuplicate')} />
          )}
        </div>
      ),
    },
    { key: 'code', header: t('platform.clubsPage.columns.code'), render: (c) => <bdi>{c.club_code}</bdi> },
    {
      // FINAL PRODUCT COMPLETENESS ROUND (2026-08-25) -- Platform Owner
      // persona, explicit question: "متى طلب الانضمام" (when did this
      // club join). created_at was already fetched (used by the
      // createdFilter=this_month filter) but never rendered as a
      // column -- a Platform Owner scanning this list for a new signup
      // had no join-date visible without opening each club individually.
      key: 'createdAt',
      header: t('platform.clubsPage.columns.createdAt'),
      render: (c) => <bdi>{new Date(c.created_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi>,
    },
    {
      key: 'status',
      header: t('platform.clubsPage.columns.adminStatus'),
      render: (c) => (
        <StatusBadge
          tone={c.status === 'active' ? 'success' : 'danger'}
          label={t(`platform.ownersPage.clubStatusLabels.${c.status}`, { defaultValue: CLUB_STATUS_LABELS[c.status] ?? c.status })}
        />
      ),
    },
    {
      key: 'access',
      header: t('platform.clubsPage.columns.subscriptionStatus'),
      render: (c) => (
        <StatusBadge
          tone={ACCESS_TONE[c.access] ?? 'neutral'}
          label={t(`platform.ownersPage.accessLabels.${c.access}`, { defaultValue: ACCESS_LABEL[c.access] ?? c.access })}
        />
      ),
    },
  ]

  const hasActiveFilters = statusFilter !== 'all' || accessFilter !== 'all' || reasonFilter !== 'all' || createdFilter !== 'all' || flaggedOnly

  return (
    <div>
      <PageHeader title={t('platform.clubsPage.title')} description={t('platform.clubsPage.description')} />

      {/* PERSONA COUNCIL AUDIT (2026-08-25) -- Platform Owner persona,
          same silent-read-error pattern as PlatformOverviewPage: a real
          query failure here previously rendered an empty list with no
          indication it was a failure rather than a genuinely empty
          platform. */}
      {isError && (
        <ErrorState
          message={translateSupabaseError(error, t('platform.clubsPage.loadError', { defaultValue: 'Could not load clubs.' }))}
          onRetry={() => void refetch()}
          className="mb-4"
        />
      )}

      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          placeholder={t('platform.clubsPage.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={statusFilter} onValueChange={(v) => updateParam('status', v)}>
          <SelectTrigger className="w-44"><SelectValue placeholder={t('platform.clubsPage.filters.status')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('platform.clubsPage.filters.allStatuses')}</SelectItem>
            <SelectItem value="active">{CLUB_STATUS_LABELS.active}</SelectItem>
            <SelectItem value="suspended">{CLUB_STATUS_LABELS.suspended}</SelectItem>
            <SelectItem value="closed">{CLUB_STATUS_LABELS.closed}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={accessFilter} onValueChange={(v) => updateParam('access', v)}>
          <SelectTrigger className="w-44"><SelectValue placeholder={t('platform.clubsPage.filters.access')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('platform.clubsPage.filters.allAccess')}</SelectItem>
            <SelectItem value="full">{ACCESS_LABEL.full}</SelectItem>
            <SelectItem value="grace">{ACCESS_LABEL.grace}</SelectItem>
            <SelectItem value="blocked">{ACCESS_LABEL.blocked}</SelectItem>
          </SelectContent>
        </Select>
        {/* PERSONA COUNCIL AUDIT (2026-08-25) -- Platform Owner persona
            finding: reasonFilter was already read from and applied
            against the URL param (see the ?reason= deep links from
            PlatformOverviewPage's exception cards above), but had no
            UI control here at all -- reachable only via a deep link,
            never discoverable by a Platform Owner browsing this page
            directly. */}
        <Select value={reasonFilter} onValueChange={(v) => updateParam('reason', v)}>
          <SelectTrigger className="w-48"><SelectValue placeholder={t('platform.clubsPage.filters.reason')} /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('platform.clubsPage.filters.allReasons')}</SelectItem>
            <SelectItem value="no_subscription">{t('platform.clubsPage.filters.reasonLabels.no_subscription')}</SelectItem>
            <SelectItem value="admin_suspended">{t('platform.clubsPage.filters.reasonLabels.admin_suspended')}</SelectItem>
            <SelectItem value="in_grace">{t('platform.clubsPage.filters.reasonLabels.in_grace')}</SelectItem>
            <SelectItem value="expired">{t('platform.clubsPage.filters.reasonLabels.expired')}</SelectItem>
            <SelectItem value="active">{t('platform.clubsPage.filters.reasonLabels.active')}</SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant={flaggedOnly ? 'default' : 'outline'}
          size="sm"
          onClick={() => updateParam('flagged', flaggedOnly ? 'all' : '1')}
        >
          {t('platform.clubsPage.filters.flaggedOnly')}
        </Button>
        {hasActiveFilters && (
          <Button variant="outline" size="sm" onClick={() => setSearchParams({})}>
            {t('platform.clubsPage.filters.clear')}
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={clubs}
        rowKey={(c) => c.id}
        isLoading={isLoading}
        emptyTitle={t('platform.clubsPage.emptyTitle')}
      />
      {data?.hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => setPages((p) => p + 1)} disabled={isFetching}>
            {isFetching ? t('platform.clubsPage.loadingMore') : t('platform.clubsPage.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
}
