import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { RENTAL_CONTRACT_STATUS_TONE, rentCycleLabel } from '@/lib/domain/rental'
import { useInvalidateRentals, useRentalContracts, useRentalPermissions } from './hooks'
import type { RentalContractRow } from './types'
import { NewContractDialog } from './NewContractDialog'
import { ContractDetailDialog } from './ContractDetailDialog'

const STATUS_FILTERS = ['active', 'expired', 'terminated', 'cancelled'] as const

export function ContractsSection() {
  const { t } = useTranslation()
  const { canCreateContracts } = useRentalPermissions()
  const invalidate = useInvalidateRentals()
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [newOpen, setNewOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const { data: contracts = [], isLoading, isError, error, refetch } = useRentalContracts({ status })

  const q = search.trim().toLowerCase()
  const rows = q
    ? contracts.filter((c) =>
        c.customer_name.toLowerCase().includes(q)
        || c.contract_number.toLowerCase().includes(q)
        || c.space_name.toLowerCase().includes(q)
        || (c.customer_mobile ?? '').includes(q))
    : contracts

  const columns: DataTableColumn<RentalContractRow>[] = [
    {
      key: 'tenant',
      header: t('rentals.contracts.tenant'),
      cardPriority: 'primary',
      render: (c) => (
        <button className="text-start font-medium text-accent-foreground hover:underline" onClick={() => setSelectedId(c.id)}>
          {c.customer_name}
          <span className="block text-xs text-text-secondary tabular-nums"><bdi>{c.contract_number}</bdi></span>
        </button>
      ),
    },
    { key: 'space', header: t('rentals.contracts.space'), render: (c) => c.space_name },
    {
      key: 'cycle',
      header: t('rentals.contracts.cycle'),
      render: (c) => (
        <span className="flex flex-col">
          <span>{rentCycleLabel(t, c.rent_cycle, c.custom_cycle_value, c.custom_cycle_unit)}</span>
          <MoneyDisplay amount={Number(c.cycle_amount)} size="sm" className="text-text-secondary" />
        </span>
      ),
    },
    {
      key: 'period',
      header: t('rentals.contracts.period'),
      render: (c) => <span className="text-xs tabular-nums"><bdi>{c.start_date} → {c.termination_date ?? c.end_date}</bdi></span>,
    },
    { key: 'paid', header: t('rentals.contracts.paid'), render: (c) => <MoneyDisplay amount={Number(c.paid)} size="sm" tone="success" /> },
    {
      key: 'overdue',
      header: t('rentals.contracts.overdue'),
      render: (c) => Number(c.overdue_amount) > 0
        ? <MoneyDisplay amount={Number(c.overdue_amount)} size="sm" tone="danger" />
        : <span className="text-text-secondary">—</span>,
    },
    {
      key: 'status',
      header: t('common.status', { defaultValue: 'Status' }),
      render: (c) => (
        <StatusBadge
          tone={RENTAL_CONTRACT_STATUS_TONE[c.display_status] ?? 'neutral'}
          label={t(`rentals.contracts.statusLabels.${c.display_status}`)}
        />
      ),
    },
  ]

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          <Input placeholder={t('rentals.contracts.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
          <Select value={status || 'all'} onValueChange={(v) => setStatus(v === 'all' ? '' : v)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('rentals.contracts.allStatuses')}</SelectItem>
              {STATUS_FILTERS.map((s) => <SelectItem key={s} value={s}>{t(`rentals.contracts.statusLabels.${s}`)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {canCreateContracts && (
          <Button size="sm" onClick={() => setNewOpen(true)}><Plus />{t('rentals.contracts.new')}</Button>
        )}
      </div>

      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('rentals.contracts.loadError'))} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(c) => c.id}
          isLoading={isLoading}
          variant="cards-on-mobile"
          emptyTitle={t('rentals.contracts.emptyTitle')}
          emptyDescription={t('rentals.contracts.emptyDescription')}
        />
      )}

      {newOpen && (
        <NewContractDialog onClose={() => setNewOpen(false)} onCreated={() => { setNewOpen(false); invalidate() }} />
      )}
      {selectedId && (
        <ContractDetailDialog contractId={selectedId} onClose={() => setSelectedId(null)} onChanged={invalidate} />
      )}
    </div>
  )
}
