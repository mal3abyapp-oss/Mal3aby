import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
import type { SelectedCustomer } from '@/components/ui/customer-selector'
import { RENTAL_CONTRACT_STATUS_TONE, rentCycleLabel } from '@/lib/domain/rental'
import { useInvalidateRentals, useRentalContracts, useRentalPermissions } from './hooks'
import type { RentalContractRow } from './types'
import { NewContractDialog } from './NewContractDialog'
import { ContractDetailDialog } from './ContractDetailDialog'

// Customer 360 "Rentals" tab: every lease contract this customer holds as
// a tenant, with paid / overdue at a glance.
export function CustomerRentalsTab({ customer, onChanged }: { customer: SelectedCustomer; onChanged: () => void }) {
  const { t } = useTranslation()
  const { canCreateContracts } = useRentalPermissions()
  const invalidateRentals = useInvalidateRentals()
  const [newOpen, setNewOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { data: contracts = [], isLoading, isError, error, refetch } = useRentalContracts({ customerId: customer.id })

  function invalidate() {
    invalidateRentals()
    onChanged()
  }

  const columns: DataTableColumn<RentalContractRow>[] = [
    {
      key: 'number',
      header: t('rentals.contracts.number'),
      render: (c) => (
        <button className="tabular-nums text-accent-foreground hover:underline" onClick={() => setSelectedId(c.id)}>
          <bdi>{c.contract_number}</bdi>
        </button>
      ),
    },
    { key: 'space', header: t('rentals.contracts.space'), render: (c) => c.space_name },
    { key: 'cycle', header: t('rentals.contracts.cycle'), render: (c) => rentCycleLabel(t, c.rent_cycle, c.custom_cycle_value, c.custom_cycle_unit) },
    { key: 'period', header: t('rentals.contracts.period'), render: (c) => <span className="text-xs tabular-nums"><bdi>{c.start_date} → {c.termination_date ?? c.end_date}</bdi></span> },
    { key: 'paid', header: t('rentals.contracts.paid'), render: (c) => <MoneyDisplay amount={Number(c.paid)} size="sm" /> },
    {
      key: 'overdue',
      header: t('rentals.contracts.overdue'),
      render: (c) => Number(c.overdue_amount) > 0 ? <MoneyDisplay amount={Number(c.overdue_amount)} size="sm" tone="danger" /> : '—',
    },
    {
      key: 'status',
      header: t('common.status', { defaultValue: 'Status' }),
      render: (c) => <StatusBadge tone={RENTAL_CONTRACT_STATUS_TONE[c.display_status] ?? 'neutral'} label={t(`rentals.contracts.statusLabels.${c.display_status}`)} />,
    },
  ]

  return (
    <div className="mt-4 flex flex-col gap-3">
      {canCreateContracts && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setNewOpen(true)}>{t('rentals.contracts.new')}</Button>
        </div>
      )}
      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('rentals.contracts.loadError'))} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={contracts}
          rowKey={(c) => c.id}
          isLoading={isLoading}
          emptyTitle={t('rentals.contracts.emptyTitle')}
          emptyDescription={t('rentals.contracts.customerEmpty')}
        />
      )}
      {newOpen && (
        <NewContractDialog initialCustomer={customer} onClose={() => setNewOpen(false)} onCreated={() => { setNewOpen(false); invalidate() }} />
      )}
      {selectedId && (
        <ContractDetailDialog contractId={selectedId} onClose={() => setSelectedId(null)} onChanged={invalidate} />
      )}
    </div>
  )
}
