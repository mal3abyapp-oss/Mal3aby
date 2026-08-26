import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { StatCard } from '@/components/ui/stat-card'
import { IdCard, Clock, Snowflake, AlertTriangle } from 'lucide-react'

// Overview tab -- simple stat cards derived client-side from
// list_club_membership_subscriptions (status + expiring-within-days
// filters), no new backend needed. Mirrors StatCard usage in
// Customer360Page.tsx/CashShiftPage.tsx.

interface CountResult { total_count: number }

async function fetchCount(clubId: string, status: string | undefined, expiringWithinDays: number | undefined): Promise<number> {
  const { data, error } = await supabase.rpc('list_club_membership_subscriptions', {
    p_club_id: clubId,
    p_status: status,
    p_expiring_within_days: expiringWithinDays,
    p_page: 1,
    p_page_size: 1,
  })
  if (error) throw error
  return (data as unknown as CountResult).total_count
}

export function MembershipsOverview({ onNavigateTab }: { onNavigateTab: (tab: 'overview' | 'plans' | 'members' | 'expiring') => void }) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()

  const { data: activeCount = 0 } = useQuery({
    queryKey: ['club-membership-count', currentClubId, 'active'],
    queryFn: () => fetchCount(currentClubId!, 'active', undefined),
    enabled: !!currentClubId,
  })
  const { data: scheduledCount = 0 } = useQuery({
    queryKey: ['club-membership-count', currentClubId, 'scheduled'],
    queryFn: () => fetchCount(currentClubId!, 'scheduled', undefined),
    enabled: !!currentClubId,
  })
  const { data: frozenCount = 0 } = useQuery({
    queryKey: ['club-membership-count', currentClubId, 'frozen'],
    queryFn: () => fetchCount(currentClubId!, 'frozen', undefined),
    enabled: !!currentClubId,
  })
  const { data: expiringCount = 0 } = useQuery({
    queryKey: ['club-membership-count', currentClubId, 'expiring7'],
    queryFn: () => fetchCount(currentClubId!, 'active', 7),
    enabled: !!currentClubId,
  })

  return (
    <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
      <StatCard label={t('clubMemberships.overview.totalActive')} value={String(activeCount)} icon={IdCard} tone="success" />
      <StatCard label={t('clubMemberships.overview.scheduled')} value={String(scheduledCount)} icon={Clock} tone="default" />
      <StatCard label={t('clubMemberships.overview.frozen')} value={String(frozenCount)} icon={Snowflake} tone="warning" />
      <StatCard
        label={t('clubMemberships.overview.expiringSoon')}
        value={String(expiringCount)}
        icon={AlertTriangle}
        tone={expiringCount > 0 ? 'danger' : 'default'}
      />
      <button className="col-span-2 text-start md:col-span-4" onClick={() => onNavigateTab('expiring')}>
        <p className="text-xs text-accent-foreground hover:underline">{t('clubMemberships.overview.viewExpiringLink')}</p>
      </button>
    </div>
  )
}
