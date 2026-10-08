import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyDisplay } from '@/components/ui/money-display'
import { CustomerSelector, type SelectedCustomer } from '@/components/ui/customer-selector'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  CUSTOM_CYCLE_UNITS, RENT_CYCLES, addHoursToTime, canProrate, previewRentalSchedule, rentalSpaceTypeLabel,
  type CustomCycleUnit, type RentCycle,
} from '@/lib/domain/rental'
import { useRentalPermissions, useRentalSpaces } from './hooks'
import { Field } from './Field'

// New lease contract: tenant (shared CustomerSelector / upsert_customer
// identity path) -> space -> rent cycle (daily / monthly / quarterly /
// semi-annual / annual / custom every N days|weeks|months) -> number of
// periods -> amount per period -> optional security deposit. The full
// installment schedule is previewed live with the same date math the
// server uses. Hourly bookings (halls) take a start time and a number of
// hours on one day; long leases can carry an annual rent increase that
// compounds every contract year. On success the first rent invoice opens
// in Finance > Payments for collection; the security deposit is issued
// on its own invoice (it is a liability, refundable on settlement), so
// when there is one the contract opens instead and both are collectable
// from there.

export function NewContractDialog({
  onClose, onCreated, initialSpaceId, initialCustomer,
}: {
  onClose: () => void
  onCreated: (contractId?: string) => void
  initialSpaceId?: string
  initialCustomer?: SelectedCustomer
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { currentClubId } = useAuth()
  const { canCollect } = useRentalPermissions()
  const { data: spaces = [] } = useRentalSpaces(false)
  const activeSpaces = spaces.filter((s) => s.status === 'active')
  const idempotencyKey = useRef(crypto.randomUUID())

  const [customer, setCustomer] = useState<SelectedCustomer | null>(initialCustomer ?? null)
  const [spaceId, setSpaceId] = useState(initialSpaceId ?? '')
  const space = spaces.find((s) => s.id === spaceId) ?? null
  const [cycle, setCycle] = useState<RentCycle>((space?.default_rent_cycle as RentCycle | null) ?? 'monthly')
  const [customValue, setCustomValue] = useState('2')
  const [customUnit, setCustomUnit] = useState<CustomCycleUnit>('week')
  const [cyclesCount, setCyclesCount] = useState('12')
  const [amount, setAmount] = useState(space?.default_rent_amount != null ? String(space.default_rent_amount) : '')
  const [deposit, setDeposit] = useState('0')
  const [increasePct, setIncreasePct] = useState('0')
  const [startTime, setStartTime] = useState('18:00')
  const [prorate, setProrate] = useState(false)
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [notes, setNotes] = useState('')
  const [issueFirst, setIssueFirst] = useState(true)
  const [showSchedule, setShowSchedule] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function selectSpace(id: string) {
    setSpaceId(id)
    const s = spaces.find((x) => x.id === id)
    if (s?.default_rent_cycle) setCycle(s.default_rent_cycle as RentCycle)
    if (s?.default_rent_amount != null) setAmount(String(s.default_rent_amount))
  }

  const isHourly = cycle === 'hourly'
  const prorateAvailable = canProrate(startDate, cycle)
  const prorateFirst = prorateAvailable && prorate
  const endTime = isHourly ? addHoursToTime(startTime, Number(cyclesCount)) : null
  const preview = useMemo(
    () => previewRentalSchedule(
      startDate,
      { cycle, customValue: Number(customValue), customUnit },
      Number(cyclesCount),
      Number(amount || 0),
      cycle === 'hourly' ? 0 : Number(increasePct || 0),
      prorateFirst,
    ),
    [startDate, cycle, customValue, customUnit, cyclesCount, amount, increasePct, prorateFirst],
  )

  function selectCycle(next: RentCycle) {
    setCycle(next)
    if (next === 'hourly' && Number(cyclesCount) > 24) setCyclesCount('4')
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!customer?.id) throw new Error(t('rentals.contracts.errors.customerRequired'))
      if (!spaceId) throw new Error(t('rentals.contracts.errors.spaceRequired'))
      if (!preview.endDate || (isHourly && !endTime)) throw new Error(t('rentals.contracts.errors.invalidSchedule'))
      const { data, error: rpcError } = await supabase.rpc('create_rental_contract', {
        p_club_id: currentClubId!,
        p_space_id: spaceId,
        p_customer_id: customer.id,
        p_start_date: startDate,
        p_rent_cycle: cycle,
        p_cycles_count: Number(cyclesCount),
        p_cycle_amount: Number(amount || 0),
        p_custom_cycle_value: cycle === 'custom' ? Number(customValue) : undefined,
        p_custom_cycle_unit: cycle === 'custom' ? customUnit : undefined,
        p_security_deposit: Number(deposit || 0),
        p_notes: notes.trim() || undefined,
        p_issue_first_invoice: issueFirst,
        p_idempotency_key: idempotencyKey.current,
        p_annual_increase_pct: isHourly ? 0 : Number(increasePct || 0),
        p_start_time: isHourly ? startTime : undefined,
        p_prorate_first: prorateFirst,
      })
      if (rpcError) throw rpcError
      return data?.[0]
    },
    onSuccess: (row) => {
      if (row?.deposit_invoice_id) {
        // Rent and deposit are two invoices -- open the contract so both
        // can be collected from its schedule.
        onCreated(row.contract_id)
        return
      }
      onCreated()
      if (row?.invoice_id && canCollect) {
        navigate(`/app/finance/payments?invoice=${row.invoice_id}`)
      }
    },
    onError: (err) => setError(translateSupabaseError(err, t('rentals.contracts.errors.createError'))),
  })

  const canSubmit = !!customer?.id && !!spaceId && !!preview.endDate && Number(amount) >= 0 && amount !== ''
    && (!isHourly || !!endTime)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('rentals.contracts.new')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          {!initialCustomer && (
            <Field label={t('rentals.contracts.tenant')}>
              <CustomerSelector clubId={currentClubId as string} value={customer} onSelect={setCustomer} />
            </Field>
          )}

          <Field label={t('rentals.contracts.space')}>
            <Select value={spaceId} onValueChange={selectSpace}>
              <SelectTrigger><SelectValue placeholder={t('rentals.contracts.space')} /></SelectTrigger>
              <SelectContent>
                {activeSpaces.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name} — {rentalSpaceTypeLabel(t, s.space_type, s.custom_type_label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="flex gap-2">
            <Field label={t('rentals.contracts.cycle')} className="flex-1">
              <Select value={cycle} onValueChange={(v) => selectCycle(v as RentCycle)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RENT_CYCLES.map((c) => <SelectItem key={c} value={c}>{t(`rentals.cycles.${c}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('rentals.contracts.startDate')} className="flex-1">
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </Field>
          </div>

          {cycle === 'custom' && (
            <div className="flex gap-2">
              <Field label={t('rentals.contracts.customEvery')} className="flex-1">
                <Input type="number" min={1} value={customValue} onChange={(e) => setCustomValue(e.target.value)} />
              </Field>
              <Field label={t('rentals.contracts.customUnit')} className="flex-1">
                <Select value={customUnit} onValueChange={(v) => setCustomUnit(v as CustomCycleUnit)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CUSTOM_CYCLE_UNITS.map((u) => <SelectItem key={u} value={u}>{t(`rentals.customUnits.${u}`)}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}

          {isHourly && (
            <div className="flex gap-2">
              <Field label={t('rentals.contracts.startTime')} className="flex-1">
                <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </Field>
              <Field label={t('rentals.contracts.endTime')} className="flex-1">
                <Input disabled value={endTime ?? t('rentals.contracts.errors.pastMidnight')} />
              </Field>
            </div>
          )}

          <div className="flex gap-2">
            <Field label={isHourly ? t('rentals.contracts.hoursCount') : t('rentals.contracts.cyclesCount')} className="flex-1">
              <Input type="number" min={1} max={isHourly ? 24 : 1000} value={cyclesCount} onChange={(e) => setCyclesCount(e.target.value)} />
            </Field>
            <Field label={isHourly ? t('rentals.contracts.hourlyRate') : t('rentals.contracts.cycleAmount')} className="flex-1">
              <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
          </div>

          <div className="flex gap-2">
            <Field label={t('rentals.contracts.deposit')} className="flex-1">
              <Input type="number" min={0} value={deposit} onChange={(e) => setDeposit(e.target.value)} />
            </Field>
            <Field label={t('rentals.contracts.endDate')} className="flex-1">
              <Input disabled value={preview.endDate ?? '—'} />
            </Field>
          </div>

          {prorateAvailable && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-1" checked={prorate} onChange={(e) => setProrate(e.target.checked)} />
              <span>
                {t('rentals.contracts.prorate')}
                <span className="block text-xs text-text-secondary">{t('rentals.contracts.prorateHint')}</span>
              </span>
            </label>
          )}

          {!isHourly && (
            <Field label={t('rentals.contracts.annualIncrease')}>
              <Input type="number" min={0} max={100} step="0.5" value={increasePct} onChange={(e) => setIncreasePct(e.target.value)} />
              {Number(increasePct) > 0 && <span className="text-xs text-text-secondary">{t('rentals.contracts.annualIncreaseHint')}</span>}
            </Field>
          )}

          <Field label={t('rentals.contracts.notes')}>
            <textarea
              className="min-h-14 rounded-md border border-border-subtle bg-transparent p-2 text-sm"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={2000}
            />
          </Field>

          {preview.endDate && (
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary">{t('rentals.contracts.totalRent')}</span>
                <MoneyDisplay amount={preview.totalRent} size="sm" />
              </div>
              {Number(deposit) > 0 && (
                <div className="flex justify-between">
                  <span className="text-text-secondary">{t('rentals.contracts.deposit')}</span>
                  <MoneyDisplay amount={Number(deposit)} size="sm" />
                </div>
              )}
              <div className="mt-1 flex justify-between border-t border-accent/20 pt-1 font-semibold">
                <span>{t('rentals.contracts.firstInvoice')}</span>
                <MoneyDisplay amount={preview.rows[0]?.amount ?? 0} size="sm" />
              </div>
              {Number(deposit) > 0 && (
                <p className="mt-1 text-xs text-text-secondary">{t('rentals.contracts.depositSeparate')}</p>
              )}
              <button type="button" className="mt-2 text-xs text-accent-foreground underline" onClick={() => setShowSchedule((v) => !v)}>
                {showSchedule ? t('rentals.contracts.hideSchedule') : t('rentals.contracts.showSchedule', { count: preview.rows.length })}
              </button>
              {showSchedule && (
                <ul className="mt-2 max-h-48 overflow-y-auto text-xs">
                  {preview.rows.map((r) => (
                    <li key={r.sequence} className="flex justify-between border-b border-border-subtle py-1 last:border-0">
                      <span className="tabular-nums">
                        #{r.sequence} <bdi>{r.periodStart} → {r.periodEnd}</bdi>
                        {r.partialDays != null && <span className="ms-1 text-text-secondary">({t('rentals.contracts.partialDays', { count: r.partialDays })})</span>}
                      </span>
                      <MoneyDisplay amount={r.amount} size="sm" />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={issueFirst} onChange={(e) => setIssueFirst(e.target.checked)} />
            {t('rentals.contracts.issueFirstInvoice')}
          </label>

          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}

          <Button disabled={!canSubmit || createMutation.isPending} onClick={() => createMutation.mutate()}>
            {createMutation.isPending ? t('rentals.saving') : t('rentals.contracts.create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
