import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
import { RENTAL_PAYMENT_STATE_TONE } from '@/lib/domain/rental'
import { monthRange, useInvalidateRentals, useRentalPermissions, useRentalReport } from './hooks'
import type { RentalReport } from './types'
import { ContractDetailDialog } from './ContractDetailDialog'

type DueRow = RentalReport['overdue_rows'][number]

// Overdue / due-but-not-invoiced installments across all contracts, and
// the monthly "issue all due invoices" run.
export function DuesSection() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { canCreateContracts, canCollect } = useRentalPermissions()
  const invalidate = useInvalidateRentals()
  const { startDate, endDate } = monthRange()
  const { data, isLoading, isError, error, refetch } = useRentalReport(startDate, endDate)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [selectedContract, setSelectedContract] = useState<string | null>(null)

  const issueDueMutation = useMutation({
    mutationFn: async () => {
      const { data: count, error: rpcError } = await supabase.rpc('issue_due_rental_invoices', { p_club_id: currentClubId! })
      if (rpcError) throw rpcError
      return count ?? 0
    },
    onSuccess: (count) => {
      setMessage({ tone: 'ok', text: t('rentals.dues.issued', { count }) })
      invalidate()
    },
    onError: (err) => setMessage({ tone: 'error', text: translateSupabaseError(err, t('rentals.dues.issueError')) }),
  })

  const rows = data?.overdue_rows ?? []

  const actionColumn: DataTableColumn<DueRow> = {
    key: 'action',
    header: '',
    hideOnCard: true,
    render: (r) => r.invoice_id && canCollect ? (
      <Button asChild size="sm" variant="outline"><Link to={`/app/finance/payments?invoice=${r.invoice_id}`}>{t('rentals.detail.collect')}</Link></Button>
    ) : null,
  }

  const columns: DataTableColumn<DueRow>[] = [
    {
      key: 'tenant',
      header: t('rentals.contracts.tenant'),
      cardPriority: 'primary',
      render: (r) => (
        <button className="text-start font-medium text-accent-foreground hover:underline" onClick={() => setSelectedContract(r.contract_id)}>
          {r.customer_name}
          <span className="block text-xs text-text-secondary tabular-nums"><bdi>{r.contract_number}</bdi> · {r.space_name}</span>
        </button>
      ),
    },
    {
      key: 'installment',
      header: t('rentals.dues.installment'),
      render: (r) => (r.kind === 'deposit' ? t('rentals.detail.depositShort') : `#${r.sequence}`),
    },
    { key: 'due', header: t('rentals.detail.dueDate'), render: (r) => <span className="tabular-nums">{r.due_date}</span> },
    { key: 'outstanding', header: t('rentals.detail.totals.outstanding'), render: (r) => <MoneyDisplay amount={Number(r.outstanding)} size="sm" tone="danger" /> },
    {
      key: 'state',
      header: t('common.status', { defaultValue: 'Status' }),
      render: (r) => <StatusBadge tone={RENTAL_PAYMENT_STATE_TONE[r.payment_state] ?? 'neutral'} label={t(`rentals.paymentStates.${r.payment_state}`)} />,
    },
    actionColumn,
  ]

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">{t('rentals.dues.description')}</p>
        {canCreateContracts && (
          <Button size="sm" disabled={issueDueMutation.isPending} onClick={() => issueDueMutation.mutate()}>
            {t('rentals.dues.issueDue')}
          </Button>
        )}
      </div>
      {message && (
        <p role={message.tone === 'error' ? 'alert' : 'status'} className={message.tone === 'error' ? 'text-sm text-status-danger' : 'text-sm text-status-success'}>
          {message.text}
        </p>
      )}
      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('rentals.dues.loadError'))} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.installment_id}
          isLoading={isLoading}
          variant="cards-on-mobile"
          renderCardActions={(r, i, all) => actionColumn.render(r, i, all)}
          emptyTitle={t('rentals.dues.emptyTitle')}
          emptyDescription={t('rentals.dues.emptyDescription')}
        />
      )}
      {selectedContract && (
        <ContractDetailDialog contractId={selectedContract} onClose={() => setSelectedContract(null)} onChanged={invalidate} />
      )}
    </div>
  )
}
