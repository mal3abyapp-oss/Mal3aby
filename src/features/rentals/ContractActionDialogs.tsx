import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { previewRentalSchedule, rentCycleLabel, type CustomCycleUnit, type RentCycle } from '@/lib/domain/rental'
import type { RentalContractDetail } from './types'
import { Field } from './Field'

// Lease lifecycle actions opened from the contract detail:
//  - Renew: one click creates the follow-on lease starting the day after
//    this one ends (same space/tenant/cycle), at the last rent plus the
//    annual increase unless staff type a new amount. No new deposit --
//    the existing one stays held across the renewal.
//  - Edit: change the notes, reprice the not-yet-invoiced periods from a
//    date, and/or extend the lease by N more periods.
//  - Settle deposit: at the end of the lease refund all or part of the
//    collected security deposit (deductions for damage/arrears are kept
//    as club income); the refund goes through the shared refunds ledger.

type Contract = RentalContractDetail['contract']

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function lastRentAmount(detail: RentalContractDetail): number {
  const rents = detail.installments.filter((i) => i.kind === 'rent' && i.status !== 'cancelled')
  return Number(rents[rents.length - 1]?.amount ?? detail.contract.cycle_amount)
}

export function RenewContractDialog({
  detail, onClose, onDone,
}: { detail: RentalContractDetail; onClose: () => void; onDone: (newContractId: string) => void }) {
  const { t } = useTranslation()
  const c = detail.contract
  const idempotencyKey = useRef(crypto.randomUUID())
  const pct = Number(c.annual_increase_pct ?? 0)
  const suggested = Math.round(lastRentAmount(detail) * (1 + pct / 100) * 100) / 100
  const [cycles, setCycles] = useState(String(c.cycles_count))
  const [amount, setAmount] = useState(String(suggested))
  const [increase, setIncrease] = useState(String(pct))
  const [issueFirst, setIssueFirst] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const startDate = addDays(c.end_date, 1)
  const preview = previewRentalSchedule(
    startDate,
    { cycle: c.rent_cycle as RentCycle, customValue: c.custom_cycle_value, customUnit: c.custom_cycle_unit as CustomCycleUnit | null },
    Number(cycles),
    Number(amount || 0),
    Number(increase || 0),
  )

  const mutation = useMutation({
    mutationFn: async () => {
      const { data, error: rpcError } = await supabase.rpc('renew_rental_contract', {
        p_contract_id: c.id,
        p_cycles_count: Number(cycles),
        p_cycle_amount: Number(amount),
        p_annual_increase_pct: Number(increase || 0),
        p_issue_first_invoice: issueFirst,
        p_idempotency_key: idempotencyKey.current,
      })
      if (rpcError) throw rpcError
      return data?.[0]
    },
    onSuccess: (row) => { if (row?.contract_id) onDone(row.contract_id) },
    onError: (err) => setError(translateSupabaseError(err, t('rentals.renew.error'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('rentals.renew.title')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">
            {t('rentals.renew.hint', { date: startDate, cycle: rentCycleLabel(t, c.rent_cycle, c.custom_cycle_value, c.custom_cycle_unit) })}
          </p>
          <div className="flex gap-2">
            <Field label={t('rentals.contracts.cyclesCount')} className="flex-1">
              <Input type="number" min={1} max={1000} value={cycles} onChange={(e) => setCycles(e.target.value)} />
            </Field>
            <Field label={t('rentals.contracts.cycleAmount')} className="flex-1">
              <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>
          <Field label={t('rentals.contracts.annualIncrease')}>
            <Input type="number" min={0} max={100} step="0.5" value={increase} onChange={(e) => setIncrease(e.target.value)} />
          </Field>
          {preview.endDate && (
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
              <div className="flex justify-between"><span className="text-text-secondary">{t('rentals.contracts.period')}</span><bdi className="tabular-nums">{startDate} → {preview.endDate}</bdi></div>
              <div className="flex justify-between"><span className="text-text-secondary">{t('rentals.contracts.totalRent')}</span><MoneyDisplay amount={preview.totalRent} size="sm" /></div>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={issueFirst} onChange={(e) => setIssueFirst(e.target.checked)} />
            {t('rentals.renew.issueFirst')}
          </label>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <Button disabled={!preview.endDate || amount === '' || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? t('rentals.saving') : t('rentals.renew.confirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function EditContractDialog({
  detail, onClose, onDone,
}: { detail: RentalContractDetail; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const c: Contract = detail.contract
  const isHourly = c.rent_cycle === 'hourly'
  const [notes, setNotes] = useState(c.notes ?? '')
  const [reprice, setReprice] = useState(false)
  const [newAmount, setNewAmount] = useState(String(c.cycle_amount))
  const [effectiveFrom, setEffectiveFrom] = useState(detail.today)
  const [extend, setExtend] = useState('0')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: rpcError } = await supabase.rpc('update_rental_contract', {
        p_contract_id: c.id,
        p_notes: notes,
        p_new_cycle_amount: reprice ? Number(newAmount) : undefined,
        p_effective_from: reprice ? effectiveFrom : undefined,
        p_extend_cycles: isHourly ? 0 : Number(extend || 0),
      })
      if (rpcError) throw rpcError
    },
    onSuccess: onDone,
    onError: (err) => setError(translateSupabaseError(err, t('rentals.edit.error'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('rentals.edit.title')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <Field label={t('rentals.contracts.notes')}>
            <textarea
              className="min-h-14 rounded-md border border-border-subtle bg-transparent p-2 text-sm"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={reprice} onChange={(e) => setReprice(e.target.checked)} />
            {t('rentals.edit.reprice')}
          </label>
          {reprice && (
            <div className="flex gap-2">
              <Field label={t('rentals.edit.newAmount')} className="flex-1">
                <Input type="number" min={0} value={newAmount} onChange={(e) => setNewAmount(e.target.value)} />
              </Field>
              <Field label={t('rentals.edit.effectiveFrom')} className="flex-1">
                <Input type="date" value={effectiveFrom} min={c.start_date} max={c.end_date} onChange={(e) => setEffectiveFrom(e.target.value)} />
              </Field>
            </div>
          )}
          {reprice && <p className="-mt-1 text-xs text-text-secondary">{t('rentals.edit.repriceHint')}</p>}
          {!isHourly && (
            <Field label={t('rentals.edit.extend')}>
              <Input type="number" min={0} max={1000} value={extend} onChange={(e) => setExtend(e.target.value)} />
            </Field>
          )}
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <Button disabled={mutation.isPending || (reprice && newAmount === '')} onClick={() => mutation.mutate()}>
            {mutation.isPending ? t('rentals.saving') : t('rentals.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function SettleDepositDialog({
  detail, onClose, onDone,
}: { detail: RentalContractDetail; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation()
  const held = Number(detail.totals.deposit_held ?? 0)
  const [refund, setRefund] = useState(String(held))
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const refundValue = Number(refund || 0)
  const kept = Math.max(held - refundValue, 0)

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: rpcError } = await supabase.rpc('settle_rental_deposit', {
        p_contract_id: detail.contract.id,
        p_refund_amount: refundValue,
        p_note: note.trim() || undefined,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: onDone,
    onError: (err) => setError(translateSupabaseError(err, t('rentals.deposit.settleError'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('rentals.deposit.settleTitle')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">{t('rentals.deposit.settleHint')}</p>
          <div className="flex justify-between text-sm">
            <span>{t('rentals.deposit.held')}</span>
            <MoneyDisplay amount={held} size="sm" />
          </div>
          <Field label={t('rentals.deposit.refundAmount')}>
            <Input type="number" min={0} max={held} value={refund} onChange={(e) => setRefund(e.target.value)} />
          </Field>
          <div className="flex justify-between text-sm">
            <span>{t('rentals.deposit.keptAmount')}</span>
            <MoneyDisplay amount={kept} size="sm" tone={kept > 0 ? 'success' : undefined} />
          </div>
          <Field label={t('rentals.deposit.note')}>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={t('rentals.deposit.notePlaceholder')} />
          </Field>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <Button
            disabled={mutation.isPending || refund === '' || refundValue < 0 || refundValue > held || (kept > 0 && !note.trim())}
            onClick={() => mutation.mutate()}
          >
            {mutation.isPending ? t('rentals.saving') : t('rentals.deposit.confirm')}
          </Button>
          {kept > 0 && !note.trim() && <p className="text-xs text-text-secondary">{t('rentals.deposit.noteRequired')}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}
