import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ChevronRight, ChevronLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONE, FIELD_BLOCK_TYPE_LABELS, type BookingRow, type FieldBlockRow } from '@/lib/domain/booking'
import { StatusBadge } from '@/components/ui/status-badge'
import { resolveHoursForDay, useResolvedFieldPrice } from './useFieldPricing'
import { fromInstant, formatInstant } from '@/lib/domain/time'
import type { QuickBookingSlot } from './QuickBookingSheet'

// V1 Operational Product Rebuild -- Section F (Mobile Bookings): a
// dedicated mobile UX, not a squeezed desktop grid. One field at a
// time via chips, a single-column hourly timeline showing status/price/
// customer inline, and "Now/Next" summary cards at top so a
// receptionist can see the two things that matter most without
// scrolling: what's free right now, and what's coming up.

const HOURS = Array.from({ length: 17 }, (_, i) => i + 6) // 06:00-22:00

interface FieldWithBranch {
  id: string
  name: string
  branch_id: string
}

export function BookingsMobileView({
  date,
  onDateChange,
  fields,
  bookings,
  blocks,
  hoursRows,
  clubTimezone,
  onSlotSelect,
  onBookingSelect,
}: {
  date: string
  onDateChange: (date: string) => void
  fields: FieldWithBranch[]
  bookings: BookingRow[]
  blocks: FieldBlockRow[]
  hoursRows: { day_of_week: number; open_time: string; close_time: string; field_id: string | null }[]
  clubTimezone: string
  onSlotSelect: (slot: QuickBookingSlot) => void
  onBookingSelect: (booking: BookingRow) => void
}) {
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(fields[0]?.id ?? null)
  const activeFieldId = selectedFieldId ?? fields[0]?.id ?? null
  const activeField = fields.find((f) => f.id === activeFieldId)

  const dayOfWeek = new Date(`${date}T12:00:00`).getDay()
  const nowTime = new Date().toTimeString().slice(0, 5)
  const isToday = date === new Date().toISOString().slice(0, 10)

  const { data: currentPrice } = useResolvedFieldPrice(activeFieldId, date, `${nowTime}:00`, `${nowTime}:00`)

  function slotMinutesOf(iso: string) {
    const { time } = fromInstant(iso, clubTimezone)
    const [h = 0, m = 0] = time.split(':').map(Number)
    return h * 60 + m
  }

  const fieldBookings = useMemo(
    () => bookings.filter((b) => b.fieldId === activeFieldId).sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [bookings, activeFieldId],
  )
  const fieldBlocks = useMemo(() => blocks.filter((b) => b.fieldId === activeFieldId), [blocks, activeFieldId])

  function entityAtHour(hour: number) {
    const hourMin = hour * 60
    const booking = fieldBookings.find((b) => hourMin >= slotMinutesOf(b.startAt) && hourMin < slotMinutesOf(b.endAt))
    if (booking) return { kind: 'booking' as const, booking }
    const block = fieldBlocks.find((b) => hourMin >= slotMinutesOf(b.startAt) && hourMin < slotMinutesOf(b.endAt))
    if (block) return { kind: 'block' as const, block }
    return null
  }

  const hours = activeFieldId ? resolveHoursForDay(hoursRows, activeFieldId, dayOfWeek) : null

  // "Now" -- is the active field free right now, and until when? Must be
  // "now" as observed in the venue's timezone, not the browser's.
  const nowMin = useMemo(() => {
    const { time } = fromInstant(new Date(), clubTimezone)
    const [h = 0, m = 0] = time.split(':').map(Number)
    return h * 60 + m
  }, [clubTimezone])
  const nowBusy = isToday && fieldBookings.find((b) => nowMin >= slotMinutesOf(b.startAt) && nowMin < slotMinutesOf(b.endAt))
  const nextBooking = isToday ? fieldBookings.find((b) => slotMinutesOf(b.startAt) > nowMin) : fieldBookings[0]

  function shiftDate(days: number) {
    const d = new Date(`${date}T12:00:00`)
    d.setDate(d.getDate() + days)
    onDateChange(d.toISOString().slice(0, 10))
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Date nav */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" onClick={() => shiftDate(-1)}><ChevronRight className="size-4" /></Button>
        <Button variant="outline" size="sm" className="flex-1" onClick={() => onDateChange(new Date().toISOString().slice(0, 10))}>
          {isToday ? 'اليوم' : new Date(`${date}T12:00:00`).toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' })}
        </Button>
        <Button variant="outline" size="icon" onClick={() => shiftDate(1)}><ChevronLeft className="size-4" /></Button>
      </div>

      {/* Field chips */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {fields.map((f) => (
          <button
            key={f.id}
            onClick={() => setSelectedFieldId(f.id)}
            className={cn(
              'shrink-0 rounded-full border px-3 py-1.5 text-sm font-medium',
              f.id === activeFieldId ? 'border-accent bg-accent/10 text-accent-foreground' : 'border-border text-text-secondary',
            )}
          >
            {f.name}
          </button>
        ))}
      </div>

      {/* Now / Next cards */}
      {isToday && activeField && (
        <div className="grid grid-cols-2 gap-2">
          <div className={cn('rounded-lg border p-2.5 text-sm', nowBusy ? 'border-status-danger/30 bg-status-danger/5' : 'border-status-success/30 bg-status-success/5')}>
            <p className="text-xs text-text-secondary">الآن</p>
            {nowBusy ? (
              <p className="font-medium text-status-danger">{nowBusy.customerName}</p>
            ) : (
              <p className="font-medium text-status-success">متاح الآن</p>
            )}
          </div>
          <div className="rounded-lg border border-border p-2.5 text-sm">
            <p className="text-xs text-text-secondary">التالي</p>
            {nextBooking ? (
              <p className="font-medium tabular-nums">
                {formatInstant(nextBooking.startAt, clubTimezone, { hour: '2-digit', minute: '2-digit' })} — {nextBooking.customerName}
              </p>
            ) : (
              <p className="text-text-secondary">لا يوجد حجوزات قادمة</p>
            )}
          </div>
        </div>
      )}

      {/* Current price banner */}
      {activeField && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-2.5 text-sm">
          <span className="text-text-secondary">السعر الآن: </span>
          {currentPrice != null ? (
            <span className="font-semibold tabular-nums">{currentPrice.toFixed(0)} ج.م/ساعة</span>
          ) : (
            <span className="text-status-danger">لا يوجد سعر معتمد</span>
          )}
          {hours && (
            <span className="ms-2 text-text-secondary">
              {hours.isUnrestricted ? '(مفتوح على مدار اليوم)' : hours.isClosed ? '(مغلق اليوم)' : `(${hours.openTime?.slice(0, 5)}–${hours.closeTime?.slice(0, 5)})`}
            </span>
          )}
        </div>
      )}

      {/* Hourly timeline */}
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {HOURS.map((hour) => {
          const entity = entityAtHour(hour)
          const label = `${String(hour).padStart(2, '0')}:00`
          const isClosedNow = hours && !hours.isUnrestricted && (hours.isClosed || (hours.openTime && hours.closeTime && (label < hours.openTime.slice(0, 5) || label >= hours.closeTime.slice(0, 5))))

          if (entity?.kind === 'booking') {
            const b = entity.booking
            const isStart = Number(fromInstant(b.startAt, clubTimezone).time.split(':')[0]) === hour
            if (!isStart) return null
            return (
              <button
                key={hour}
                onClick={() => onBookingSelect(b)}
                className="flex items-center justify-between gap-2 p-3 text-start active:bg-muted/40"
              >
                <div className="flex flex-col">
                  <span className="text-xs text-text-secondary tabular-nums">{label}</span>
                  <span className="font-medium">{b.customerName}</span>
                </div>
                <StatusBadge tone={BOOKING_STATUS_TONE[b.status] ?? 'neutral'} label={BOOKING_STATUS_LABELS[b.status] ?? b.status} />
              </button>
            )
          }

          if (entity?.kind === 'block') {
            const blk = entity.block
            const isStart = Number(fromInstant(blk.startAt, clubTimezone).time.split(':')[0]) === hour
            if (!isStart) return null
            return (
              <div key={hour} className="flex items-center justify-between gap-2 bg-status-danger/5 p-3">
                <div className="flex flex-col">
                  <span className="text-xs text-text-secondary tabular-nums">{label}</span>
                  <span className="font-medium text-status-danger">{FIELD_BLOCK_TYPE_LABELS[blk.type] ?? blk.type}</span>
                </div>
                {blk.reason && <span className="text-xs text-status-danger/80">{blk.reason}</span>}
              </div>
            )
          }

          if (isClosedNow) {
            return (
              <div key={hour} className="flex items-center gap-3 bg-muted/30 p-3 text-text-secondary/60">
                <span className="text-xs tabular-nums">{label}</span>
                <span className="text-sm">مغلق</span>
              </div>
            )
          }

          return (
            <button
              key={hour}
              onClick={() => activeField && onSlotSelect({ fieldId: activeField.id, fieldName: activeField.name, branchId: activeField.branch_id, date, startTime: label })}
              className="flex items-center gap-3 p-3 text-start active:bg-accent/10"
            >
              <span className="text-xs text-text-secondary tabular-nums">{label}</span>
              <span className="text-sm text-status-success">متاح</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
