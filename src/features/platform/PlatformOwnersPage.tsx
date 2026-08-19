import { useMemo, useState } from 'react'
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
  const { locale } = useDirection()
  const [search, setSearch] = useState('')
  const [resetSentFor, setResetSentFor] = useState<string | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)
  const { data: owners = [], isLoading } = useQuery({ queryKey: ['platform-owners'], queryFn: fetchOwners })

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
    () => [...filtered].sort((a, b) => (a.user_id === b.user_id ? 0 : (a.full_name ?? '').localeCompare(b.full_name ?? '', locale))),
    [filtered, locale],
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
            disabled={isSending || !o.email}
            onClick={() => sendResetMutation.mutate(o)}
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
      {resetError && <p role="alert" className="mb-3 text-sm text-status-danger">{resetError}</p>}
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
