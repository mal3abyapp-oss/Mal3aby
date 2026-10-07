import { useTranslation } from 'react-i18next'
import { AlertTriangle, Building, CalendarClock, FileSignature, Wallet } from 'lucide-react'
import { StatCard } from '@/components/ui/stat-card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { translateSupabaseError } from '@/lib/errors'
import { monthRange, useRentalReport } from './hooks'

export function RentalsOverview({ onNavigateTab }: { onNavigateTab: (tab: 'spaces' | 'contracts' | 'dues') => void }) {
  const { t } = useTranslation()
  const { startDate, endDate } = monthRange()
  const { data, isLoading, isError, error, refetch } = useRentalReport(startDate, endDate)

  if (isLoading) return <Skeleton className="mt-6 h-40 w-full" />
  if (isError || !data) {
    return <ErrorState className="mt-6" message={translateSupabaseError(error, t('rentals.overview.loadError'))} onRetry={() => void refetch()} />
  }

  const occupancy = data.spaces_total > 0 ? Math.round((100 * data.spaces_occupied_today) / data.spaces_total) : 0

  return (
    <div className="mt-6 flex flex-col gap-6">
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
