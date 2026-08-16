import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translateSupabaseError } from '@/lib/errors'
import { DAY_NAMES_AR, type PricingRuleRow } from '@/lib/domain/fields'
import { useResolvedFieldPrice } from '@/features/bookings/useFieldPricing'

// P1-6 (critical usability fix pass, 2026-08-16): the old pricing UX
// exposed raw day_of_week integers, a numeric "priority" as the primary
// mental model, and no readable summary of what actually applies when.
// This groups rules into a human summary ("السبت–الخميس 08:00–16:00 200
// ج.م") and keeps priority as an advanced/secondary field, with the
// live "current effective price" always visible per the locked pricing
// rule (Section 1/10).

const WEEKDAY_ORDER = [0, 1, 2, 3, 4, 5, 6] // Sunday..Saturday, matches day_of_week

function groupWeeklyRules(rules: PricingRuleRow[]) {
  // Group consecutive days that share identical time-window + price into
  // one readable range, e.g. "السبت-الخميس" instead of 6 separate lines.
  const weekly = rules.filter((r) => r.dayOfWeek !== null).sort((a, b) => (a.dayOfWeek ?? 0) - (b.dayOfWeek ?? 0))
  const byKey = new Map<string, PricingRuleRow[]>()
  for (const r of weekly) {
    const key = `${r.startTime}-${r.endTime}-${r.pricePerHour}`
    const arr = byKey.get(key) ?? []
    arr.push(r)
    byKey.set(key, arr)
  }
  return Array.from(byKey.entries()).flatMap(([, rows]) => {
    const first = rows[0]
    if (!first) return []
    const days = rows.map((r) => r.dayOfWeek as number).sort((a, b) => WEEKDAY_ORDER.indexOf(a) - WEEKDAY_ORDER.indexOf(b))
    return [{ days, startTime: first.startTime, endTime: first.endTime, price: first.pricePerHour, ruleIds: rows.map((r) => r.id) }]
  })
}

function formatDayRange(days: number[]): string {
  if (days.length === 7) return 'كل أيام الأسبوع'
  if (days.length === 1) return DAY_NAMES_AR[days[0] as number] ?? '—'
  // Contiguous range check against the display week order (Sat..Fri).
  const order = [6, 0, 1, 2, 3, 4, 5]
  const indices = days.map((d) => order.indexOf(d)).sort((a, b) => a - b)
  const isContiguous = indices.every((idx, i) => i === 0 || idx === (indices[i - 1] as number) + 1)
  if (isContiguous) {
    const firstIdx = indices[0] as number
    const lastIdx = indices[indices.length - 1] as number
    const firstDay = order[firstIdx] as number
    const lastDay = order[lastIdx] as number
    return `${DAY_NAMES_AR[firstDay]}–${DAY_NAMES_AR[lastDay]}`
  }
  return days.map((d) => DAY_NAMES_AR[d] ?? '—').join('، ')
}

