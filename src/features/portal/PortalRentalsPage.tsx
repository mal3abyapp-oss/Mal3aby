import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Building } from 'lucide-react'
import { translateSupabaseError } from '@/lib/errors'
import { PageHeader } from '@/components/ui/page-header'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { usePortalClub } from '@/app/providers/PortalClubProvider'
import { RENTAL_PAYMENT_STATE_TONE, rentalSpaceTypeLabel, rentCycleLabel } from '@/lib/domain/rental'
import { fetchMyPortalRentals } from './portalRentals'

// Customer Portal -- "My Rentals": the tenant's own leases/hall bookings
// with the installment schedule and what is paid, due and overdue.
// Read-only; paying happens on /portal/payments like every other
// invoice (rental installments are ordinary invoices). Data comes from
// get_my_portal_rentals() (auth.uid() resolved server-side).

export function PortalRentalsPage() {
  const { t } = useTranslation()
  const { activeClubId, isLoading: clubLoading } = usePortalClub()
  const { data: all = [], isLoading, error, refetch } = useQuery({
    queryKey: ['portal', 'my-rentals'],
    queryFn: fetchMyPortalRentals,
    enabled: !clubLoading,
  })
  const contracts = all.filter((c) => !activeClubId || c.club_id === activeClubId)

  return (
    <div>
      <PageHeader title={t('portal.rentals.title')} description={t('portal.rentals.description')} />
      {(isLoading || clubLoading) && <Skeleton className="h-40 w-full" />}
      {error && <ErrorState message={translateSupabaseError(error, t('portal.rentals.loadError'))} onRetry={() => void refetch()} />}
      {!isLoading && !error && contracts.length === 0 && <EmptyState icon={Building} title={t('portal.rentals.empty')} />}

      <div className="flex flex-col gap-4">
        {contracts.map((c) => {
          const outstanding = c.installments.reduce((sum, i) => sum + Number(i.outstanding), 0)
          const overdue = c.installments.filter((i) => i.payment_state === 'overdue').reduce((sum, i) => sum + Number(i.outstanding), 0)
          const next = c.installments.find((i) => ['scheduled', 'due_not_invoiced', 'unpaid', 'partial', 'overdue'].includes(i.payment_state))
          return (
            <div key={c.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{c.space_name}</p>
                  <p className="text-xs text-text-secondary">
                    {rentalSpaceTypeLabel(t, c.space_type, c.custom_type_label)} · {c.branch_name} · <bdi className="tabular-nums">{c.contract_number}</bdi>
                  </p>
                </div>
                <StatusBadge
                  tone={c.status === 'active' ? 'success' : 'neutral'}
                  label={t(`rentals.contracts.statusLabels.${c.status}`)}
                />
              </div>
              <p className="mt-2 text-sm tabular-nums">
                {c.rent_cycle === 'hourly'
                  ? <bdi>{c.start_date} {c.start_time?.slice(0, 5)}–{c.end_time?.slice(0, 5)}</bdi>
                  : <><bdi>{c.start_date} → {c.termination_date ?? c.end_date}</bdi> · {rentCycleLabel(t, c.rent_cycle, c.custom_cycle_value, c.custom_cycle_unit)}</>}
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <div className="rounded-lg border border-border p-2">
                  <p className="text-xs text-text-secondary">{t('portal.rentals.outstanding')}</p>
                  <MoneyDisplay amount={outstanding} />
                </div>
                <div className="rounded-lg border border-border p-2">
                  <p className="text-xs text-text-secondary">{t('portal.rentals.overdue')}</p>
                  <MoneyDisplay amount={overdue} tone={overdue > 0 ? 'danger' : undefined} />
                </div>
              </div>
              {next && (
                <p className="mt-2 text-xs text-text-secondary">
                  {t('portal.rentals.nextDue', { date: next.due_date })} · <MoneyDisplay amount={Number(next.outstanding) > 0 ? Number(next.outstanding) : Number(next.amount)} size="sm" />
                </p>
              )}
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-accent-foreground">{t('portal.rentals.schedule', { count: c.installments.length })}</summary>
                <ul className="mt-2 flex flex-col divide-y divide-border-subtle">
                  {c.installments.map((i) => (
                    <li key={`${i.kind}-${i.sequence}`} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="flex flex-col">
                        <span>
                          {i.kind === 'deposit' ? t('rentals.detail.depositShort') : i.kind === 'late_fee' ? t('rentals.detail.lateFeeShort') : `#${i.sequence}`}
                          <span className="ms-1 text-xs text-text-secondary tabular-nums">{i.due_date}</span>
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <MoneyDisplay amount={Number(i.amount)} size="sm" />
                        <StatusBadge tone={RENTAL_PAYMENT_STATE_TONE[i.payment_state] ?? 'neutral'} label={t(`rentals.paymentStates.${i.payment_state}`)} />
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
              {outstanding > 0 && (
                <Button asChild size="sm" className="mt-3">
                  <Link to="/portal/payments">{t('portal.rentals.pay')}</Link>
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
