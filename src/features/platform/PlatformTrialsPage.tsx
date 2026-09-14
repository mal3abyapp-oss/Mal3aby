import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { translateSupabaseError } from '@/lib/errors'

interface TrialRow {
  id: string
  club_id: string
  club_name: string
  start_at: string
  end_at: string
  trial_origin: string | null
  lifecycle_status: string
}

// FULL-PLATFORM AUDIT ROUND 2 (finding 5): this query had no LIMIT/
// pagination at all -- PostgREST's default max_rows (1000) would
// silently truncate the result once trial rows exceed that, with
// nothing in the UI indicating it happened. No RPC exists for trials
// (unlike PlatformClubsPage.tsx's search_platform_clubs()), so this
// stays a direct table query but now follows that same page's
// established server-side range()-pagination + exact-count convention
// (PAGE_SIZE, real Prev/Next replacing the current page) instead of an
// unbounded single fetch.
const PAGE_SIZE = 100

async function fetchTrials(page: number): Promise<{ rows: TrialRow[]; totalCount: number }> {
  // FIXTURE ISOLATION FIX (Control Plane V1, Phase 3): this query
  // previously read platform_subscriptions directly with NO
  // is_test_fixture filter at all -- unlike PlatformOverviewPage's own
  // trial count (via the fixture-excluded get_platform_subscription_
  // report() RPC), so the two screens could disagree on "how many
  // trials exist" for exactly this reason. Now joined through clubs
  // (inner join, so a subscription whose club is a fixture is excluded
  // entirely) and filtered the same way every other commercial-metric
  // screen already is.
  const { data, error, count } = await supabase
    .from('platform_subscriptions')
    .select('id, club_id, start_at, end_at, trial_origin, lifecycle_status, clubs!inner(name_ar, is_test_fixture)', { count: 'exact' })
    .eq('subscription_kind', 'trial')
    .eq('clubs.is_test_fixture', false)
    .order('start_at', { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1)

  if (error) throw error
  const rows = (data ?? []).map((row) => ({
    id: row.id,
    club_id: row.club_id,
    club_name: (row.clubs as unknown as { name_ar: string } | null)?.name_ar ?? '—',
    start_at: row.start_at,
    end_at: row.end_at,
    trial_origin: row.trial_origin,
    lifecycle_status: row.lifecycle_status,
  }))
  return { rows, totalCount: count ?? rows.length }
}

// The Active/Expired/Cancelled StatCards below need every trial row (not
// just the displayed page) to stay correct -- same rationale as
// PlatformOwnersPage.tsx's fetchAllOwnersForGrouping fix in this same
// audit round. A dedicated, separate query from the paginated table
// above, looping this same range()-paginated fetch until every row is
// collected, capped at a generous bound so a pathological total can't
// turn this into an unbounded fetch loop.
const MAX_TRIAL_ROWS_FOR_STATS = 20000

async function fetchAllTrialsForStats(): Promise<TrialRow[]> {
  const all: TrialRow[] = []
  let page = 0
  for (;;) {
    const { rows, totalCount } = await fetchTrials(page)
    if (rows.length === 0) break
    all.push(...rows)
    page += 1
    if (all.length >= totalCount || all.length >= MAX_TRIAL_ROWS_FOR_STATS) break
  }
  return all
}

export function PlatformTrialsPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const [page, setPage] = useState(0)

  // Finding H-2 (frozen production audit): this list previously
  // destructured only `data = [], isLoading` -- a failed fetch silently
  // rendered as "no free trials" (both the DataTable empty state and
  // the Active/Expired/Cancelled StatCards reading 0), indistinguishable
  // from a platform genuinely running zero trials. isError/error/
  // refetch are now surfaced.
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['platform-trials', page],
    queryFn: () => fetchTrials(page),
    placeholderData: (prev) => prev,
  })
  const trials = data?.rows ?? []
  const totalCount = data?.totalCount ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  // FULL-PLATFORM AUDIT ROUND 2 (finding 5): the stat cards read from
  // this separate, all-rows query (see fetchAllTrialsForStats above),
  // not from `trials` (the current page only) -- otherwise paginating
  // the table would have silently made the cards wrong in a new way.
  const { data: allTrialsForStats, isLoading: statsLoading, isError: statsError } = useQuery({
    queryKey: ['platform-trials-stats'],
    queryFn: fetchAllTrialsForStats,
  })

  const now = new Date()
  const statsRows = allTrialsForStats ?? []
  const active = statsRows.filter((t) => t.lifecycle_status !== 'cancelled' && new Date(t.end_at) > now)
  const expired = statsRows.filter((t) => t.lifecycle_status !== 'cancelled' && new Date(t.end_at) <= now)
  const cancelled = statsRows.filter((t) => t.lifecycle_status === 'cancelled')

  const columns: DataTableColumn<TrialRow>[] = [
    {
      key: 'club',
      header: t('platform.trialsPage.columns.club'),
      // IA restructuring (Phase 3): club name was plain text here,
      // inconsistent with every sibling screen (Clubs/Owners/Alerts)
      // which link into PlatformClubDetailPage -- confirmed dead-end
      // in MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md.
      render: (row) => (
        <Link to={`/platform/clubs/${row.club_id}`} className="text-accent-foreground hover:underline">
          {row.club_name}
        </Link>
      ),
    },
    {
      key: 'origin',
      header: t('platform.trialsPage.columns.origin'),
      render: (row) => (row.trial_origin === 'automatic' ? t('platform.trialsPage.originAutomatic') : t('platform.trialsPage.originManual')),
    },
    { key: 'start', header: t('platform.trialsPage.columns.start'), render: (row) => new Date(row.start_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
    { key: 'end', header: t('platform.trialsPage.columns.end'), render: (row) => new Date(row.end_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
    {
      key: 'status',
      header: t('platform.trialsPage.columns.status'),
      render: (row) => {
        if (row.lifecycle_status === 'cancelled') return <StatusBadge tone="neutral" label={t('platform.trialsPage.statusCancelled')} />
        if (new Date(row.end_at) > now) return <StatusBadge tone="success" label={t('platform.trialsPage.statusActive')} />
        return <StatusBadge tone="danger" label={t('platform.trialsPage.statusExpired')} />
      },
    },
  ]

  return (
    <div>
      <PageHeader title={t('platform.trialsPage.title')} description={t('platform.trialsPage.description')} />
      <div className="mb-4 grid grid-cols-3 gap-4">
        <StatCard label={t('platform.trialsPage.cards.active')} value={statsLoading || statsError ? '—' : String(active.length)} />
        <StatCard label={t('platform.trialsPage.cards.expired')} value={statsLoading || statsError ? '—' : String(expired.length)} />
        <StatCard label={t('platform.trialsPage.cards.cancelled')} value={statsLoading || statsError ? '—' : String(cancelled.length)} />
      </div>
      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('platform.trialsPage.loadError'))} onRetry={() => void refetch()} />
      ) : (
        <>
          {/* Design remediation (premium-ui-ux-audit, mobile brief): opt-in
              to DataTable's existing 'cards-on-mobile' variant -- a narrow
              viewport gets a readable stacked card per trial instead of a
              forced horizontal scroll. Same columns/data/links, presentation
              only; the club-name column becomes the card's title line. */}
          <DataTable
            columns={columns.map((c) => (c.key === 'club' ? { ...c, cardPriority: 'primary' as const } : c))}
            rows={trials}
            rowKey={(row) => row.id}
            isLoading={isLoading}
            emptyTitle={t('platform.trialsPage.emptyTitle')}
            variant="cards-on-mobile"
          />
          {/* FULL-PLATFORM AUDIT ROUND 2 (finding 5): same Prev/Next
              page-replace pagination convention as PlatformClubsPage.tsx/
              PlatformOwnersPage.tsx (reusing their generic
              platform.clubsPage.prevPage/nextPage/pageOf keys, same as
              PlatformOwnersPage already does). */}
          {totalCount > 0 && (
            <div className="mt-4 flex items-center justify-between text-sm text-text-secondary">
              <span>{t('platform.trialsPage.resultCount', { count: totalCount })}</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" disabled={page === 0 || isLoading} onClick={() => setPage((p) => p - 1)}>
                  {t('platform.clubsPage.prevPage')}
                </Button>
                <span>{t('platform.clubsPage.pageOf', { page: page + 1, total: totalPages })}</span>
                <Button variant="outline" size="sm" disabled={page + 1 >= totalPages || isLoading} onClick={() => setPage((p) => p + 1)}>
                  {t('platform.clubsPage.nextPage')}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
