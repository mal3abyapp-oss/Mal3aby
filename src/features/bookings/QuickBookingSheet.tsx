import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useResolvedFieldPrice } from './useFieldPricing'

// Section E3 — Quick Booking: a right-side drawer opened from an empty
// calendar slot. Price is ALWAYS server-resolved (resolve_field_price)
// and shown before confirmation -- never guessed client-side.

export interface QuickBookingSlot {
  fieldId: string
  fieldName: string
  branchId: string
  date: string // YYYY-MM-DD
  startTime: string // HH:MM
}

interface Customer {
  id: string
  full_name: string
  mobile_display: string | null
}

async function fetchCustomers(clubId: string, search: string) {
  let query = supabase.from('customers').select('id, full_name, mobile_display').eq('club_id', clubId).order('full_name').limit(50)
  if (search.trim()) {
    query = query.or(`full_name.ilike.%${search}%,normalized_mobile.ilike.%${search}%`)
  }
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as Customer[]
}

const DURATIONS = [
  { value: '0.5', label: '30 دقيقة' },
  { value: '1', label: 'ساعة واحدة' },
  { value: '1.5', label: 'ساعة ونصف' },
  { value: '2', label: 'ساعتان' },
  { value: '3', label: '3 ساعات' },
]

export function QuickBookingSheet({
  slot,
  clubId,
  onOpenChange,
  onCreated,
}: {
  slot: QuickBookingSlot | null
  clubId: string
  onOpenChange: (open: boolean) => void
  onCreated: () => void
}) {
  const queryClient = useQueryClient()
  const [customerId, setCustomerId] = useState('')
  const [customerSearch, setCustomerSearch] = useState('')
  const [duration, setDuration] = useState('1')
  const [payNow, setPayNow] = useState(true)
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [formError, setFormError] = useState<string | null>(null)
  const [showNewCustomer, setShowNewCustomer] = useState(false)
  const [newCustomerName, setNewCustomerName] = useState('')
  const [newCustomerMobile, setNewCustomerMobile] = useState('')

  useEffect(() => {
    if (!slot) {
      setCustomerId('')
      setCustomerSearch('')
      setDuration('1')
      setPayNow(true)
      setFormError(null)
      setShowNewCustomer(false)
      setNewCustomerName('')
      setNewCustomerMobile('')
    }
  }, [slot])

  const { data: customers = [] } = useQuery({
    queryKey: ['customers-search', clubId, customerSearch],
    queryFn: () => fetchCustomers(clubId, customerSearch),
    enabled: !!clubId && !!slot,
  })

  const endTime = useMemo(() => {
    if (!slot) return null
    const [h, m] = slot.startTime.split(':').map(Number)
    const totalMinutes = (h ?? 0) * 60 + (m ?? 0) + Number(duration) * 60
    const endH = Math.floor(totalMinutes / 60) % 24
    const endM = totalMinutes % 60
    return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`
  }, [slot, duration])

  const { data: resolvedPrice, isLoading: priceLoading } = useResolvedFieldPrice(
    slot?.fieldId ?? null,
    slot?.date ?? null,
    slot?.startTime ? `${slot.startTime}:00` : null,
    endTime ? `${endTime}:00` : null,
  )

  const createCustomerMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from('customers')
        .insert({ club_id: clubId, full_name: newCustomerName, mobile_display: newCustomerMobile || null, normalized_mobile: newCustomerMobile || null })
        .select('id, full_name, mobile_display')
        .single()
      if (error) throw error
      return data
    },
    onSuccess: (data) => {
      setCustomerId(data.id)
      setShowNewCustomer(false)
      void queryClient.invalidateQueries({ queryKey: ['customers-search', clubId] })
    },
    onError: () => setFormError('تعذّر إضافة العميل.'),
  })

  const bookMutation = useMutation({
    mutationFn: async () => {
      if (!slot || !customerId) throw new Error('missing input')
      const startAt = `${slot.date}T${slot.startTime}:00`
      const endAt = `${slot.date}T${endTime}:00`
      const { error } = await supabase.rpc('create_booking', {
        p_field_id: slot.fieldId,
        p_customer_id: customerId,
        p_start_at: startAt,
        p_end_at: endAt,
        p_record_payment: payNow,
        p_payment_amount: payNow ? resolvedPrice ?? undefined : undefined,
        p_payment_method: payNow ? paymentMethod : undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      onOpenChange(false)
      onCreated()
    },
    onError: (error) =>
      setFormError(translateSupabaseError(error, 'تعذّر إنشاء الحجز — قد يكون الموعد محجوزًا بالفعل أو غير مصرّح به.')),
  })

  return (
    <Sheet open={!!slot} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>حجز جديد</SheetTitle>
          {slot && (
            <SheetDescription>
              {slot.fieldName} — {new Date(slot.date).toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' })}
            </SheetDescription>
          )}
        </SheetHeader>

        {slot && (
          <div className="flex flex-1 flex-col gap-5 py-4">
            {/* Field / Date / Time summary */}
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <div>
                <p className="text-xs text-text-secondary">الملعب</p>
                <p className="font-medium">{slot.fieldName}</p>
              </div>
              <div>
                <p className="text-xs text-text-secondary">الوقت</p>
                <p className="font-medium tabular-nums">{slot.startTime} — {endTime}</p>
              </div>
            </div>

            {/* Duration */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">المدة</label>
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DURATIONS.map((d) => (
                    <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Customer */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-text-secondary">العميل</label>
                <button type="button" className="text-xs text-accent hover:underline" onClick={() => setShowNewCustomer((v) => !v)}>
                  {showNewCustomer ? 'اختيار عميل موجود' : '+ عميل جديد'}
                </button>
              </div>
              {showNewCustomer ? (
                <div className="flex flex-col gap-2 rounded-md border border-border p-2">
                  <Input placeholder="الاسم" value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)} />
                  <Input placeholder="رقم الموبايل" value={newCustomerMobile} onChange={(e) => setNewCustomerMobile(e.target.value)} />
                  <Button size="sm" disabled={!newCustomerName.trim() || createCustomerMutation.isPending} onClick={() => createCustomerMutation.mutate()}>
                    {createCustomerMutation.isPending ? 'جارٍ الإضافة...' : 'إضافة العميل'}
                  </Button>
                </div>
              ) : (
                <>
                  <Input placeholder="ابحث بالاسم أو الموبايل..." value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} />
                  <Select value={customerId} onValueChange={setCustomerId}>
                    <SelectTrigger><SelectValue placeholder="اختر عميلاً" /></SelectTrigger>
                    <SelectContent>
                      {customers.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.full_name}{c.mobile_display ? ` — ${c.mobile_display}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>

            {/* Price -- server resolved, always visible before confirmation */}
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
              {priceLoading ? (
                <p className="text-sm text-text-secondary">جارٍ حساب السعر...</p>
              ) : resolvedPrice != null ? (
                <div className="flex flex-col gap-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">سعر الساعة</span>
                    <span className="tabular-nums">{(resolvedPrice / Number(duration)).toFixed(0)} ج.م</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">المدة</span>
                    <span className="tabular-nums">{duration} ساعة</span>
                  </div>
                  <div className="mt-1 flex justify-between border-t border-accent/20 pt-1 font-semibold">
                    <span>الإجمالي</span>
                    <span className="tabular-nums">{resolvedPrice.toFixed(0)} ج.م</span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-status-danger">تعذّر حساب السعر لهذا الموعد.</p>
              )}
            </div>

            {/* Payment */}
            <div className="flex flex-col gap-2">
              <label className="text-sm font-medium text-text-secondary">الدفع</label>
              <div className="flex gap-2">
                <Button type="button" variant={payNow ? 'default' : 'outline'} size="sm" onClick={() => setPayNow(true)}>
                  دفع الآن
                </Button>
                <Button type="button" variant={!payNow ? 'default' : 'outline'} size="sm" onClick={() => setPayNow(false)}>
                  بانتظار الدفع
                </Button>
              </div>
              {payNow && (
                <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">نقدًا</SelectItem>
                    <SelectItem value="card">بطاقة</SelectItem>
                    <SelectItem value="transfer">تحويل بنكي</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </div>

            {formError && <p role="alert" className="text-sm text-status-danger">{formError}</p>}
          </div>
        )}

        <SheetFooter>
          <Button
            className="w-full"
            disabled={!customerId || !resolvedPrice || bookMutation.isPending}
            onClick={() => bookMutation.mutate()}
          >
            {bookMutation.isPending ? 'جارٍ الحجز...' : 'تأكيد الحجز'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
