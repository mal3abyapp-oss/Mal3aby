import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { Input } from '@/components/ui/input'
import { CLUB_STATUS_LABELS } from '@/features/platform/labels'

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

async function fetchOwners(): Promise<OwnerRow[]> {
  const { data, error } = await supabase.rpc('get_platform_club_owners')
  if (error) throw error
  return (data ?? []) as OwnerRow[]
}

const MEMBERSHIP_STATUS_LABELS: Record<string, string> = { active: 'نشطة', suspended: 'موقوفة', removed: 'ملغاة' }

export function PlatformOwnersPage() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const { data: owners = [], isLoading } = useQuery({ queryKey: ['platform-owners'], queryFn: fetchOwners })

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return owners
    return owners.filter(
      (o) =>
        (o.full_name ?? '').toLowerCase().includes(q) ||
        (o.email ?? '').toLowerCase().includes(q) ||
        (o.phone ?? '').toLowerCase().includes(q) ||
        o.club_name.toLowerCase().includes(q) ||
        o.club_code.toLowerCase().includes(q),
    )
  }, [owners, search])

  const ownerClubCounts = new Map<string, number>()
  for (const o of owners) ownerClubCounts.set(o.user_id, (ownerClubCounts.get(o.user_id) ?? 0) + 1)
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
    () => [...filtered].sort((a, b) => (a.user_id === b.user_id ? 0 : (a.full_name ?? '').localeCompare(b.full_name ?? '', 'ar'))),
    [filtered],
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
    { key: 'since', header: t('platform.ownersPage.columns.since'), render: (o) => new Date(o.owner_since).toLocaleDateString('ar-EG') },
  ]

  return (
    <div>
      <PageHeader title={t('platform.ownersPage.title')} description={t('platform.ownersPage.description')} />
      <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-3">
        <StatCard label={t('platform.ownersPage.cards.uniqueOwners')} value={String(uniqueOwners)} />
        <StatCard label={t('platform.ownersPage.cards.totalMemberships')} value={String(owners.length)} />
        <StatCard label={t('platform.ownersPage.cards.multiClubOwners')} value={String(multiClubOwners)} />
      </div>
      <div className="mb-4 max-w-sm">
        <Input
          placeholder={t('platform.ownersPage.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <DataTable
        columns={columns}
        rows={sortedFiltered}
        rowKey={(o) => o.membership_id}
        isLoading={isLoading}
        emptyTitle={search ? t('platform.ownersPage.emptyTitle') : t('platform.ownersPage.emptyTitleNoOwners')}
      />
    </div>
  )
}
