import { useTranslation } from 'react-i18next'
import { AlertTriangle, Building, CalendarClock, FileSignature, Wallet } from 'lucide-react'
import { StatCard } from '@/components/ui/stat-card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { translateSupabaseError } from '@/lib/errors'
import { useMutation, useQuery } from '@tanstack/react-query'
import { BellRing } from 'lucide-react'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Button } from '@/components/ui/button'
import { monthRange, useRentalReport } from './hooks'
import type { RentalStaffAlert } from './types'

function daysUntil(isoDate: string): number {
  const today = new Date()
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((new Date(`${isoDate}T00:00:00Z`).getTime() - start) / 86400000)
}

export function RentalsOverview({ onNavigateTab }: { onNavigateTab: (tab: 'spaces' | 'contracts' | 'dues') => void }) {
  const { t } = useTranslation()
  const { startDate, endDate } = monthRange()
  const { data, isLoading, isError, error, refetch } = useRentalReport(startDate, endDate)

  const { currentClubId } = useAuth()
  const { data: alerts = [], refetch: refetchAlerts } = useQuery({
    queryKey: ['rental-alerts', currentClubId],
    queryFn: async () => {
      const { data: d, error: rpcError } = await supabase.rpc('list_rental_alerts', { p_club_id: currentClubId! })
      if (rpcError) throw rpcError
      return (d ?? []) as unknown as RentalStaffAlert[]
    },
    enabled: !!currentClubId,
  })
  const markRead = useMutation({
    mutationFn: async () => {
      const { error: rpcError } = await supabase.rpc('mark_rental_alerts_read', { p_club_id: currentClubId! })
      if (rpcError) throw rpcError
    },
    onSuccess: () => void refetchAlerts(),
  })

  if (isLoading) return <Skeleton className="mt-6 h-40 w-full" />
  if (isError || !data) {
    return <ErrorState className="mt-6" message={translateSupabaseError(error, t('rentals.overview.loadError'))} onRetry={() => void refetch()} />
  }

  const occupancy = data.spaces_total > 0 ? Math.round((100 * data.spaces_occupied_today) / data.spaces_total) : 0

  return (
    <div className="mt-6 flex flex-col gap-6">
      {alerts.length > 0 && (
        <div className="rounded-lg border border-status-warning/40 bg-status-warning/5 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="flex items-center gap-1 font-medium"><BellRing className="size-4" />{t('rentals.alerts.title')}</p>
            <Button size="sm" variant="ghost" disabled={markRead.isPending} onClick={() => markRead.mutate()}>{t('rentals.alerts.markRead')}</Button>
          </div>
          <ul className="flex flex-col gap-1 text-sm">
            {alerts.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2">
                <span>{a.customer_name} · {a.space_name} · <bdi className="tabular-nums">{a.contract_number}</bdi></span>
                <span className="tabular-nums text-status-warning">
                  {daysUntil(a.end_date) <= 0 ? t('rentals.alerts.endsToday') : t('rentals.alerts.endsIn', { count: daysUntil(a.end_date), date: a.end_date })}
                  {a.renewed && ` · ${t('rentals.renew.renewedBadge')}`}
                </span>
              </li>
            ))}
          </ul>
          <button className="mt-2 text-xs text-accent-foreground hover:underline" onClick={() => onNavigateTab('contracts')}>{t('rentals.alerts.renewHint')}</button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <StatCard label={t('rentals.overview.spaces')} value={`${data.spaces_occupied_today} / ${data.spaces_total}`} icon={Building} />
        <StatCard label={t('rentals.overview.occupancy')} value={`${occupancy}%`} />
        <StatCard label={t('rentals.overview.activeContracts')} value={data.active_contracts} icon={FileSignature} />
        <StatCard label={t('rentals.overview.collectedThisMonth')} value={<MoneyDisplay amount={Number(data.collected_in_range)} size="lg" />} icon={Wallet} tone="success" />
        <StatCard label={t('rentals.overview.dueThisMonth')} value={<MoneyDisplay amount={Number(data.due_in_range)} size="lg" />} icon={CalendarClock} />
        <StatCard
          label={t('rentals.overview.overdue', { count: data.overdue_count })}
          value={<MoneyDisplay amount={Number(data.overdue_total)} size="lg" tone={Number(data.overdue_total) > 0 ? 'danger' : 'default'} />}
          icon={AlertTriangle}
          tone={Number(data.overdue_total) > 0 ? 'danger' : 'default'}
        />
        <StatCard label={t('reports.rentals.depositsHeld')} value={<MoneyDisplay amount={Number(data.deposits_held)} size="lg" />} />
        {Number(data.late_fees_in_range) > 0 && (
          <StatCard label={t('reports.rentals.lateFees')} value={<MoneyDisplay amount={Number(data.late_fees_in_range)} size="lg" />} />
        )}
        {Number(data.expenses_in_range) > 0 && (
          <StatCard label={t('reports.rentals.net')} value={<MoneyDisplay amount={Number(data.net_in_range)} size="lg" />} tone="success" />
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="font-medium">{t('rentals.overview.expiringSoon')}</p>
            <button className="text-xs text-accent-foreground hover:underline" onClick={() => onNavigateTab('contracts')}>{t('rentals.overview.viewContracts')}</button>
          </div>
          {data.expiring_soon.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('rentals.none')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {data.expiring_soon.map((c) => (
                <li key={c.contract_id} className="flex justify-between rounded-md border border-border p-2 text-sm">
                  <span>{c.customer_name} · {c.space_name}</span>
                  <span className="tabular-nums">{c.end_date}{c.renewed ? ` · ${t('rentals.renew.renewedBadge')}` : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="font-medium">{t('rentals.overview.bySpace')}</p>
            <button className="text-xs text-accent-foreground hover:underline" onClick={() => onNavigateTab('spaces')}>{t('rentals.overview.viewSpaces')}</button>
          </div>
          {data.by_space.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('rentals.none')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {data.by_space.map((s) => (
                <li key={s.space_id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                  <span>{s.space_name} <span className="text-xs text-text-secondary">· {s.occupied_today ? t('rentals.spaces.occupied') : t('rentals.spaces.vacant')}</span></span>
                  <span className="text-end">
                    <MoneyDisplay amount={Number(s.collected)} size="sm" />
                    {Number(s.expenses) > 0 && (
                      <span className="block text-xs text-text-secondary">
                        {t('reports.rentals.net')}: <MoneyDisplay amount={Number(s.net)} size="sm" />
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {data.overdue_count > 0 && (
        <button className="self-start text-sm text-status-danger hover:underline" onClick={() => onNavigateTab('dues')}>
          {t('rentals.overview.reviewDues', { count: data.overdue_count })}
        </button>
      )}
    </div>
  )
}
