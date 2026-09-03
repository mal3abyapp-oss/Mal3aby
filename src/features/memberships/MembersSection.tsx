import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogTrigger } from '@/components/ui/dialog'
import { CLUB_MEMBERSHIP_STATUS_TONE } from '@/lib/domain/clubMembership'
import { SellMembershipWizard } from './SellMembershipWizard'
import { MemberDetailDialog } from './MemberDetailDialog'

// Club Memberships -- Members tab. Searchable/filterable/paginated list
// via list_club_membership_subscriptions, mirroring PlayersSection.tsx's
// own table+filter+dialog shape.

interface MemberRow {
  membership_subscription_id: string
  membership_number: string
  customer_id: string
  customer_name: string
  customer_mobile: string | null
  plan_id: string
  plan_name_ar_snapshot: string
  plan_name_en_snapshot: string
  status: string
  effective_status: string
  start_date: string
  end_date: string
  effective_end_date: string
  branch_id: string
  branch_name: string
}

interface ListResult { total_count: number; page: number; page_size: number; rows: MemberRow[] }

const PAGE_SIZE = 25

async function fetchMembers(clubId: string, search: string, status: string, page: number): Promise<ListResult> {
  const { data, error } = await supabase.rpc('list_club_membership_subscriptions', {
    p_club_id: clubId,
    p_search: search.trim() || undefined,
    p_status: status || undefined,
    p_page: page,
    p_page_size: PAGE_SIZE,
  })
  if (error) throw error
  return data as unknown as ListResult
}

const STATUS_OPTIONS = ['pending_payment', 'scheduled', 'active', 'frozen', 'expired', 'cancelled'] as const

export function MembersSection() {
  const { t, i18n } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [page, setPage] = useState(1)
  const [sellOpen, setSellOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Finding H-2 (frozen production audit): this list previously
  // destructured only `data, isLoading` -- a failed fetch silently
  // rendered as "no club memberships" via DataTable's own empty state,
  // indistinguishable from a club that genuinely has none. isError/
  // error/refetch are now surfaced so a fetch failure shows an explicit
  // error, never a false "empty" signal.
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['club-membership-members', currentClubId, search, status, page],
    queryFn: () => fetchMembers(currentClubId!, search, status, page),
    enabled: !!currentClubId,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['club-membership-members', currentClubId] })
  }

  const rows = data?.rows ?? []
  const totalCount = data?.total_count ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  const columns: DataTableColumn<MemberRow>[] = [
    {
      key: 'customer',
      header: t('common.name'),
      render: (m) => (
        <button className="text-start font-medium text-accent-foreground hover:underline" onClick={() => setSelectedId(m.membership_subscription_id)}>
          {m.customer_name}
        </button>
      ),
    },
    { key: 'number', header: t('clubMemberships.membershipNumber'), render: (m) => <span className="tabular-nums"><bdi>{m.membership_number}</bdi></span> },
    { key: 'plan', header: t('clubMemberships.membershipPlan'), render: (m) => i18n.language === 'en' ? m.plan_name_en_snapshot : m.plan_name_ar_snapshot },
    { key: 'branch', header: t('clubMemberships.branch'), render: (m) => m.branch_name },
    { key: 'expiry', header: t('clubMemberships.expiryDate'), render: (m) => <span className="tabular-nums">{m.effective_end_date}</span> },
    {
      key: 'status',
      header: t('common.status', { defaultValue: 'Status' }),
      render: (m) => (
        <StatusBadge
          tone={CLUB_MEMBERSHIP_STATUS_TONE[m.effective_status] ?? 'neutral'}
          label={t(`clubMemberships.statusLabels.${m.effective_status}`, { defaultValue: m.effective_status })}
        />
      ),
    },
  ]

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Input placeholder={t('clubMemberships.members.searchPlaceholder')} value={search} onChange={(e) => { setSearch(e.target.value); setPage(1) }} className="max-w-xs" />
          <Select value={status || 'all'} onValueChange={(v) => { setStatus(v === 'all' ? '' : v); setPage(1) }}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('clubMemberships.members.allStatuses')}</SelectItem>
              {STATUS_OPTIONS.map((s) => <SelectItem key={s} value={s}>{t(`clubMemberships.statusLabels.${s}`)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Dialog open={sellOpen} onOpenChange={setSellOpen}>
          <DialogTrigger asChild>
            <Button size="sm">{t('clubMemberships.sell.title')}</Button>
          </DialogTrigger>
          {sellOpen && (
            <SellMembershipWizard
              onClose={() => setSellOpen(false)}
              onSold={() => { setSellOpen(false); invalidate() }}
            />
          )}
        </Dialog>
      </div>

      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('clubMemberships.members.loadError'))} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(m) => m.membership_subscription_id}
          isLoading={isLoading}
          emptyTitle={t('clubMemberships.members.emptyTitle')}
          emptyDescription={t('clubMemberships.members.emptyDescription')}
        />
      )}

      {totalPages > 1 && !isError && (
        <div className="flex items-center justify-between text-sm text-text-secondary">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t('common.previous', { defaultValue: 'Previous' })}</Button>
          <span>{t('common.pageOfTotal', { page, total: totalPages })}</span>
          <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>{t('common.next', { defaultValue: 'Next' })}</Button>
        </div>
      )}

      {selectedId && (
        <MemberDetailDialog
          membershipId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={invalidate}
        />
      )}
    </div>
  )
}
