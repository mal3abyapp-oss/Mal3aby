import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { BOOKING_STATUS_LABELS, type BookingRow, type FieldBlockRow } from '@/lib/domain/booking'

// Day-view calendar grid (rows = hourly slots, columns = fields), quick
// booking form (incl. Recurring toggle), booking detail/cancel, Quick
// Field Block. Real Supabase-backed, no mock data.
const HOURS = Array.from({ length: 16 }, (_, i) => i + 6) // 06:00-21:00

async function fetchFields(clubId: string) {
  const { data, error } = await supabase.from('fields').select('id, name').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

async function fetchCustomers(clubId: string) {
  const { data, error } = await supabase.from('customers').select('id, full_name').eq('club_id', clubId).order('full_name').limit(100)
  if (error) throw error
  return data ?? []
}

async function fetchBookingsForDay(clubId: string, date: string) {
  const dayStart = `${date}T00:00:00`
  const dayEnd = `${date}T23:59:59`
  const { data, error } = await supabase
    .from('bookings')
    .select('id, field_id, customer_id, start_at, end_at, status, total_price, booking_series_id, customers(full_name)')
    .eq('club_id', clubId)
    .gte('start_at', dayStart)
    .lte('start_at', dayEnd)
    .neq('status', 'cancelled')
  if (error) throw error
  return (data ?? []).map<BookingRow>((b) => ({
    id: b.id,
    fieldId: b.field_id,
    customerId: b.customer_id,
    customerName: (b.customers as unknown as { full_name: string } | null)?.full_name ?? '—',
    startAt: b.start_at,
    endAt: b.end_at,
    status: b.status,
    totalPrice: Number(b.total_price),
    bookingSeriesId: b.booking_series_id,
  }))
}

async function fetchBlocksForDay(clubId: string, date: string) {
  const dayStart = `${date}T00:00:00`
  const dayEnd = `${date}T23:59:59`
  const { data, error } = await supabase
    .from('field_blocks')
    .select('id, field_id, start_at, end_at, type, reason')
    .eq('club_id', clubId)
    .gte('start_at', dayStart)
    .lte('start_at', dayEnd)
  if (error) throw error
  return (data ?? []).map<FieldBlockRow>((b) => ({
    id: b.id,
    fieldId: b.field_id,
    startAt: b.start_at,
    endAt: b.end_at,
    type: b.type,
    reason: b.reason,
  }))
}

export function BookingsPage() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [bookingDialogOpen, setBookingDialogOpen] = useState(false)
  const [selectedBooking, setSelectedBooking] = useState<BookingRow | null>(null)
  const [slotSelection, setSlotSelection] = useState<{ fieldId: string; hour: number } | null>(null)

  const [customerId, setCustomerId] = useState('')
  const [duration, setDuration] = useState('1')
  const [isRecurring, setIsRecurring] = useState(false)
  const [occurrenceCount, setOccurrenceCount] = useState('4')
  const [formError, setFormError] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  const { data: fields = [] } = useQuery({ queryKey: ['fields-for-bookings', currentClubId], queryFn: () => fetchFields(currentClubId!), enabled: !!currentClubId })
  const { data: customers = [] } = useQuery({ queryKey: ['customers-for-bookings', currentClubId], queryFn: () => fetchCustomers(currentClubId!), enabled: !!currentClubId })
  const { data: bookings = [], isLoading } = useQuery({
    queryKey: ['bookings', currentClubId, date],
    queryFn: () => fetchBookingsForDay(currentClubId!, date),
    enabled: !!currentClubId,
  })
  const { data: blocks = [] } = useQuery({
    queryKey: ['field-blocks', currentClubId, date],
    queryFn: () => fetchBlocksForDay(currentClubId!, date),
    enabled: !!currentClubId,
  })

  function invalidateGrid() {
    void queryClient.invalidateQueries({ queryKey: ['bookings', currentClubId, date] })
    void queryClient.invalidateQueries({ queryKey: ['field-blocks', currentClubId, date] })
  }

  const bookMutation = useMutation({
    mutationFn: async () => {
      if (!slotSelection || !customerId) throw new Error('missing input')
      const startAt = `${date}T${String(slotSelection.hour).padStart(2, '0')}:00:00`
      const endAt = `${date}T${String(slotSelection.hour + Number(duration)).padStart(2, '0')}:00:00`

      if (isRecurring) {
        const { error } = await supabase.rpc('create_recurring_booking', {
          p_field_id: slotSelection.fieldId,
          p_customer_id: customerId,
          p_first_start_at: startAt,
          p_first_end_at: endAt,
          p_occurrence_count: Number(occurrenceCount),
        })
        if (error) throw error
      } else {
        const { error } = await supabase.rpc('create_booking', {
          p_field_id: slotSelection.fieldId,
          p_customer_id: customerId,
          p_start_at: startAt,
          p_end_at: endAt,
        })
        if (error) throw error
      }
    },
    onSuccess: () => {
      setBookingDialogOpen(false)
      setCustomerId('')
      setIsRecurring(false)
      setFormError(null)
      invalidateGrid()
    },
    onError: () => setFormError('تعذّر إنشاء الحجز — قد يكون الموعد محجوزًا بالفعل أو غير مصرّح به.'),
  })

  const qrMutation = useMutation({
    mutationFn: async () => {
      if (!selectedBooking) throw new Error('no booking selected')
      const { data, error } = await supabase.rpc('ensure_booking_qr', { p_booking_id: selectedBooking.id })
      if (error) throw error
      return data as string
    },
    onSuccess: async (rawToken) => {
      const dataUrl = await QRCode.toDataURL(rawToken, { width: 240, margin: 1 })
      setQrDataUrl(dataUrl)
    },
    onError: () => setFormError('تعذّر إنشاء رمز QR.'),
  })

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!selectedBooking) throw new Error('no booking selected')
      const { error } = await supabase.rpc('cancel_booking', { p_booking_id: selectedBooking.id, p_reason: cancelReason })
      if (error) throw error
    },
    onSuccess: () => {
      setSelectedBooking(null)
      setCancelReason('')
      invalidateGrid()
    },
  })

  // V1 Implementation Gap Audit (2026-08-16): mark_booking_no_show had a
  // working, permission-gated RPC since Phase 6/9 but no UI anywhere --
  // a receptionist/manager had no way to record a no-show through the
  // product, despite it being a named V1 booking lifecycle state.
  const noShowMutation = useMutation({
    mutationFn: async () => {
      if (!selectedBooking) throw new Error('no booking selected')
      const { error } = await supabase.rpc('mark_booking_no_show', { p_booking_id: selectedBooking.id })
      if (error) throw error
    },
    onSuccess: () => {
      setSelectedBooking(null)
      invalidateGrid()
    },
  })

  const quickBlockMutation = useMutation({
    mutationFn: async () => {
      if (!slotSelection) throw new Error('no slot selected')
      const startAt = `${date}T${String(slotSelection.hour).padStart(2, '0')}:00:00`
      const endAt = `${date}T${String(slotSelection.hour + 1).padStart(2, '0')}:00:00`
      const { data, error } = await supabase.rpc('create_field_block', {
        p_field_id: slotSelection.fieldId,
        p_start_at: startAt,
        p_end_at: endAt,
        p_type: 'manual',
        p_reason: 'إغلاق سريع',
      })
      if (error) throw error
      return data?.[0]
    },
    onSuccess: (result) => {
      setBookingDialogOpen(false)
      invalidateGrid()
      const conflictCount = result?.conflicting_booking_ids?.length ?? 0
      if (conflictCount > 0) {
        setFormError(`تم الإغلاق، لكن يوجد ${conflictCount} حجز/حجوزات متعارضة تحتاج مراجعة يدوية.`)
      }
    },
  })

  function bookingAt(fieldId: string, hour: number) {
    return bookings.find((b) => {
      if (b.fieldId !== fieldId) return false
      const startHour = new Date(b.startAt).getUTCHours()
      const endHour = new Date(b.endAt).getUTCHours()
      return hour >= startHour && hour < endHour
    })
  }

  function blockAt(fieldId: string, hour: number) {
    return blocks.find((blk) => {
      if (blk.fieldId !== fieldId) return false
      const startHour = new Date(blk.startAt).getUTCHours()
      const endHour = new Date(blk.endAt).getUTCHours()
      return hour >= startHour && hour < endHour
    })
  }

  return (
    <div>
      <PageHeader
        title="الحجوزات"
        description="التقويم اليومي للملاعب"
        actions={
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-40" />
        }
      />

      {fields.length === 0 ? (
        <p className="text-sm text-text-secondary">لا توجد ملاعب بعد. أضف ملعبًا من صفحة النادي أولاً.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="w-16 border-b border-border p-2 text-start text-text-secondary">الوقت</th>
                {fields.map((f) => (
                  <th key={f.id} className="border-b border-s border-border p-2 text-start">{f.name}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {HOURS.map((hour) => (
                <tr key={hour}>
                  <td className="border-b border-border p-2 text-text-secondary tabular-nums">{hour}:00</td>
                  {fields.map((f) => {
                    const booking = bookingAt(f.id, hour)
                    const block = blockAt(f.id, hour)
                    return (
                      <td
                        key={f.id}
                        className={cn(
                          'border-b border-s border-border p-1 align-top',
                          !booking && !block && 'cursor-pointer hover:bg-muted/40',
                        )}
                        onClick={() => {
                          if (booking) {
                            setSelectedBooking(booking)
                          } else if (!block) {
                            setSlotSelection({ fieldId: f.id, hour })
                            setBookingDialogOpen(true)
                          }
                        }}
                      >
                        {booking ? (
                          <div className="rounded bg-accent/20 p-1.5 text-xs">
                            <p className="font-medium">{booking.customerName}</p>
                            <StatusBadge
                              tone={booking.status === 'confirmed' ? 'success' : booking.status === 'pending_payment' ? 'warning' : 'neutral'}
                              label={BOOKING_STATUS_LABELS[booking.status] ?? booking.status}
                            />
                          </div>
                        ) : block ? (
                          <div className="rounded bg-status-danger/10 p-1.5 text-xs text-status-danger">مغلق ({block.type})</div>
                        ) : (
                          <div className="h-8" />
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isLoading && <p className="mt-2 text-sm text-text-secondary">جارٍ التحميل...</p>}

      {/* Quick booking / Quick Field Block dialog */}
      <Dialog open={bookingDialogOpen} onOpenChange={setBookingDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>حجز جديد — {slotSelection?.hour}:00</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">العميل</label>
              <Select value={customerId} onValueChange={setCustomerId}>
                <SelectTrigger><SelectValue placeholder="اختر عميلاً" /></SelectTrigger>
                <SelectContent>
                  {customers.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.full_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">المدة (ساعات)</label>
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['1', '2', '3'].map((d) => (
                    <SelectItem key={d} value={d}>{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="recurring" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} />
              <label htmlFor="recurring" className="text-sm">حجز متكرر (أسبوعي)</label>
            </div>
            {isRecurring && (
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">عدد التكرارات</label>
                <Input type="number" min={1} max={52} value={occurrenceCount} onChange={(e) => setOccurrenceCount(e.target.value)} />
              </div>
            )}
            {formError && (
              <p role="alert" className="text-sm text-status-danger">{formError}</p>
            )}
            <div className="flex gap-2">
              <Button onClick={() => bookMutation.mutate()} disabled={!customerId || bookMutation.isPending}>
                {bookMutation.isPending ? 'جارٍ الحجز...' : 'تأكيد الحجز'}
              </Button>
              <Button variant="outline" onClick={() => quickBlockMutation.mutate()} disabled={quickBlockMutation.isPending}>
                إغلاق سريع للملعب
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Booking detail / cancel / QR */}
      <Dialog
        open={!!selectedBooking}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedBooking(null)
            setQrDataUrl(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>تفاصيل الحجز</DialogTitle>
          </DialogHeader>
          {selectedBooking && (
            <div className="flex flex-col gap-3 text-sm">
              <p>العميل: {selectedBooking.customerName}</p>
              <p>الوقت: {new Date(selectedBooking.startAt).toLocaleString('ar-EG')}</p>
              <p>السعر: {selectedBooking.totalPrice} EGP</p>
              <StatusBadge tone="info" label={BOOKING_STATUS_LABELS[selectedBooking.status] ?? selectedBooking.status} />

              {(selectedBooking.status === 'pending_payment' || selectedBooking.status === 'confirmed') && (
                <div className="flex flex-col items-center gap-2 border-t border-border pt-3">
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt="رمز QR للحجز" className="size-48" />
                  ) : (
                    <Button variant="outline" size="sm" disabled={qrMutation.isPending} onClick={() => qrMutation.mutate()}>
                      {qrMutation.isPending ? 'جارٍ الإنشاء...' : 'عرض رمز QR'}
                    </Button>
                  )}
                </div>
              )}

              {(selectedBooking.status === 'confirmed' || selectedBooking.status === 'checked_in') && (
                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <Button variant="outline" size="sm" disabled={noShowMutation.isPending} onClick={() => noShowMutation.mutate()}>
                    {noShowMutation.isPending ? 'جارٍ التسجيل...' : 'تسجيل عدم حضور'}
                  </Button>
                </div>
              )}

              {selectedBooking.status !== 'cancelled' && selectedBooking.status !== 'no_show' && (
                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <Input placeholder="سبب الإلغاء" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
                  <Button variant="destructive" size="sm" disabled={!cancelReason.trim() || cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>
                    إلغاء الحجز
                  </Button>
                </div>
              )}

              {formError && (
                <p role="alert" className="text-sm text-status-danger">{formError}</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
