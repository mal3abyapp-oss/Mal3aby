import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChevronRight, ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BOOKING_STATUS_LABELS, FIELD_BLOCK_TYPE_LABELS, type BookingRow, type FieldBlockRow } from '@/lib/domain/booking'
import { QuickBookingSheet, type QuickBookingSlot } from './QuickBookingSheet'
import { BookingDetailSheet } from './BookingDetailSheet'
import { BookingsMobileView } from './BookingsMobileView'
import { resolveHoursForDay, useResolvedFieldPrice, useClubTimezone } from './useFieldPricing'
import { toInstant, fromInstant } from '@/lib/domain/time'

// Section F: mobile gets a dedicated layout, not a squeezed desktop
// grid. Matches the app's own mobile breakpoint (md: 768px, see
// resize_window preset conventions used elsewhere in this codebase).
function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isMobile
}

// V1 Operational Product Rebuild -- Section E (Booking Calendar,
// desktop/tablet): a real time-grid (30-min rows, sticky time column +
// field headers), every state visually distinct via text+color (not
// color alone), and every field header shows its live effective price
// and today's operating status so a receptionist never needs to open
// Pricing Rules or Field settings mid-booking.

const SLOT_MINUTES = 30
const GRID_START_HOUR = 6
const GRID_END_HOUR = 23
const SLOTS = Array.from(
  { length: ((GRID_END_HOUR - GRID_START_HOUR) * 60) / SLOT_MINUTES },
  (_, i) => {
    const totalMinutes = GRID_START_HOUR * 60 + i * SLOT_MINUTES
    const h = Math.floor(totalMinutes / 60)
    const m = totalMinutes % 60
    return { hour: h, minute: m, label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` }
  },
)

interface FieldWithBranch {
  id: string
  name: string
  branch_id: string
}

async function fetchFields(clubId: string, branchId: string | null) {
  let query = supabase.from('fields').select('id, name, branch_id').eq('club_id', clubId).eq('status', 'active').order('name')
  if (branchId) query = query.eq('branch_id', branchId)
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as FieldWithBranch[]
}

async function fetchBranches(clubId: string) {
  const { data, error } = await supabase.from('branches').select('id, name').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

async function fetchBookingsForDay(clubId: string, date: string, timezone: string) {
  // Gate 1 fix: the day boundary must be the venue-local day, converted
  // to a real instant — a naive "date+T00:00:00" string sent to a
  // timestamptz filter was interpreted as UTC, silently shifting which
  // bookings "today" actually returned near midnight.
  const dayStart = toInstant(date, '00:00', timezone)
  const dayEnd = toInstant(date, '23:59:59', timezone)
  const { data, error } = await supabase
    .from('bookings')
    .select('id, field_id, branch_id, customer_id, start_at, end_at, status, total_price, discount_amount, booking_series_id, invoice_id, notes, customers(full_name, mobile_display)')
    .eq('club_id', clubId)
    .gte('start_at', dayStart)
    .lte('start_at', dayEnd)
    .neq('status', 'cancelled')
  if (error) throw error
  return (data ?? []).map<BookingRow>((b) => ({
    id: b.id,
    fieldId: b.field_id,
    branchId: b.branch_id,
    customerId: b.customer_id,
    customerName: (b.customers as unknown as { full_name: string; mobile_display: string | null } | null)?.full_name ?? '—',
    customerMobile: (b.customers as unknown as { full_name: string; mobile_display: string | null } | null)?.mobile_display ?? null,
    startAt: b.start_at,
    endAt: b.end_at,
    status: b.status,
    totalPrice: Number(b.total_price),
    discountAmount: Number(b.discount_amount),
    bookingSeriesId: b.booking_series_id,
    invoiceId: b.invoice_id,
    notes: b.notes,
  }))
}

async function fetchBlocksForDay(clubId: string, date: string, timezone: string) {
  const dayStart = toInstant(date, '00:00', timezone)
  const dayEnd = toInstant(date, '23:59:59', timezone)
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

async function fetchOperatingHours(clubId: string) {
  const { data, error } = await supabase
    .from('field_operating_hours')
    .select('field_id, branch_id, day_of_week, open_time, close_time')
    .eq('club_id', clubId)
  if (error) throw error
  return data ?? []
}

function FieldColumnHeader({ field, clubId, date, clubTimezone }: { field: FieldWithBranch; clubId: string; date: string; clubTimezone?: string }) {
  const dayOfWeek = new Date(`${date}T12:00:00`).getDay()
  const { data: hoursRows = [] } = useQuery({
    queryKey: ['field-operating-hours-all', clubId],
    queryFn: () => fetchOperatingHours(clubId),
  })
  const hours = resolveHoursForDay(hoursRows, field.id, dayOfWeek)
  const nowTime = clubTimezone ? fromInstant(new Date(), clubTimezone).time : new Date().toTimeString().slice(0, 5)
  const { data: currentPrice } = useResolvedFieldPrice(field.id, date, `${nowTime}:00`, `${nowTime}:00`)

  return (
    <div className="flex flex-col gap-0.5 p-2">
      <p className="font-semibold">{field.name}</p>
      <p className="text-xs text-text-secondary">
        {hours.isUnrestricted ? 'مفتوح على مدار اليوم' : hours.isClosed ? 'مغلق اليوم' : `${hours.openTime?.slice(0, 5)} — ${hours.closeTime?.slice(0, 5)}`}
      </p>
      <p className="text-xs font-medium text-accent tabular-nums">
        {currentPrice != null ? `${currentPrice.toFixed(0)} ج.م/ساعة الآن` : 'السعر متغيّر حسب الوقت'}
      </p>
    </div>
  )
}

export function BookingsPage() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const isMobile = useIsMobile()
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [branchId, setBranchId] = useState<string | null>(null)
  const [slotSelection, setSlotSelection] = useState<QuickBookingSlot | null>(null)
  const [selectedBooking, setSelectedBooking] = useState<BookingRow | null>(null)

  const { data: clubTimezone } = useClubTimezone(currentClubId)
  const { data: branches = [] } = useQuery({ queryKey: ['branches-for-bookings', currentClubId], queryFn: () => fetchBranches(currentClubId!), enabled: !!currentClubId })
  const { data: fields = [] } = useQuery({ queryKey: ['fields-for-bookings', currentClubId, branchId], queryFn: () => fetchFields(currentClubId!, branchId), enabled: !!currentClubId })
  const { data: bookings = [], isLoading } = useQuery({
    queryKey: ['bookings', currentClubId, date, clubTimezone],
    queryFn: () => fetchBookingsForDay(currentClubId!, date, clubTimezone!),
    enabled: !!currentClubId && !!clubTimezone,
  })
  const { data: blocks = [] } = useQuery({
    queryKey: ['field-blocks', currentClubId, date, clubTimezone],
    queryFn: () => fetchBlocksForDay(currentClubId!, date, clubTimezone!),
    enabled: !!currentClubId && !!clubTimezone,
  })

  function invalidateGrid() {
    void queryClient.invalidateQueries({ queryKey: ['bookings', currentClubId] })
    void queryClient.invalidateQueries({ queryKey: ['field-blocks', currentClubId] })
  }

  const bookingsByField = useMemo(() => {
    const map = new Map<string, BookingRow[]>()
    for (const b of bookings) {
      const arr = map.get(b.fieldId) ?? []
      arr.push(b)
      map.set(b.fieldId, arr)
    }
    return map
  }, [bookings])

  const blocksByField = useMemo(() => {
    const map = new Map<string, FieldBlockRow[]>()
    for (const blk of blocks) {
      const arr = map.get(blk.fieldId) ?? []
      arr.push(blk)
      map.set(blk.fieldId, arr)
    }
    return map
  }, [blocks])

  function slotMinutesOf(iso: string) {
    // Gate 1 fix: must read the stored instant back in the venue's
    // timezone, not the browser's local zone (new Date().getHours() used
    // to silently assume they're the same — wrong for any staff viewing
    // from outside the venue's timezone, and untestable-by-coincidence
    // whenever they happen to match).
    if (!clubTimezone) return 0
    const { time } = fromInstant(iso, clubTimezone)
    const [h = 0, m = 0] = time.split(':').map(Number)
    return h * 60 + m
  }

  function entityAtSlot(fieldId: string, slotMin: number) {
    const fieldBookings = bookingsByField.get(fieldId) ?? []
    const booking = fieldBookings.find((b) => {
      const start = slotMinutesOf(b.startAt)
      const end = slotMinutesOf(b.endAt)
      return slotMin >= start && slotMin < end
    })
    if (booking) return { kind: 'booking' as const, booking, isStart: slotMinutesOf(booking.startAt) === slotMin }

    const fieldBlocks = blocksByField.get(fieldId) ?? []
    const block = fieldBlocks.find((blk) => {
      const start = slotMinutesOf(blk.startAt)
      const end = slotMinutesOf(blk.endAt)
      return slotMin >= start && slotMin < end
    })
    if (block) return { kind: 'block' as const, block, isStart: slotMinutesOf(block.startAt) === slotMin }

    return null
  }

  function shiftDate(days: number) {
    const d = new Date(`${date}T12:00:00`)
    d.setDate(d.getDate() + days)
    setDate(d.toISOString().slice(0, 10))
  }

  const dayOfWeek = new Date(`${date}T12:00:00`).getDay()
  const { data: hoursRows = [] } = useQuery({
    queryKey: ['field-operating-hours-all', currentClubId],
    queryFn: () => fetchOperatingHours(currentClubId!),
    enabled: !!currentClubId,
  })

  if (isMobile) {
    return (
      <div className="flex flex-col gap-3">
        <PageHeader title="الحجوزات" description="" className="pb-0" />
        {fields.length === 0 ? (
          <p className="text-sm text-text-secondary">لا توجد ملاعب بعد. أضف ملعبًا من الإعدادات أولاً.</p>
        ) : !clubTimezone ? (
          <p className="text-sm text-text-secondary">جارٍ التحميل...</p>
        ) : (
          <BookingsMobileView
            date={date}
            onDateChange={setDate}
            fields={fields}
            bookings={bookings}
            blocks={blocks}
            hoursRows={hoursRows}
            clubTimezone={clubTimezone}
            onSlotSelect={setSlotSelection}
            onBookingSelect={setSelectedBooking}
          />
        )}

        <QuickBookingSheet
          slot={slotSelection}
          clubId={currentClubId!}
          onOpenChange={(open) => !open && setSlotSelection(null)}
          onCreated={invalidateGrid}
        />
        <BookingDetailSheet
          booking={selectedBooking}
          fieldName={fields.find((f) => f.id === selectedBooking?.fieldId)?.name ?? ''}
          clubTimezone={clubTimezone ?? 'UTC'}
          onOpenChange={(open) => !open && setSelectedBooking(null)}
          onChanged={invalidateGrid}
        />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="الحجوزات"
        description="التقويم اليومي للملاعب"
        actions={
          <div className="flex items-center gap-2">
            {branches.length > 1 && (
              <Select value={branchId ?? 'all'} onValueChange={(v) => setBranchId(v === 'all' ? null : v)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل الفروع</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <Button variant="outline" size="icon" aria-label="اليوم السابق" onClick={() => shiftDate(-1)}><ChevronRight className="size-4" /></Button>
            <Button variant="outline" size="sm" onClick={() => setDate(new Date().toISOString().slice(0, 10))}>اليوم</Button>
            <Button variant="outline" size="icon" aria-label="اليوم التالي" onClick={() => shiftDate(1)}><ChevronLeft className="size-4" /></Button>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
            />
          </div>
        }
      />

      {fields.length === 0 ? (
        <p className="text-sm text-text-secondary">لا توجد ملاعب بعد. أضف ملعبًا من صفحة النادي أولاً.</p>
      ) : (
        <div className="max-h-[calc(100vh-220px)] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-20 bg-surface">
              <tr>
                <th className="sticky start-0 z-30 w-20 border-b border-border bg-surface p-2 text-start text-xs text-text-secondary">الوقت</th>
                {fields.map((f) => (
                  <th key={f.id} className="min-w-[180px] border-b border-s border-border bg-surface text-start font-normal">
                    <FieldColumnHeader field={f} clubId={currentClubId!} date={date} clubTimezone={clubTimezone} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SLOTS.map((slot) => {
                const slotMin = slot.hour * 60 + slot.minute
                const isHourStart = slot.minute === 0
                return (
                  <tr key={slot.label} className={cn(isHourStart && 'border-t-2 border-t-border')}>
                    <td className="sticky start-0 z-10 border-b border-border bg-surface p-1.5 text-xs text-text-secondary tabular-nums">
                      {isHourStart ? slot.label : ''}
                    </td>
                    {fields.map((f) => {
                      const entity = entityAtSlot(f.id, slotMin)
                      const hours = resolveHoursForDay(hoursRows, f.id, dayOfWeek)
                      const isClosedNow = !hours.isUnrestricted && (hours.isClosed || (hours.openTime && hours.closeTime && (slot.label < hours.openTime.slice(0, 5) || slot.label >= hours.closeTime.slice(0, 5))))

                      if (entity?.kind === 'booking') {
                        if (!entity.isStart) return <td key={f.id} className="border-b border-s border-border p-0" />
                        const b = entity.booking
                        const durationSlots = Math.round((slotMinutesOf(b.endAt) - slotMinutesOf(b.startAt)) / SLOT_MINUTES)
                        const toneClass = {
                          pending_payment: 'bg-status-warning/15 border-status-warning/40 text-status-warning',
                          confirmed: 'bg-status-success/15 border-status-success/40 text-status-success',
                          checked_in: 'bg-status-info/15 border-status-info/40 text-status-info',
                          completed: 'bg-status-neutral/10 border-status-neutral/30 text-status-neutral',
                          no_show: 'bg-status-danger/15 border-status-danger/40 text-status-danger',
                        }[b.status] ?? 'bg-muted border-border text-text-primary'
                        return (
                          <td key={f.id} rowSpan={durationSlots} className="border-s border-border p-1 align-top">
                            <button
                              type="button"
                              onClick={() => setSelectedBooking(b)}
                              className={cn('flex h-full w-full flex-col gap-0.5 rounded-md border p-1.5 text-start text-xs transition hover:brightness-95', toneClass)}
                            >
                              <span className="font-semibold">{b.customerName}</span>
                              <span>{BOOKING_STATUS_LABELS[b.status] ?? b.status}</span>
                            </button>
                          </td>
                        )
                      }

                      if (entity?.kind === 'block') {
                        if (!entity.isStart) return <td key={f.id} className="border-b border-s border-border p-0" />
                        const blk = entity.block
                        const durationSlots = Math.round((slotMinutesOf(blk.endAt) - slotMinutesOf(blk.startAt)) / SLOT_MINUTES)
                        return (
                          <td key={f.id} rowSpan={durationSlots} className="border-s border-border p-1 align-top">
                            <div className="flex h-full w-full flex-col gap-0.5 rounded-md border border-dashed border-status-danger/40 bg-status-danger/5 p-1.5 text-xs text-status-danger">
                              <span className="font-semibold">{FIELD_BLOCK_TYPE_LABELS[blk.type] ?? blk.type}</span>
                              {blk.reason && <span className="text-status-danger/80">{blk.reason}</span>}
                            </div>
                          </td>
                        )
                      }

                      if (isClosedNow) {
                        return (
                          <td key={f.id} className="border-b border-s border-border bg-muted/50 p-1 text-center text-[10px] text-text-secondary/60">
                            مغلق
                          </td>
                        )
                      }

                      return (
                        <td
                          key={f.id}
                          className="cursor-pointer border-b border-s border-border p-1 hover:bg-accent/10"
                          onClick={() => setSlotSelection({ fieldId: f.id, fieldName: f.name, branchId: f.branch_id, date, startTime: slot.label })}
                        >
                          <div className="h-6" />
                        </td>
                      )
                    })}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}

      <QuickBookingSheet
        slot={slotSelection}
        clubId={currentClubId!}
        onOpenChange={(open) => !open && setSlotSelection(null)}
        onCreated={invalidateGrid}
      />

      <BookingDetailSheet
        booking={selectedBooking}
        fieldName={fields.find((f) => f.id === selectedBooking?.fieldId)?.name ?? ''}
        clubTimezone={clubTimezone ?? 'UTC'}
        onOpenChange={(open) => !open && setSelectedBooking(null)}
        onChanged={invalidateGrid}
      />
    </div>
  )
}
