import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { CLUB_STATUS_LABELS, MEMBERSHIP_STATUS_LABELS } from '@/features/platform/labels'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'

// Gate 13 task #55: the platform owner console had no way to see WHO
// owns each club -- ownership is a club_memberships row (role = club_owner),
// not a column on clubs, so it was invisible without a direct DB query.
// This is the platform's actual customer list: one row per club_owner
// membership (an owner running multiple clubs shows up once per club,
// since commercial entitlements/billing are per-club, not per-person).
interface OwnerRow {
  club_id: string
  club_name: string
  club_code: string
  club_status: string
  membership_id: string
  membership_status: string
  user_id: string
  full_name: string | null
  phone: string | null
  email: string | null
  owner_since: string
}

// Phase I directive (I1): get_platform_club_owners() used to pull every
// club-owner membership row in one shot with no pagination at all --
// a real, confirmed scaling gap even though invisible at the current
// real club count. Search is now server-side (p_search), so pagination
// and search interact correctly instead of only filtering whatever
// happened to already be fetched.
//
// Control Plane V1, Phase 9: this page used to keep accumulating every
// fetched page into one ever-growing client-side array via a `pages`
// counter and Promise.all/flatMap re-fetch-everything-so-far pattern --
// real page-replace pagination now, matching PlatformClubsPage.tsx's
// established convention (real server-side total_count from the RPC,
// Prev/Next replacing the current page instead of appending to it).
const PAGE_SIZE = 100

// Cross-phase directive (U1): Platform Owner accounts had zero
// visibility anywhere on the console -- only discoverable via a direct
// DB query. Loaded via the same safe pattern as club owners (no direct
// auth.users exposure to the client).
interface PlatformOwnerAccount {
  user_id: string
  full_name: string | null
  email: string | null
  phone: string | null
  club_count: number
}

async function fetchPlatformOwnerAccounts(): Promise<PlatformOwnerAccount[]> {
  const { data, error } = await supabase.rpc('get_platform_owner_accounts')
  if (error) throw error
  return (data ?? []) as PlatformOwnerAccount[]
}

async function fetchOwners(search: string, page: number): Promise<{ rows: OwnerRow[]; totalCount: number }> {
  const { data, error } = await supabase.rpc('get_platform_club_owners', {
    p_search: search.trim() || undefined,
    p_limit: PAGE_SIZE,
    p_offset: page * PAGE_SIZE,
  })
  if (error) throw error
  const rows = (data ?? []) as (OwnerRow & { total_count?: number })[]
  return { rows, totalCount: Number(rows[0]?.total_count ?? 0) }
}

// FULL-PLATFORM AUDIT ROUND 2 (finding 2): uniqueOwners/multiClubOwners
// used to be derived from `owners` -- the currently loaded PAGE_SIZE
// (100) page only -- directly contradicting this page's own stated
// purpose (grouping owners by how many clubs they run). No aggregate
// RPC exists for this (confirmed: grepped supabase/migrations for
// get_platform_club_owners/platform owner aggregation -- the only
// related RPC, get_platform_owner_accounts, aggregates a different,
// unrelated population -- platform_owner-role accounts, not club_owner
// customers). Adding a new RPC is a backend/migration change outside
// this frontend-only fix's scope, so per the fallback direction: fetch
// every owner-membership row (not just the displayed page) using the
// exact same, already-authorized RPC, looping its own p_limit/p_offset
// until total_count is exhausted. This is a SEPARATE query from the
// one backing the paginated table below (which must keep showing only
// PAGE_SIZE rows at a time) -- it exists solely to make the grouping
// stat cards correct. Capped at a generous bound so a runaway total_count
// (e.g. a bug elsewhere) can't turn this into an unbounded fetch loop.
const MAX_OWNER_ROWS_FOR_GROUPING = 20000

async function fetchAllOwnersForGrouping(search: string): Promise<OwnerRow[]> {
  const all: OwnerRow[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await supabase.rpc('get_platform_club_owners', {
      p_search: search.trim() || undefined,
      p_limit: PAGE_SIZE,
      p_offset: offset,
    })
    if (error) throw error
    const rows = (data ?? []) as (OwnerRow & { total_count?: number })[]
    if (rows.length === 0) break
    all.push(...rows)
    const totalCount = Number(rows[0]?.total_count ?? 0)
    offset += rows.length
    if (offset >= totalCount || all.length >= MAX_OWNER_ROWS_FOR_GROUPING) break
  }
  return all
}

