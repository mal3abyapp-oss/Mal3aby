import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Gauge, Plus } from 'lucide-react'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useRentalPermissions } from './hooks'
import type { RentalMeter } from './types'
import { Field } from './Field'

// Utility meters per lease (electricity / water / gas / other). Each new
// reading bills (reading - previous) x unit price as a 'utility'
// installment on its own invoice, collected in Finance like any other.

const METER_TYPES = ['electricity', 'water', 'gas', 'other'] as const

export function ContractMeters({ contractId, contractOpen, onBilled }: { contractId: string; contractOpen: boolean; onBilled: () => void }) {
  const { t } = useTranslation()
  const { canCreateContracts, canManageContracts, canCollect } = useRentalPermissions()
  const [adding, setAdding] = useState(false)
  const [type, setType] = useState<(typeof METER_TYPES)[number]>('electricity')
  const [label, setLabel] = useState('')
  const [unitPrice, setUnitPrice] = useState('')
  const [initial, setInitial] = useState('0')
  const [readings, setReadings] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const keys = useRef<Record<string, string>>({})

  const { data: meters = [], refetch } = useQuery({
    queryKey: ['rental-meters', contractId],
    queryFn: async () => {
      const { data, error: rpcError } = await supabase.rpc('list_rental_meters', { p_contract_id: contractId })
      if (rpcError) throw rpcError
      return (data ?? []) as unknown as RentalMeter[]
    },
  })

  const addMeter = useMutation({
    mutationFn: async () => {
      const { error: rpcError } = await supabase.rpc('upsert_rental_meter', {
        p_contract_id: contractId,
        p_meter_id: null,
        p_meter_type: type,
        p_label: label.trim() || undefined,
        p_unit_price: Number(unitPrice),
        p_initial_reading: Number(initial || 0),
      })
      if (rpcError) throw rpcError
    },
    onSuccess: () => { setAdding(false); setLabel(''); setUnitPrice(''); setInitial('0'); setError(null); void refetch() },
    onError: (err) => setError(translateSupabaseError(err, t('rentals.meters.saveError'))),
  })

  const record = useMutation({
    mutationFn: async (meterId: string) => {
      keys.current[meterId] ??= crypto.randomUUID()
      const { error: rpcError } = await supabase.rpc('record_rental_meter_reading', {
        p_meter_id: meterId,
        p_reading: Number(readings[meterId]),
        p_idempotency_key: keys.current[meterId],
      })
      if (rpcError) throw rpcError
      return meterId
    },
    onSuccess: (meterId) => {
      delete keys.current[meterId]
      setReadings((r) => ({ ...r, [meterId]: '' }))
      setError(null)
      void refetch()
      onBilled()
    },
    onError: (err) => setError(translateSupabaseError(err, t('rentals.meters.readingError'))),
  })

  if (meters.length === 0 && !(canManageContracts && contractOpen)) return null

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="flex items-center gap-1 font-medium"><Gauge className="size-4" />{t('rentals.meters.title')}</p>
        {canManageContracts && contractOpen && !adding && (
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}><Plus />{t('rentals.meters.add')}</Button>
        )}
      </div>

      {adding && (
        <div className="mb-3 flex flex-col gap-2 rounded-md bg-muted/40 p-2">
          <div className="flex gap-2">
            <Field label={t('rentals.meters.type')} className="flex-1">
              <Select value={type} onValueChange={(v) => setType(v as (typeof METER_TYPES)[number])}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {METER_TYPES.map((m) => <SelectItem key={m} value={m}>{t(`rentals.meters.types.${m}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('rentals.meters.label')} className="flex-1">
              <Input value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
          </div>
          <div className="flex gap-2">
            <Field label={t('rentals.meters.unitPrice')} className="flex-1">
              <Input type="number" min={0} step="0.01" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} />
            </Field>
            <Field label={t('rentals.meters.initialReading')} className="flex-1">
              <Input type="number" min={0} value={initial} onChange={(e) => setInitial(e.target.value)} />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button size="sm" disabled={unitPrice === '' || addMeter.isPending} onClick={() => addMeter.mutate()}>{t('rentals.save')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
          </div>
        </div>
      )}

      {meters.length === 0 ? (
        !adding && <p className="text-sm text-text-secondary">{t('rentals.meters.empty')}</p>
      ) : (
        <ul className="flex flex-col gap-3 text-sm">
          {meters.map((m) => {
            const value = readings[m.id] ?? ''
            const consumption = value === '' ? null : Number(value) - Number(m.last_reading)
            return (
              <li key={m.id}>
                <p className="font-medium">
                  {t(`rentals.meters.types.${m.meter_type}`)}{m.label ? ` · ${m.label}` : ''}
                  <span className="ms-2 text-xs text-text-secondary tabular-nums">
                    {t('rentals.meters.lastReading', { value: Number(m.last_reading) })} · {t('rentals.meters.perUnit', { price: Number(m.unit_price) })}
                  </span>
                </p>
                {canCreateContracts && contractOpen && m.active && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Input
                      type="number"
                      className="w-36"
                      min={Number(m.last_reading)}
                      placeholder={t('rentals.meters.newReading')}
                      value={value}
                      onChange={(e) => setReadings((r) => ({ ...r, [m.id]: e.target.value }))}
                    />
                    {consumption != null && consumption >= 0 && (
                      <span className="text-xs text-text-secondary">
                        {t('rentals.meters.consumption', { value: consumption })} · <MoneyDisplay amount={Math.round(consumption * Number(m.unit_price) * 100) / 100} size="sm" />
                      </span>
                    )}
                    <Button size="sm" disabled={value === '' || (consumption ?? -1) < 0 || record.isPending} onClick={() => record.mutate(m.id)}>
                      {t('rentals.meters.bill')}
                    </Button>
                  </div>
                )}
                {m.readings.length > 0 && (
                  <ul className="mt-1 text-xs text-text-secondary">
                    {m.readings.slice(0, 5).map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center gap-2 tabular-nums">
                        <span>{r.reading_date}: {Number(r.previous_reading)} → {Number(r.current_reading)} ({Number(r.consumption)})</span>
                        <MoneyDisplay amount={Number(r.amount)} size="sm" />
                        {r.invoice_id && canCollect && (
                          <Link className="text-accent-foreground hover:underline" to={`/app/finance/payments?invoice=${r.invoice_id}`}>{t('rentals.detail.collect')}</Link>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-status-danger">{error}</p>}
    </div>
  )
}