export function PricingEditor({
  fieldId,
  clubId,
  pricingRules,
}: {
  fieldId: string
  clubId: string
  pricingRules: PricingRuleRow[]
}) {
  const queryClient = useQueryClient()
  const [showAdvanced, setShowAdvanced] = useState(false)

  const [newDays, setNewDays] = useState<number[]>([0, 1, 2, 3, 4])
  const [newStart, setNewStart] = useState('08:00')
  const [newEnd, setNewEnd] = useState('23:00')
  const [newPrice, setNewPrice] = useState('')
  const [newPriority, setNewPriority] = useState('1')

  const [specialDate, setSpecialDate] = useState('')
  const [specialPrice, setSpecialPrice] = useState('')

  const [formError, setFormError] = useState<string | null>(null)

  const today = new Date().toISOString().slice(0, 10)
  const nowTime = new Date().toTimeString().slice(0, 5)
  const { data: currentPrice, isLoading: currentPriceLoading } = useResolvedFieldPrice(fieldId, today, `${nowTime}:00`, `${nowTime}:00`)

  const weeklyGroups = groupWeeklyRules(pricingRules)
  const specialRules = pricingRules.filter((r) => r.dateSpecific !== null).sort((a, b) => (a.dateSpecific ?? '').localeCompare(b.dateSpecific ?? ''))

  const addWeeklyMutation = useMutation({
    mutationFn: async () => {
      if (newDays.length === 0) throw new Error('no days selected')
      const rows = newDays.map((day) => ({
        club_id: clubId,
        field_id: fieldId,
        day_of_week: day,
        start_time: newStart,
        end_time: newEnd,
        price_per_hour: Number(newPrice),
        priority: Number(newPriority) || 1,
      }))
      const { error } = await supabase.from('pricing_rules').insert(rows)
      if (error) throw error
    },
    onSuccess: () => {
      setNewPrice('')
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['pricing-rules', fieldId] })
      void queryClient.invalidateQueries({ queryKey: ['resolve-field-price'] })
    },
    onError: (error) => setFormError(translateSupabaseError(error, 'تعذّرت إضافة السعر.')),
  })

  const addSpecialMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('pricing_rules').insert({
        club_id: clubId,
        field_id: fieldId,
        date_specific: specialDate,
        start_time: '00:00',
        end_time: '23:59',
        price_per_hour: Number(specialPrice),
        priority: 10,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setSpecialDate('')
      setSpecialPrice('')
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['pricing-rules', fieldId] })
    },
    onError: (error) => setFormError(translateSupabaseError(error, 'تعذّرت إضافة السعر الخاص.')),
  })

  const deleteMutation = useMutation({
    mutationFn: async (ruleIds: string[]) => {
      const { error } = await supabase.from('pricing_rules').delete().in('id', ruleIds)
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pricing-rules', fieldId] })
      void queryClient.invalidateQueries({ queryKey: ['resolve-field-price'] })
    },
  })

  function toggleDay(day: number) {
    setNewDays((prev) => (prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]))
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Current effective price -- always visible, server-resolved */}
      <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
        <span className="text-text-secondary">السعر الحالي الآن: </span>
        {currentPriceLoading ? (
          <span>جارٍ الحساب...</span>
        ) : currentPrice != null ? (
          <span className="font-semibold tabular-nums">{currentPrice.toFixed(0)} ج.م/ساعة</span>
        ) : (
          <span className="text-status-danger">لا يوجد سعر معتمد للوقت الحالي</span>
        )}
      </div>

      {pricingRules.length === 0 && (
        <p className="rounded-md bg-status-warning/10 p-2 text-sm text-status-warning">
          لا توجد أسعار محددة — لن يمكن إتمام أي حجز على هذا الملعب حتى تتم إضافة سعر واحد على الأقل.
        </p>
      )}

      {/* Human-readable weekly summary */}
      {weeklyGroups.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-sm">
          <p className="font-medium text-text-secondary">الأسعار الأسبوعية</p>
          {weeklyGroups.map((g, i) => (
            <div key={i} className="flex items-center justify-between">
              <span>{formatDayRange(g.days)} — {g.startTime.slice(0, 5)}–{g.endTime.slice(0, 5)}</span>
              <div className="flex items-center gap-2">
                <span className="font-medium tabular-nums">{g.price} ج.م</span>
                <button className="text-xs text-status-danger hover:underline" onClick={() => deleteMutation.mutate(g.ruleIds)} disabled={deleteMutation.isPending}>
                  حذف
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {specialRules.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-sm">
          <p className="font-medium text-text-secondary">أسعار خاصة (تواريخ محددة)</p>
          {specialRules.map((r) => (
            <div key={r.id} className="flex items-center justify-between">
              <span>{r.dateSpecific}</span>
              <div className="flex items-center gap-2">
                <span className="font-medium tabular-nums">{r.pricePerHour} ج.م</span>
                <button className="text-xs text-status-danger hover:underline" onClick={() => deleteMutation.mutate([r.id])} disabled={deleteMutation.isPending}>
                  حذف
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add weekly price */}
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <label className="text-sm font-medium text-text-secondary">إضافة سعر أسبوعي</label>
        <div className="flex flex-wrap gap-1.5">
          {DAY_NAMES_AR.map((name, i) => (
            <button
              key={i}
              type="button"
              onClick={() => toggleDay(i)}
              className={`rounded-full border px-2.5 py-1 text-xs font-medium ${newDays.includes(i) ? 'border-accent bg-accent/10 text-accent-foreground' : 'border-border text-text-secondary'}`}
            >
              {name}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <Input type="time" value={newStart} onChange={(e) => setNewStart(e.target.value)} />
          <Input type="time" value={newEnd} onChange={(e) => setNewEnd(e.target.value)} />
        </div>
        <Input type="number" min="0" step="0.01" placeholder="السعر بالساعة (ج.م)" value={newPrice} onChange={(e) => setNewPrice(e.target.value)} />
        {showAdvanced && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">الأولوية (رقم أعلى = يفوز عند تداخل فترتين)</label>
            <Input type="number" min="1" value={newPriority} onChange={(e) => setNewPriority(e.target.value)} />
          </div>
        )}
        <button type="button" className="self-start text-xs text-accent hover:underline" onClick={() => setShowAdvanced((v) => !v)}>
          {showAdvanced ? 'إخفاء الخيارات المتقدمة' : 'خيارات متقدمة'}
        </button>
        <Button
          size="sm"
          disabled={newDays.length === 0 || !newPrice || Number(newPrice) <= 0 || newStart >= newEnd || addWeeklyMutation.isPending}
          onClick={() => addWeeklyMutation.mutate()}
        >
          {addWeeklyMutation.isPending ? 'جارٍ الإضافة...' : 'إضافة السعر'}
        </Button>
        {newStart >= newEnd && <p role="alert" className="text-xs text-status-danger">وقت البداية يجب أن يكون قبل وقت النهاية</p>}
      </div>

      {/* Add special-date override */}
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <label className="text-sm font-medium text-text-secondary">سعر خاص بمناسبة/عطلة (تاريخ محدد)</label>
        <div className="flex gap-2">
          <Input type="date" value={specialDate} onChange={(e) => setSpecialDate(e.target.value)} className="flex-1" />
          <Input type="number" min="0" step="0.01" placeholder="السعر" value={specialPrice} onChange={(e) => setSpecialPrice(e.target.value)} className="flex-1" />
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!specialDate || !specialPrice || Number(specialPrice) <= 0 || addSpecialMutation.isPending}
          onClick={() => addSpecialMutation.mutate()}
        >
          {addSpecialMutation.isPending ? 'جارٍ الإضافة...' : 'إضافة سعر خاص'}
        </Button>
        <p className="text-xs text-text-secondary">يتجاوز السعر الخاص أي سعر أسبوعي في نفس التاريخ طوال اليوم.</p>
      </div>

      {formError && <p role="alert" className="text-sm text-status-danger">{formError}</p>}
    </div>
  )
}