export function PlatformOwnersPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [page, setPage] = useState(0)
  const [resetSentFor, setResetSentFor] = useState<string | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)

  // Same debounce convention as PlatformClubsPage.tsx -- avoid firing a
  // server round trip on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput), 300)
    return () => clearTimeout(timer)
  }, [searchInput])
  useEffect(() => { setPage(0) }, [debouncedSearch])

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['platform-owners', debouncedSearch, page],
    queryFn: () => fetchOwners(debouncedSearch, page),
    placeholderData: (prev) => prev,
  })
  // `data?.rows ?? []` would create a fresh array reference every render
  // whenever `data` is undefined (e.g. mid-fetch with no placeholderData
  // yet) -- memoized so sortedFiltered's own useMemo below doesn't
  // recompute on every render for no reason.
  const owners = useMemo(() => data?.rows ?? [], [data])
  const totalCount = data?.totalCount ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))
  const { data: platformOwnerAccounts = [] } = useQuery({
    queryKey: ['platform-owner-accounts'],
    queryFn: fetchPlatformOwnerAccounts,
  })

  // FULL-PLATFORM AUDIT ROUND 2 (finding 2): grouping now runs over
  // every matching owner-membership row (see fetchAllOwnersForGrouping
  // above), not just the current PAGE_SIZE page -- independent query,
  // same debouncedSearch so it stays in sync with what the table is
  // actually filtered to, but its own isLoading/isError so a failure
  // here doesn't block the (already-working) paginated table below.
  const {
    data: allOwnersForGrouping,
    isLoading: groupingLoading,
    isError: groupingError,
    error: groupingErrorObj,
    refetch: refetchGrouping,
  } = useQuery({
    queryKey: ['platform-owners-grouping', debouncedSearch],
    queryFn: () => fetchAllOwnersForGrouping(debouncedSearch),
  })

  // Platform Owner & Password Security directive item 17/18: the
  // preferred admin action is "send a reset email", never viewing or
  // setting a user's password directly. resetPasswordForEmail() is
  // Supabase Auth's own public, rate-limited mechanism (no service_role
  // key, no custom token system) -- the same call ForgotPasswordPage
  // already uses, just triggered by the platform owner on someone
  // else's behalf instead of by the user themselves. Real server-side
  // authorization for the AUDIT record (not the email-send itself,
  // which needs no elevated privilege by design) is enforced inside
  // log_password_reset_event('platform_owner_initiated') via
  // is_platform_owner() -- a non-owner calling this RPC gets a real
  // "not authorized" rejection, not just a hidden button.
  const sendResetMutation = useMutation({
    mutationFn: async (owner: OwnerRow) => {
      if (!owner.email) throw new Error('NO_EMAIL')
      const { error: sendError } = await supabase.auth.resetPasswordForEmail(owner.email, {
        redirectTo: `${window.location.origin}/reset-password`,
      })
      if (sendError) throw sendError
      const { error: auditError } = await supabase.rpc('log_password_reset_event', {
        p_kind: 'platform_owner_initiated',
        p_target_user_id: owner.user_id,
      })
      if (auditError) throw auditError
      return owner.membership_id
    },
    onSuccess: (membershipId) => {
      setResetError(null)
      setResetSentFor(membershipId)
      setTimeout(() => setResetSentFor((cur) => (cur === membershipId ? null : cur)), 4000)
    },
    onError: (err: unknown) => {
      const message = err instanceof Error ? err.message : ''
      setResetError(message === 'NO_EMAIL' ? t('platform.ownersPage.resetNoEmail') : t('platform.ownersPage.resetError'))
    },
  })

  // FULL-PLATFORM AUDIT ROUND 2 (finding 2): computed over
  // allOwnersForGrouping (every matching row) instead of `owners` (the
  // displayed page only) -- see fetchAllOwnersForGrouping's comment
  // above. Falls back to an empty map while loading/erroring so the
  // stat cards render 0 rather than throwing; the loading/error states
  // are surfaced explicitly on the cards themselves below.
  const ownerClubCounts = new Map<string, number>()
  for (const o of allOwnersForGrouping ?? []) ownerClubCounts.set(o.user_id, (ownerClubCounts.get(o.user_id) ?? 0) + 1)
  const uniqueOwners = ownerClubCounts.size
  const multiClubOwners = [...ownerClubCounts.values()].filter((count) => count > 1).length

  // Master IA/UX audit (Platform Owner phase, Audit 5): the same person
  // owning multiple clubs (real data: "Moustafa Elsafy" owns 3 of the 6
  // clubs in this dataset) showed up as 3 visually identical rows with
  // zero indication they're the same owner -- only readable by
  // carefully comparing every email. get_platform_club_owners() staying
  // one-row-per-club-membership is correct (billing/entitlements are
  // per-club, not per-person, per this file's original design comment)
  // -- so this is a display-grouping fix, not an RPC change: rows are
  // sorted by owner so a multi-club owner's rows land adjacent, and the
  // name/email cell only renders once per owner (with a club-count
  // badge), not once per row.
  const sortedFiltered = useMemo(
    () => [...owners].sort((a, b) => (a.user_id === b.user_id ? 0 : (a.full_name ?? '').localeCompare(b.full_name ?? '', locale))),
    [owners, locale],
  )

  const columns: DataTableColumn<OwnerRow>[] = [
    {
      key: 'owner',
      header: t('platform.ownersPage.columns.owner'),
      render: (o, index, rows) => {
        const isFirstOfOwner = index === 0 || rows[index - 1]?.user_id !== o.user_id
        if (!isFirstOfOwner) return null
        const clubCount = ownerClubCounts.get(o.user_id) ?? 1
        return (
          <div className="flex flex-col">
            <span className="font-medium text-text-primary">
              {o.full_name ?? '—'}
              {clubCount > 1 && (
                <span className="ms-2 rounded-full bg-info/10 px-2 py-0.5 text-xs font-normal text-info">
                  {t('platform.ownersPage.clubCountSuffix', { count: clubCount })}
                </span>
              )}
            </span>
            <span className="text-xs text-text-secondary">{o.email ?? '—'}</span>
          </div>
        )
      },
    },
    { key: 'phone', header: t('platform.ownersPage.columns.phone'), render: (o) => (o.phone ? <bdi>{o.phone}</bdi> : '—') },
    {
      key: 'club',
      header: t('platform.ownersPage.columns.club'),
      render: (o) => (
        <Link to={`/platform/clubs/${o.club_id}`} className="font-medium text-accent-foreground hover:underline">
          {o.club_name}
        </Link>
      ),
    },
    { key: 'code', header: t('platform.ownersPage.columns.code'), render: (o) => <bdi>{o.club_code}</bdi> },
    {
      key: 'club_status',
      header: t('platform.ownersPage.columns.clubStatus'),
      render: (o) => (
        <StatusBadge
          tone={o.club_status === 'active' ? 'success' : 'danger'}
          label={t(`platform.ownersPage.clubStatusLabels.${o.club_status}`, {
            defaultValue: CLUB_STATUS_LABELS[o.club_status] ?? o.club_status,
          })}
        />
      ),
    },
    {
      key: 'membership_status',
      header: t('platform.ownersPage.columns.membershipStatus'),
      render: (o) => (
        <StatusBadge
          tone={o.membership_status === 'active' ? 'success' : 'neutral'}
          label={t(`platform.ownersPage.membershipStatusLabels.${o.membership_status}`, {
            defaultValue: MEMBERSHIP_STATUS_LABELS[o.membership_status] ?? o.membership_status,
          })}
        />
      ),
    },
    { key: 'since', header: t('platform.ownersPage.columns.since'), render: (o) => new Date(o.owner_since).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
    {
      key: 'security',
      header: t('platform.ownersPage.columns.security'),
      render: (o, index, rows) => {
        const isFirstOfOwner = index === 0 || rows[index - 1]?.user_id !== o.user_id
        if (!isFirstOfOwner) return null
        const justSent = resetSentFor === o.membership_id
        const isSending = sendResetMutation.isPending && sendResetMutation.variables?.membership_id === o.membership_id
        return (
          <Button
            size="sm"
            variant="outline"
            disabled={sendResetMutation.isPending || !o.email}
            onClick={() => {
              setResetError(null)
              sendResetMutation.mutate(o)
            }}
          >
            {justSent
              ? t('platform.ownersPage.resetSent')
              : isSending
                ? t('platform.ownersPage.resetSending')
                : t('platform.ownersPage.sendPasswordReset')}
          </Button>
        )
      },
    },
  ]

  return (
    <div>
      <PageHeader title={t('platform.ownersPage.title')} description={t('platform.ownersPage.description')} />

      {/* PERSONA COUNCIL AUDIT (2026-08-25) -- Platform Owner persona,
          same silent-read-error pattern as PlatformOverviewPage/
          PlatformClubsPage. */}
      {isError && (
        <ErrorState
          message={translateSupabaseError(error, t('platform.ownersPage.loadError', { defaultValue: 'Could not load club owners.' }))}
          onRetry={() => void refetch()}
          className="mb-4"
        />
      )}

      {/* Cross-phase directive (U1): Platform Owner accounts, previously
          invisible anywhere on the console -- only discoverable via a
          direct DB query. A distinct section, not merged into the
          club-owner table below, since these are a genuinely different
          user category (platform-wide authority, not tied to any one
          club's billing/entitlements). */}
      {platformOwnerAccounts.length > 0 && (
        <div className="mb-6 rounded-lg border border-border p-4">
          <h2 className="mb-2 text-sm font-medium text-text-primary">{t('platform.ownersPage.platformOwnersHeading')}</h2>
          <div className="flex flex-col gap-2">
            {platformOwnerAccounts.map((acc) => (
              <div key={acc.user_id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <div>
                  <span className="font-medium">{acc.full_name ?? '—'}</span>
                  {acc.email && <span className="text-text-secondary"> · {acc.email}</span>}
                </div>
                {acc.club_count > 0 && (
                  <span className="text-xs text-text-secondary">
                    {t('platform.ownersPage.alsoClubOwnerOf', { count: acc.club_count })}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* FULL-PLATFORM AUDIT ROUND 2 (finding 2): these 3 cards now read
          from allOwnersForGrouping (a dedicated query over every
          matching row, see fetchAllOwnersForGrouping above), not the
          currently displayed page -- so the counts are exact rather
          than an "at least" estimate, and no longer silently
          understate when an owner's memberships straddle a page
          boundary. groupingError surfaces distinctly from the table's
          own isError below (a real Retry, not a silent 0). */}
      {groupingError && (
        <ErrorState
          message={translateSupabaseError(groupingErrorObj, t('platform.ownersPage.groupingLoadError', { defaultValue: 'Could not load owner grouping counts.' }))}
          onRetry={() => void refetchGrouping()}
          className="mb-4"
        />
      )}
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard
          label={t('platform.ownersPage.cards.uniqueOwners')}
          value={groupingLoading ? '—' : String(uniqueOwners)}
        />
        <StatCard
          label={t('platform.ownersPage.cards.totalMemberships')}
          value={String(totalCount)}
        />
        <StatCard
          label={t('platform.ownersPage.cards.multiClubOwners')}
          value={groupingLoading ? '—' : String(multiClubOwners)}
        />
      </div>
      <div className="mb-4 max-w-sm">
        <label htmlFor="platform-owners-search" className="sr-only">
          {t('platform.ownersPage.searchPlaceholder')}
        </label>
        <Input
          id="platform-owners-search"
          placeholder={t('platform.ownersPage.searchPlaceholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
      </div>
      {resetError && <p role="alert" className="mb-3 text-sm text-status-danger">{resetError}</p>}
      <DataTable
        columns={columns}
        rows={sortedFiltered}
        rowKey={(o) => o.membership_id}
        isLoading={isLoading}
        emptyTitle={debouncedSearch ? t('platform.ownersPage.emptyTitle') : t('platform.ownersPage.emptyTitleNoOwners')}
      />
      {totalCount > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-text-secondary">
          <span>{t('platform.ownersPage.resultCount', { count: totalCount })}</span>
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
