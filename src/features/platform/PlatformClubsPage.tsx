import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/app/providers/AuthProvider'
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
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CLUB_STATUS_LABELS, ACCESS_TONE, ACCESS_LABEL } from '@/features/platform/labels'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
import { Star, StarOff } from 'lucide-react'

// PLATFORM CLUB SELECTOR FOR LARGE SCALE (2026-08-26) -- the platform
// may hold hundreds/thousands of clubs. The previous implementation
// (Master IA/UX audit, Platform Owner phase, Audit 5) already fixed the
// original hard .limit(100) into real server-side .range() pagination,
// but every filter (status/access/reason/flagged) and ALL search
// (name/code only, never owner name/email/phone) still ran client-side
// against an ever-growing in-memory accumulation across "load more"
// clicks -- exactly the "giant dropdown" class of problem this
// directive names, just one level removed from a literal <select>.
// Replaced with a single server-side search_platform_clubs() RPC
// (search across club name/code + owner name/email/phone, all filters
// pushed to the database, real LIMIT/OFFSET pagination with a real
// total_count) plus Recent/Pinned clubs for fast repeat access.
const PAGE_SIZE = 25

type StatusFilter = 'all' | 'active' | 'suspended' | 'closed'
type AccessFilter = 'all' | 'full' | 'grace' | 'blocked'
type ReasonFilter = 'all' | 'no_subscription' | 'admin_suspended' | 'in_grace' | 'expired' | 'active'

interface ClubRow {
  id: string
  name_ar: string
  club_code: string
  club_country: string | null
  status: string
  created_at: string
  access: string
  reason: string
  flaggedDuplicate: boolean
  ownerNames: string[]
  ownerEmails: string[]
  ownerPhones: string[]
}

async function searchClubs(params: {
  search: string
  status: StatusFilter
  access: AccessFilter
  reason: ReasonFilter
  flaggedOnly: boolean
  includeTestFixtures: boolean
  page: number
}): Promise<{ rows: ClubRow[]; totalCount: number }> {
  const { data, error } = await supabase.rpc('search_platform_clubs', {
    p_search: params.search.trim() || undefined,
    p_status: params.status === 'all' ? undefined : params.status,
    p_access: params.access === 'all' ? undefined : params.access,
    p_reason: params.reason === 'all' ? undefined : params.reason,
    p_flagged_only: params.flaggedOnly,
    p_limit: PAGE_SIZE,
    p_offset: params.page * PAGE_SIZE,
    // Controlled Commercial Launch Gate, Phase 6 follow-up: QA/test/
    // demo tenant fixtures are excluded from this list by default
    // (server-side default false) so they don't clutter reports once
    // real tenants exist. Explicit opt-in via this toggle for support/
    // QA use -- see QA_DATA_ISOLATION.md.
    p_include_test_fixtures: params.includeTestFixtures,
  })
  if (error) throw error
  const rows: ClubRow[] = (data ?? []).map((r) => ({
    id: r.club_id,
    name_ar: r.club_name,
    club_code: r.club_code,
    club_country: r.club_country,
    status: r.club_status,
    created_at: r.created_at,
    access: r.access,
    reason: r.reason,
    flaggedDuplicate: r.flagged_duplicate,
    ownerNames: r.owner_names ?? [],
    ownerEmails: r.owner_emails ?? [],
    ownerPhones: r.owner_phones ?? [],
  }))
  return { rows, totalCount: Number((data as unknown as { total_count?: number }[])?.[0]?.total_count ?? 0) }
}

interface QuickClubOption {
  club_id: string
  club_name: string
  club_code: string
}

async function fetchRecentClubs(): Promise<QuickClubOption[]> {
  const { data, error } = await supabase.rpc('list_recent_platform_clubs', { p_limit: 8 })
  if (error) throw error
  return (data ?? []).map((r) => ({ club_id: r.club_id, club_name: r.club_name, club_code: r.club_code }))
}

