import { useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { useAuth } from '@/app/providers/AuthProvider'
import { Pencil, Printer, ReceiptText, RefreshCw, Undo2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  RENTAL_CONTRACT_STATUS_TONE, RENTAL_PAYMENT_STATE_TONE, rentalSpaceTypeLabel, rentCycleLabel,
} from '@/lib/domain/rental'
import { useRentalPermissions } from './hooks'
import type { RentalContractDetail, RentalInstallmentRow } from './types'
import { Field } from './Field'
import { ContractPrintView } from './ContractPrintView'
import { DepositReceiptPrintView } from './DepositReceiptPrintView'
import { ContractDocuments } from './ContractDocuments'
import { ContractMeters } from './ContractMeters'
import { EditContractDialog, RenewContractDialog, SettleDepositDialog } from './ContractActionDialogs'

// Contract 360: schedule with derived payment state per installment.
// Staff select not-yet-invoiced installments (e.g. "pay 3 months now")
// and issue ONE invoice for them, then collect it in Finance > Payments
// (shared record_payment path -> cash shift, official receipt, printing,
// notifications all behave exactly like any other invoice).
// v2: renew / edit / settle the security deposit / print the lease;
// late-fee rows, hourly booking times, annual increase and the renewal
// chain are shown in place.

function isInvoiceable(i: RentalInstallmentRow): boolean {
  return i.status === 'scheduled' || (i.status === 'invoiced' && i.invoice_status === 'void')
}

export function ContractDetailDialog({ contractId: initialContractId, onClose, onChanged }: { contractId: string; onClose: () => void; onChanged: () => void }) {
  const { t } = useTranslation()
  // Renewal links jump between the leases of one chain inside the same dialog.
  const [contractId, setContractId] = useState(initialContractId)
  const [action, setAction] = useState<'none' | 'renew' | 'edit' | 'deposit'>('none')
  // Only one printable document is mounted at a time (both use the
  // shared .visible-for-print class).
  const [printDoc, setPrintDoc] = useState<'contract' | 'deposit'>('contract')
  const { currentClubId } = useAuth()

  function printDocument(doc: 'contract' | 'deposit') {
    flushSync(() => setPrintDoc(doc))
    window.print()
  }
  const navigate = useNavigate()
  const { canCreateContracts, canManageContracts, canCollect } = useRentalPermissions()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'none' | 'terminate' | 'cancel'>('none')
  const [reason, setReason] = useState('')
  const [terminationDate, setTerminationDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [actionError, setActionError] = useState<string | null>(null)

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['rental-contract-detail', contractId],
    queryFn: async () => {
      const { data: d, error: rpcError } = await supabase.rpc('get_rental_contract_detail', { p_contract_id: contractId })
      if (rpcError) throw rpcError
      return d as unknown as RentalContractDetail
    },
  })

  function afterChange() {
    setSelected(new Set())
    setMode('none')
    setReason('')
    setActionError(null)
    void refetch()
    onChanged()
  }

  const issueMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const { data: invoiceId, error: rpcError } = await supabase.rpc('issue_rental_invoice', { p_contract_id: contractId, p_installment_ids: ids })
      if (rpcError) throw rpcError
      return invoiceId
    },
    onSuccess: (invoiceId) => {
      afterChange()
      if (invoiceId && canCollect) navigate(`/app/finance/payments?invoice=${invoiceId}`)
    },
    onError: (err) => setActionError(translateSupabaseError(err, t('rentals.detail.issueError'))),
  })

  const terminateMutation = useMutation({
    mutationFn: async () => {
      const { error: rpcError } = await supabase.rpc('terminate_rental_contract', {
        p_contract_id: contractId, p_termination_date: terminationDate, p_reason: reason.trim(),
      })
      if (rpcError) throw rpcError
    },
    onSuccess: afterChange,
    onError: (err) => setActionError(translateSupabaseError(err, t('rentals.detail.terminateError'))),
  })

  const cancelMutation = useMutation({
    mutationFn: async () => {
      const { error: rpcError } = await supabase.rpc('cancel_rental_contract', { p_contract_id: contractId, p_reason: reason.trim() })
      if (rpcError) throw rpcError
    },
    onSuccess: afterChange,
    onError: (err) => setActionError(translateSupabaseError(err, t('rentals.detail.cancelError'))),
  })

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function goTo(id: string) {
    setSelected(new Set())
    setMode('none')
    setActionError(null)
    setContractId(id)
  }

  const c = data?.contract
  const isHourly = c?.rent_cycle === 'hourly'
  const depositInstallment = data?.installments.find((i) => i.kind === 'deposit')
  const canSettleDeposit = !!c && !!depositInstallment?.invoice_id && depositInstallment.invoice_status === 'issued'
    && !c.deposit_settled_at && c.status !== 'cancelled'
  const canRenew = !!c && !!data && c.status === 'active' && !isHourly && !data.renewed_to
  const selectedTotal = (data?.installments ?? []).filter((i) => selected.has(i.id)).reduce((sum, i) => sum + Number(i.amount), 0)
  const isOpen = c?.status === 'active' || c?.status === 'terminated'

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {t('rentals.detail.title')} {c && <span className="tabular-nums"><bdi>{c.contract_number}</bdi></span>}
          </DialogTitle>
        </DialogHeader>

        {isLoading && <Skeleton className="h-40 w-full" />}
        {isError && <ErrorState message={translateSupabaseError(error, t('rentals.contracts.loadError'))} onRetry={() => void refetch()} />}

        {data && c && (printDoc === 'deposit' && c.deposit_settled_at
          ? <DepositReceiptPrintView detail={data} />
          : <ContractPrintView detail={data} />)}

        {data && c && (
          <div className="flex flex-col gap-4 print:hidden">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => printDocument('contract')}><Printer />{t('rentals.print.action')}</Button>
              {c.deposit_settled_at && (
                <Button size="sm" variant="outline" onClick={() => printDocument('deposit')}><ReceiptText />{t('rentals.depositReceipt.action')}</Button>
              )}
              {canCreateContracts && canRenew && (
                <Button size="sm" variant="outline" onClick={() => setAction('renew')}><RefreshCw />{t('rentals.renew.action')}</Button>
              )}
              {canManageContracts && c.status === 'active' && (
                <Button size="sm" variant="outline" onClick={() => setAction('edit')}><Pencil />{t('rentals.edit.action')}</Button>
              )}
              {canManageContracts && canSettleDeposit && (
                <Button size="sm" variant="outline" onClick={() => setAction('deposit')}><Undo2 />{t('rentals.deposit.settleAction')}</Button>
              )}
            </div>

            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <Info label={t('rentals.contracts.tenant')}>
                <Link className="text-accent-foreground hover:underline" to={`/app/customers/${data.customer.id}`}>{data.customer.full_name}</Link>
                {data.customer.mobile_display && <span className="ms-1 text-text-secondary"><bdi>{data.customer.mobile_display}</bdi></span>}
              </Info>
              <Info label={t('rentals.contracts.space')}>
                {data.space.name} · {rentalSpaceTypeLabel(t, data.space.space_type, data.space.custom_type_label)} · {data.space.branch_name}
              </Info>
              <Info label={t('rentals.contracts.cycle')}>
                {isHourly
                  ? <>{t('rentals.contracts.hoursValue', { count: c.cycles_count })} × <MoneyDisplay amount={Number(c.cycle_amount)} size="sm" /></>
                  : <>{rentCycleLabel(t, c.rent_cycle, c.custom_cycle_value, c.custom_cycle_unit)} × {c.cycles_count} — <MoneyDisplay amount={Number(c.cycle_amount)} size="sm" /></>}
                {Number(c.annual_increase_pct) > 0 && (
                  <span className="ms-1 text-xs text-text-secondary">({t('rentals.contracts.increaseBadge', { pct: Number(c.annual_increase_pct) })})</span>
                )}
              </Info>
              <Info label={t('rentals.contracts.period')}>
                {isHourly
                  ? <span className="tabular-nums"><bdi>{c.start_date} {c.start_time?.slice(0, 5)}–{c.end_time?.slice(0, 5)}</bdi></span>
                  : <span className="tabular-nums"><bdi>{c.start_date} → {c.end_date}</bdi></span>}
                {c.termination_date && <span className="ms-1 text-status-warning">({t('rentals.detail.terminatedOn', { date: c.termination_date })})</span>}
              </Info>
              <Info label={t('common.status', { defaultValue: 'Status' })}>
                <StatusBadge tone={RENTAL_CONTRACT_STATUS_TONE[data.display_status] ?? 'neutral'} label={t(`rentals.contracts.statusLabels.${data.display_status}`)} />
              </Info>
              {Number(c.security_deposit) > 0 && (
                <Info label={t('rentals.contracts.deposit')}>
                  <MoneyDisplay amount={Number(c.security_deposit)} size="sm" />
                  <span className="ms-1 text-xs text-text-secondary">
                    {c.deposit_settled_at
                      ? t('rentals.deposit.settledSummary', { refunded: Number(c.deposit_refunded), kept: Number(c.deposit_kept) })
                      : t('rentals.deposit.heldSummary', { held: Number(data.totals.deposit_held ?? 0) })}
                  </span>
                  {c.deposit_settlement_note && <span className="block text-xs text-text-secondary">{c.deposit_settlement_note}</span>}
                </Info>
              )}
              {(data.renewed_from || data.renewed_to) && (
                <Info label={t('rentals.renew.chain')}>
                  {data.renewed_from && (
                    <button type="button" className="me-2 text-accent-foreground hover:underline" onClick={() => goTo(data.renewed_from!.id)}>
                      {t('rentals.renew.from', { number: data.renewed_from.contract_number })}
                    </button>
                  )}
                  {data.renewed_to && (
                    <button type="button" className="text-accent-foreground hover:underline" onClick={() => goTo(data.renewed_to!.id)}>
                      {t('rentals.renew.to', { number: data.renewed_to.contract_number })}
                    </button>
                  )}
                </Info>
              )}
              {c.notes && <Info label={t('rentals.contracts.notes')}>{c.notes}</Info>}
              {(c.termination_reason || c.cancel_reason) && (
                <Info label={t('rentals.detail.reason')}>{c.termination_reason ?? c.cancel_reason}</Info>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Total label={t('rentals.detail.totals.paid')} amount={data.totals.paid} tone="success" />
              <Total label={t('rentals.detail.totals.outstanding')} amount={data.totals.outstanding} />
              <Total label={t('rentals.detail.totals.overdue')} amount={data.totals.overdue} tone="danger" />
              <Total label={t('rentals.detail.totals.notInvoiced')} amount={data.totals.not_invoiced} />
              {Number(data.totals.late_fees ?? 0) > 0 && (
                <Total label={t('rentals.detail.totals.lateFees')} amount={data.totals.late_fees} tone="danger" />
              )}
            </div>

            <div>
              <p className="mb-2 font-medium">{t('rentals.detail.schedule')}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-start text-xs text-text-secondary">
                      <th className="p-1" />
                      <th className="p-1 text-start">#</th>
                      <th className="p-1 text-start">{t('rentals.detail.periodCol')}</th>
                      <th className="p-1 text-start">{t('rentals.detail.dueDate')}</th>
                      <th className="p-1 text-start">{t('rentals.detail.amount')}</th>
                      <th className="p-1 text-start">{t('rentals.detail.paidCol')}</th>
                      <th className="p-1 text-start">{t('common.status', { defaultValue: 'Status' })}</th>
                      <th className="p-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {data.installments.map((i) => (
                      <tr key={i.id} className="border-b border-border-subtle last:border-0">
                        <td className="p-1">
                          {canCreateContracts && isOpen && isInvoiceable(i) && (
                            <input type="checkbox" aria-label={t('rentals.detail.select')} checked={selected.has(i.id)} onChange={() => toggle(i.id)} />
                          )}
                        </td>
                        <td className="p-1 tabular-nums">
                          {i.kind === 'deposit' ? t('rentals.detail.depositShort')
                            : i.kind === 'late_fee' ? t('rentals.detail.lateFeeShort')
                            : i.kind === 'utility' ? t('rentals.detail.utilityShort') : i.sequence}
                        </td>
                        <td className="p-1 text-xs tabular-nums"><bdi>{i.period_start} → {i.period_end}</bdi></td>
                        <td className="p-1 text-xs tabular-nums">{i.due_date}</td>
                        <td className="p-1"><MoneyDisplay amount={Number(i.amount)} size="sm" /></td>
                        <td className="p-1"><MoneyDisplay amount={Number(i.paid)} size="sm" /></td>
                        <td className="p-1">
                          <StatusBadge tone={RENTAL_PAYMENT_STATE_TONE[i.payment_state] ?? 'neutral'} label={t(`rentals.paymentStates.${i.payment_state}`)} />
                        </td>
                        <td className="p-1 text-end">
                          {i.invoice_id && i.invoice_status === 'issued' && (
                            <Button asChild size="sm" variant="ghost">
                              <Link to={`/app/finance/payments?invoice=${i.invoice_id}`}>
                                {Number(i.outstanding) > 0 && canCollect ? t('rentals.detail.collect') : t('rentals.detail.viewInvoice')}
                              </Link>
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <ContractMeters contractId={c.id} contractOpen={c.status === 'active'} onBilled={() => { void refetch(); onChanged() }} />
            {currentClubId && <ContractDocuments clubId={currentClubId} contractId={c.id} />}

            {actionError && <p role="alert" className="text-sm text-status-danger">{actionError}</p>}

            <div className="flex flex-wrap items-center gap-2">
              {canCreateContracts && isOpen && (
                <Button
                  size="sm"
                  disabled={selected.size === 0 || issueMutation.isPending}
                  onClick={() => issueMutation.mutate(Array.from(selected))}
                >
                  {t('rentals.detail.issueSelected', { count: selected.size })}
                  {selected.size > 0 && <MoneyDisplay amount={selectedTotal} size="sm" className="text-inherit" />}
                </Button>
              )}
              {canManageContracts && c.status === 'active' && (
                <Button size="sm" variant="outline" onClick={() => setMode(mode === 'terminate' ? 'none' : 'terminate')}>{t('rentals.detail.terminate')}</Button>
              )}
              {canManageContracts && c.status !== 'cancelled' && (
                <Button size="sm" variant="ghost" className="text-status-danger" onClick={() => setMode(mode === 'cancel' ? 'none' : 'cancel')}>{t('rentals.detail.cancel')}</Button>
              )}
            </div>

            {mode !== 'none' && (
              <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
                <p className="text-sm text-text-secondary">{mode === 'terminate' ? t('rentals.detail.terminateHint') : t('rentals.detail.cancelHint')}</p>
                {mode === 'terminate' && (
                  <Field label={t('rentals.detail.terminationDate')}>
                    <Input type="date" value={terminationDate} min={c.start_date} max={c.end_date} onChange={(e) => setTerminationDate(e.target.value)} />
                  </Field>
                )}
                <Field label={t('rentals.detail.reason')}>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} />
                </Field>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!reason.trim() || terminateMutation.isPending || cancelMutation.isPending}
                  onClick={() => (mode === 'terminate' ? terminateMutation.mutate() : cancelMutation.mutate())}
                >
                  {mode === 'terminate' ? t('rentals.detail.confirmTerminate') : t('rentals.detail.confirmCancel')}
                </Button>
              </div>
            )}
          </div>
        )}

        {data && action === 'renew' && (
          <RenewContractDialog detail={data} onClose={() => setAction('none')} onDone={(id) => { setAction('none'); onChanged(); goTo(id) }} />
        )}
        {data && action === 'edit' && (
          <EditContractDialog detail={data} onClose={() => setAction('none')} onDone={() => { setAction('none'); afterChange() }} />
        )}
        {data && action === 'deposit' && (
          <SettleDepositDialog detail={data} onClose={() => setAction('none')} onDone={() => { setAction('none'); afterChange() }} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function Info({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="text-xs text-text-secondary">{label}</span>
      <span>{children}</span>
    </div>
  )
}

function Total({ label, amount, tone }: { label: string; amount: number; tone?: 'success' | 'danger' }) {
  return (
    <div className="rounded-lg border border-border p-2">
      <p className="text-xs text-text-secondary">{label}</p>
      <MoneyDisplay amount={Number(amount)} tone={Number(amount) > 0 ? tone : undefined} />
    </div>
  )
}
