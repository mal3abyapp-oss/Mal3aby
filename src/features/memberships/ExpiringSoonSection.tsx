import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { StatusBadge } from '@/components/ui/status-badge'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { CLUB_MEMBERSHIP_STATUS_TONE } from '@/lib/domain/clubMembership'
import { MemberDetailDialog } from './MemberDetailDialog'

// Expiring Soon tab -- active memberships expiring within 7 days, via
// list_club_membership_subscriptions' own p_expiring_within_days filter
// (no client-side date math needed for the source-of-truth list).

interface MemberRow {
  membership_subscription_id: string
  membership_number: string
  customer_name: string
  customer_mobile: string | null
  plan_name_ar_snapshot: string
  plan_name_en_snapshot: string
  effective_status: string
  effective_end_date: string
  branch_name: string
}

interface ListResult { total_count: number; rows: MemberRow[] }

async function fetchExpiring(clubId: string): Promise<MemberRow[]> {
  const { data, error } = await supabase.rpc('list_club_membership_subscriptions', {
    p_club_id: clubId,
    p_status: 'active',
    p_expiring_within_days: 7,
    p_page: 1,
    p_page_size: 100,
  })
  if (error) throw error
  return (data as unknown as ListResult).rows
}

export function ExpiringSoonSection() {
  const { t, i18n } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['club-membership-expiring', currentClubId],
    queryFn: () => fetchExpiring(currentClubId!),
    enabled: !!currentClubId,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['club-membership-expiring', currentClubId] })
  }

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
    { key: 'mobile', header: t('common.phone'), render: (m) => m.customer_mobile ? <span dir="ltr">{m.customer_mobile}</span> : '—' },
    { key: 'plan', header: t('clubMemberships.membershipPlan'), render: (m) => i18n.language === 'en' ? m.plan_name_en_snapshot : m.plan_name_ar_snapshot },
    { key: 'branch', header: t('clubMemberships.branch'), render: (m) => m.branch_name },
    { key: 'expiry', header: t('clubMemberships.expiryDate'), render: (m) => <span className="tabular-nums">{m.effective_end_date}</span> },
    {
      key: 'status',
      header: t('common.status', { defaultValue: 'Status' }),
      render: (m) => <StatusBadge tone={CLUB_MEMBERSHIP_STATUS_TONE[m.effective_status] ?? 'neutral'} label={t(`clubMemberships.statusLabels.${m.effective_status}`, { defaultValue: m.effective_status })} />,
    },
  ]

  return (
    <div className="mt-6 flex flex-col gap-4">
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(m) => m.membership_subscription_id}
        isLoading={isLoading}
        emptyTitle={t('clubMemberships.expiring.emptyTitle')}
        emptyDescription={t('clubMemberships.expiring.emptyDescription')}
      />

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
