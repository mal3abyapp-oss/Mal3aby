import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyDisplay } from '@/components/ui/money-display'
import { StatusBadge } from '@/components/ui/status-badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useInvalidateRentals } from './hooks'
import type { RentalSpaceExpense, RentalSpaceRow } from './types'
import { Field } from './Field'

// Space profitability: expenses (maintenance, utilities, cleaning...)
// recorded against one rented space. They go through the normal
// record_expense path (expense.create permission, cash custody, cash
// shift, idempotency), so they show in Finance > Expenses and the cash
// drawer like any other expense; the link to the space is what lets the
// rentals report net them against that space's rent.

const PAYMENT_METHODS = ['cash', 'card', 'bank_transfer', 'wallet', 'other'] as const

export function SpaceExpensesDialog({ space, onClose }: { space: RentalSpaceRow; onClose: () => void }) {
  const { t } = useTranslation()
  const { currentMembership } = useAuth()
  const canRecord = (currentMembership?.permissionKeys ?? []).includes('expense.create')
  const invalidateRentals = useInvalidateRentals()
  const idempotencyKey = useRef(crypto.randomUUID())
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<(typeof PAYMENT_METHODS)[number]>('cash')
  const [description, setDescription] = useState('')
  const [paidTo, setPaidTo] = useState('')
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [error, setError] = useState<string | null>(null)

  const { data: expenses = [], isLoading, refetch } = useQuery({
    queryKey: ['rental-space-expenses', space.id],
    queryFn: async () => {
      const { data, error: rpcError } = await supabase.rpc('list_rental_space_expenses', { p_space_id: space.id })
      if (rpcError) throw rpcError
      return (data ?? []) as unknown as RentalSpaceExpense[]
    },
  })

  const recordMutation = useMutation({
    mutationFn: async () => {
      const value = Number(amount)
      if (!Number.isFinite(value) || value <= 0) throw new Error(t('finance.expenses.errors.invalidAmount'))
      if (!description.trim()) throw new Error(t('finance.expenses.errors.descriptionRequired'))
      const { error: rpcError } = await supabase.rpc('record_rental_space_expense', {
        p_space_id: space.id,
        p_amount: value,
        p_payment_method: method,
        p_description: description.trim(),
        p_expense_date: date,
        p_paid_to: paidTo.trim() || undefined,
        p_idempotency_key: idempotencyKey.current,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: () => {
      setAmount(''); setDescription(''); setPaidTo(''); setError(null)
      idempotencyKey.current = crypto.randomUUID()
      void refetch()
      invalidateRentals()
    },
    onError: (err) => setError(err instanceof Error && !('code' in err) ? err.message : translateSupabaseError(err, t('finance.expenses.errors.genericError'))),
  })

  const total = expenses.filter((e) => e.status !== 'voided').reduce((sum, e) => sum + Number(e.amount), 0)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('rentals.expenses.title', { name: space.name })}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">{t('rentals.expenses.hint')}</p>

          {canRecord ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <div className="flex gap-2">
                <Field label={t('finance.expenses.form.amount')} className="flex-1">
                  <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
                </Field>
                <Field label={t('finance.expenses.form.date')} className="flex-1">
                  <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </Field>
              </div>
              <div className="flex gap-2">
                <Field label={t('finance.expenses.form.method')} className="flex-1">
                  <Select value={method} onValueChange={(v) => setMethod(v as (typeof PAYMENT_METHODS)[number])}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {PAYMENT_METHODS.map((m) => (
                        <SelectItem key={m} value={m}>{t(`billing.paymentMethods.underlyingMethodLabels.${m}`)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('finance.expenses.form.paidTo')} className="flex-1">
                  <Input value={paidTo} onChange={(e) => setPaidTo(e.target.value)} />
                </Field>
              </div>
              <Field label={t('finance.expenses.form.description')}>
                <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('rentals.expenses.descriptionPlaceholder')} />
              </Field>
              {method === 'cash' && <p className="text-xs text-text-secondary">{t('finance.expenses.form.cashHint')}</p>}
              {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
              <Button size="sm" disabled={recordMutation.isPending} onClick={() => recordMutation.mutate()}>
                {recordMutation.isPending ? t('rentals.saving') : t('rentals.expenses.record')}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-text-secondary">{t('rentals.expenses.noPermission')}</p>
          )}

          <div className="flex items-center justify-between">
            <p className="font-medium">{t('rentals.expenses.list')}</p>
            <MoneyDisplay amount={total} size="sm" tone="danger" />
          </div>
          {isLoading ? (
            <p className="text-sm text-text-secondary">…</p>
          ) : expenses.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('rentals.expenses.empty')}</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle text-sm">
              {expenses.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 py-1.5">
                  <span className="flex flex-col">
                    <span className={e.status === 'voided' ? 'line-through text-text-secondary' : ''}>{e.description}</span>
                    <span className="text-xs text-text-secondary tabular-nums">
                      {e.expense_date} · {t(`billing.paymentMethods.underlyingMethodLabels.${e.payment_method}`)}{e.paid_to ? ` · ${e.paid_to}` : ''}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    {e.status === 'voided' && <StatusBadge tone="neutral" label={t('finance.expenses.statusVoided')} />}
                    <MoneyDisplay amount={Number(e.amount)} size="sm" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