async function fetchPinnedClubs(): Promise<QuickClubOption[]> {
  const { data, error } = await supabase.rpc('list_pinned_platform_clubs')
  if (error) throw error
  return (data ?? []).map((r) => ({ club_id: r.club_id, club_name: r.club_name, club_code: r.club_code }))
}

export function PlatformClubsPage() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [page, setPage] = useState(0)
  const [searchParams, setSearchParams] = useSearchParams()
  const [searchInput, setSearchInput] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [openingClub, setOpeningClub] = useState<{ id: string; name_ar: string } | null>(null)
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set())

  // Debounce search input -- avoid firing a server round trip on every
  // keystroke against a platform that may hold thousands of clubs.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchInput), 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => { setPage(0) }, [debouncedSearch])

  const statusFilter = (searchParams.get('status') as StatusFilter) || 'all'
  const accessFilter = (searchParams.get('access') as AccessFilter) || 'all'
  const reasonFilter = (searchParams.get('reason') as ReasonFilter) || 'all'
  const flaggedOnly = searchParams.get('flagged') === '1'
  const includeTestFixtures = searchParams.get('testFixtures') === '1'

  function updateParam(key: string, value: string) {
    const next = new URLSearchParams(searchParams)
    if (value === 'all') next.delete(key)
    else next.set(key, value)
    setSearchParams(next)
    setPage(0)
  }

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: ['platform-clubs-search', debouncedSearch, statusFilter, accessFilter, reasonFilter, flaggedOnly, includeTestFixtures, page],
    queryFn: () => searchClubs({ search: debouncedSearch, status: statusFilter, access: accessFilter, reason: reasonFilter, flaggedOnly, includeTestFixtures, page }),
    placeholderData: (prev) => prev,
  })
  const clubs = data?.rows ?? []
  const totalCount = data?.totalCount ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  const { data: recentClubs = [] } = useQuery({
    queryKey: ['platform-clubs-recent'],
    queryFn: fetchRecentClubs,
  })
  const { data: pinnedClubsList = [], refetch: refetchPinned } = useQuery({
    queryKey: ['platform-clubs-pinned'],
    queryFn: fetchPinnedClubs,
  })
  useEffect(() => {
    setPinnedIds(new Set(pinnedClubsList.map((c) => c.club_id)))
  }, [pinnedClubsList])

  const pinMutation = useMutation({
    mutationFn: async ({ clubId, pinned }: { clubId: string; pinned: boolean }) => {
      const { error: err } = pinned
        ? await supabase.rpc('unpin_platform_club', { p_club_id: clubId })
        : await supabase.rpc('pin_platform_club', { p_club_id: clubId })
      if (err) throw err
    },
    onSuccess: () => {
      void refetchPinned()
      void queryClient.invalidateQueries({ queryKey: ['platform-clubs-pinned'] })
    },
  })

  const columns: DataTableColumn<ClubRow>[] = [
    {
      key: 'name',
      header: t('platform.clubsPage.columns.club'),
      // Design remediation (mobile brief): this column already reads as
      // a natural card title (pin toggle + club name link + duplicate
      // badge) -- becomes the mobile card's title line.
      cardPriority: 'primary',
      render: (c) => (
        <div className="flex items-center gap-2">
          <button
            onClick={() => pinMutation.mutate({ clubId: c.id, pinned: pinnedIds.has(c.id) })}
            className="text-text-secondary hover:text-accent-foreground"
            aria-label={pinnedIds.has(c.id) ? t('platform.clubsPage.unpin') : t('platform.clubsPage.pin')}
            title={pinnedIds.has(c.id) ? t('platform.clubsPage.unpin') : t('platform.clubsPage.pin')}
          >
            {pinnedIds.has(c.id) ? <Star className="size-4 fill-current" /> : <StarOff className="size-4" />}
          </button>
          <Link to={`/platform/clubs/${c.id}`} className="font-medium text-accent-foreground hover:underline">
            {c.name_ar}
          </Link>
          {c.flaggedDuplicate && (
            <StatusBadge tone="warning" label={t('platform.clubsPage.flaggedDuplicate')} />
          )}
        </div>
      ),
    },
    { key: 'code', header: t('platform.clubsPage.columns.code'), render: (c) => <bdi>{c.club_code}</bdi> },
    {
      // PLATFORM CLUB SELECTOR (2026-08-26) -- Mandatory search field
      // "Owner name" / "Owner email" now needs to be visibly matched
      // somewhere in the row, not just searchable -- otherwise a
      // Platform Owner searching by owner email has no way to confirm
      // WHICH result matched.
      key: 'owner',
      header: t('platform.clubsPage.columns.owner'),
      render: (c) => (
        <div className="flex flex-col text-sm">
          <span>{c.ownerNames[0] ?? '—'}</span>
          {c.ownerEmails[0] && <span className="text-xs text-text-secondary" dir="ltr">{c.ownerEmails[0]}</span>}
        </div>
      ),
    },
    {
      key: 'createdAt',
      header: t('platform.clubsPage.columns.createdAt'),
      render: (c) => <bdi>{new Date(c.created_at).toLocaleDateString()}</bdi>,
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
    {
      key: 'masterAdminActions',
      header: '',
      // On mobile cards this same action renders once via
      // renderCardActions below instead of as a body row.
      hideOnCard: true,
      render: (c) => (
        <Button variant="outline" size="sm" onClick={() => setOpeningClub({ id: c.id, name_ar: c.name_ar })}>
          {t('masterAdmin.openAction')}
        </Button>
      ),
    },
  ]

  const hasActiveFilters = statusFilter !== 'all' || accessFilter !== 'all' || reasonFilter !== 'all' || flaggedOnly || includeTestFixtures

  return (
    <div>
      <PageHeader title={t('platform.clubsPage.title')} description={t('platform.clubsPage.description')} />

      {isError && (
        <ErrorState
          message={translateSupabaseError(error, t('platform.clubsPage.loadError', { defaultValue: 'Could not load clubs.' }))}
          onRetry={() => void refetch()}
          className="mb-4"
        />
      )}

      {/* PLATFORM CLUB SELECTOR (2026-08-26) -- "Recent Clubs" and
          "Pinned/Favorite Clubs" for fast repeat access, per the
          directive. Only rendered when non-empty -- no permanent empty
          shelf taking up space for a Platform Owner who hasn't used
          either yet. */}
      {(pinnedClubsList.length > 0 || recentClubs.length > 0) && (
        <div className="mb-4 flex flex-col gap-3">
          {pinnedClubsList.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold text-text-secondary">{t('platform.clubsPage.pinnedClubs')}</p>
              <div className="flex flex-wrap gap-2">
                {pinnedClubsList.map((c) => (
                  <Link
                    key={c.club_id}
                    to={`/platform/clubs/${c.club_id}`}
                    className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium hover:border-accent-foreground"
                  >
                    {c.club_name}
                  </Link>
                ))}
              </div>
            </div>
          )}
          {recentClubs.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-semibold text-text-secondary">{t('platform.clubsPage.recentClubs')}</p>
              <div className="flex flex-wrap gap-2">
                {recentClubs.map((c) => (
                  <Link
                    key={c.club_id}
                    to={`/platform/clubs/${c.club_id}`}
                    className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium hover:border-accent-foreground"
                  >
                    {c.club_name}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          placeholder={t('platform.clubsPage.searchPlaceholder')}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
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
        <Button
          variant={includeTestFixtures ? 'default' : 'outline'}
          size="sm"
          onClick={() => updateParam('testFixtures', includeTestFixtures ? 'all' : '1')}
          title={t('platform.clubsPage.filters.includeTestFixturesHint')}
        >
          {t('platform.clubsPage.filters.includeTestFixtures')}
        </Button>
        {hasActiveFilters && (
          <Button variant="outline" size="sm" onClick={() => setSearchParams({})}>
            {t('platform.clubsPage.filters.clear')}
          </Button>
        )}
      </div>

      {/* Design remediation (premium-ui-ux-audit, mobile brief): this is
          the highest-traffic Platform Owner list (6 columns + a
          per-row action) -- opts into the existing 'cards-on-mobile'
          variant instead of forced horizontal scroll on narrow
          viewports. Same rows/columns/links/actions, presentation only. */}
      <DataTable
        columns={columns}
        rows={clubs}
        rowKey={(c) => c.id}
        isLoading={isLoading}
        emptyTitle={t('platform.clubsPage.emptyTitle')}
        variant="cards-on-mobile"
        renderCardActions={(c) => (
          <Button variant="outline" size="sm" onClick={() => setOpeningClub({ id: c.id, name_ar: c.name_ar })}>
            {t('masterAdmin.openAction')}
          </Button>
        )}
      />

      {totalCount > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-text-secondary">
          <span>{t('platform.clubsPage.resultCount', { count: totalCount })}</span>
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

      {openingClub && (
        <OpenAsMasterAdminDialog club={openingClub} onClose={() => setOpeningClub(null)} />
      )}
    </div>
  )
}

// MASTER ADMIN / PLATFORM SUPPORT CONTEXT -- explicit mode selection
// (View / Manage, default View per directive Section 5) and an optional
// support reason, requested only ONCE here at session start (directive
// Section 14: never re-prompt on every subsequent click once the session
// is active). On confirm, calls the real start_platform_support_session
// RPC via AuthProvider's startSupportSession(), then navigates into the
// normal /app shell -- which will now resolve currentClubId to this
// club because of AuthProvider's own support-session override, and show
// the persistent MasterAdminBanner on every page from here on.
function OpenAsMasterAdminDialog({ club, onClose }: { club: { id: string; name_ar: string }; onClose: () => void }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { startSupportSession } = useAuth()
  const [mode, setMode] = useState<'view' | 'manage'>('view')
  const [reason, setReason] = useState('')

  const openMutation = useMutation({
    mutationFn: () => startSupportSession(club.id, mode, reason.trim() || undefined),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['app-subscription-summary'] })
      void queryClient.invalidateQueries({ queryKey: ['platform-clubs-recent'] })
      navigate('/app', { replace: true })
    },
  })

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('masterAdmin.openDialog.title', { club: club.name_ar })}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('masterAdmin.openDialog.modeLabel')}</label>
            <div className="flex flex-col gap-2">
              <label className="flex items-start gap-2 rounded-md border border-border p-2.5 text-sm has-[:checked]:border-accent-foreground has-[:checked]:bg-accent/5">
                <input type="radio" name="support-mode" className="mt-0.5" checked={mode === 'view'} onChange={() => setMode('view')} />
                {t('masterAdmin.openDialog.modeView')}
              </label>
              <label className="flex items-start gap-2 rounded-md border border-border p-2.5 text-sm has-[:checked]:border-accent-foreground has-[:checked]:bg-accent/5">
                <input type="radio" name="support-mode" className="mt-0.5" checked={mode === 'manage'} onChange={() => setMode('manage')} />
                {t('masterAdmin.openDialog.modeManage')}
              </label>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('masterAdmin.openDialog.reasonLabel')}</label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('masterAdmin.openDialog.reasonPlaceholder')} />
          </div>
          {openMutation.isError && (
            <p role="alert" className="text-sm text-status-danger">{t('masterAdmin.openDialog.error')}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>{t('masterAdmin.openDialog.cancel')}</Button>
            <Button disabled={openMutation.isPending || !reason.trim()} onClick={() => openMutation.mutate()}>
              {openMutation.isPending ? t('masterAdmin.openDialog.opening') : t('masterAdmin.openDialog.open')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
