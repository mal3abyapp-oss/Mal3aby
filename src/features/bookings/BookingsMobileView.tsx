import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { ChevronRight, ChevronLeft, CalendarX2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONE, FIELD_BLOCK_TYPE_LABELS, type BookingRow, type FieldBlockRow } from '@/lib/domain/booking'
import { StatusBadge } from '@/components/ui/status-badge'
import { useResolvedFieldPrice } from './useFieldPricing'
import { fromInstant, formatInstant } from '@/lib/domain/time'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatNumberIsolated } from '@/lib/i18n/config'
import { FormattedDate } from '@/components/ui/formatted-date'
import { DatePickerButton } from '@/components/ui/date-picker-button'
import type { QuickBookingSlot } from './QuickBookingSheet'

// BOOKING CALENDAR UX PHASE (2026-08-23) -- full rewrite of the mobile
// primary view. Confirmed by audit: the prior version walked a fixed
// hourly grid over raw `bookings`/`blocks` props with its own ad-hoc
// hours-resolution helper (resolveHoursForDay in useFieldPricing.ts) --
// duplicated logic that never used the server-computed availability RPC
// built in the prior directive (get_field_available_starts), had no
// variable-duration support, and only ever offered 1-hour slots
// starting on the hour. This rewrite makes the field-first daily view
// the primary reception workflow (directive sections 3-4), sourced
// EXCLUSIVELY from get_field_available_starts -- no client-side
// availability computation of any kind. The booking engine itself
// (RPC contracts, overlap/hold/reschedule logic) is untouched; this is
// presentation only.
const DURATION_OPTIONS_MINUTES = [30, 60, 90, 120] as const
const DEFAULT_DURATION_MINUTES = 60

interface FieldWithBranch {
  id: string
  name: string
  branch_id: string
}

interface AvailableStart {
  startAt: string
  endAt: string
  isAvailable: boolean
}

async function fetchAvailableStarts(fieldId: string, date: string, durationMinutes: number): Promise<AvailableStart[]> {
  const { data, error } = await supabase.rpc('get_field_available_starts', {
    p_field_id: fieldId,
    p_date: date,
    p_duration_minutes: durationMinutes,
  })
  if (error) throw error
  return (data ?? []).map((row) => ({ startAt: row.start_at, endAt: row.end_at, isAvailable: row.is_available }))
}

export function BookingsMobileView({
  date,
  onDateChange,
  fields,
  bookings,
  blocks,
  clubTimezone,
  onSlotSelect,
  onBookingSelect,
}: {
  date: string
  onDateChange: (date: string) => void
  fields: FieldWithBranch[]
  bookings: BookingRow[]
  blocks: FieldBlockRow[]
  clubTimezone: string
  onSlotSelect: (slot: QuickBookingSlot) => void
  onBookingSelect: (booking: BookingRow) => void
}) {
  const { t, i18n } = useTranslation()
  const { locale } = useDirection()
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(fields[0]?.id ?? null)
  const [duration, setDuration] = useState<number>(DEFAULT_DURATION_MINUTES)
  const activeFieldId = selectedFieldId ?? fields[0]?.id ?? null
  const activeField = fields.find((f) => f.id === activeFieldId)

  // BOOKINGS/FIELDS ACCEPTANCE, D3: club-local "today"/"now" (same fix
  // as BookingsFieldDayView.tsx's desktop counterpart).
  const isToday = date === fromInstant(new Date(), clubTimezone).date
  const nowTime = fromInstant(new Date(), clubTimezone).time
  const { data: currentPrice } = useResolvedFieldPrice(activeFieldId, date, `${nowTime}:00`, `${nowTime}:00`)

  // Section 21-24: the ONLY source of truth for what's bookable today --
  // never a client-side walk of raw bookings/blocks. Section 24's exact
  // boundary example (a 09:00-10:30 booking makes 10:30 immediately
  // available) is guaranteed here by construction, not by client logic.
  const { data: availableStarts, isLoading: availabilityLoading } = useQuery({
    queryKey: ['bookings-mobile-available-starts', activeFieldId, date, duration],
    queryFn: () => fetchAvailableStarts(activeFieldId!, date, duration),
    enabled: !!activeFieldId,
  })

  function slotMinutesOf(iso: string) {
    const { time } = fromInstant(iso, clubTimezone)
    const [h = 0, m = 0] = time.split(':').map(Number)
    return h * 60 + m
  }

  // Booking/block cards still come from the day's real bookings (already
  // fetched by the parent for the whole day, once) -- rendered as
  // CONTINUOUS blocks spanning their real duration (section 8), not
  // fragmented per-hour rows. Sorted into one merged timeline with the
  // available-start buttons by their start time so the whole day reads
  // top-to-bottom in order.
  const fieldBookings = useMemo(
    () => bookings.filter((b) => b.fieldId === activeFieldId).sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [bookings, activeFieldId],
  )
  const fieldBlocks = useMemo(
    () => blocks.filter((b) => b.fieldId === activeFieldId).sort((a, b) => a.startAt.localeCompare(b.startAt)),
    [blocks, activeFieldId],
  )

  type TimelineItem =
    | { kind: 'booking'; startMin: number; booking: BookingRow }
    | { kind: 'block'; startMin: number; block: FieldBlockRow }
    | { kind: 'available'; startMin: number; start: AvailableStart }

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = []
    for (const b of fieldBookings) items.push({ kind: 'booking', startMin: slotMinutesOf(b.startAt), booking: b })
    for (const blk of fieldBlocks) items.push({ kind: 'block', startMin: slotMinutesOf(blk.startAt), block: blk })
    for (const s of availableStarts ?? []) {
      if (!s.isAvailable) continue
      items.push({ kind: 'available', startMin: slotMinutesOf(s.startAt), start: s })
    }
    return items.sort((a, b) => a.startMin - b.startMin)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldBookings, fieldBlocks, availableStarts, clubTimezone])

  // "Now" / "Next" summary -- the two things a receptionist needs
  // without scrolling (directive section 3-4's own framing).
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

  const hasAnyOpenSlot = (availableStarts ?? []).some((s) => s.isAvailable)
  const isClosedAllDay = !availabilityLoading && (availableStarts ?? []).length === 0 && fieldBookings.length === 0 && fieldBlocks.length === 0

  return (
    <div className="flex flex-col gap-3">
      {/* Date nav -- Previous/Today/Next are UNCHANGED (Today jumps to
          the club-local today, matching the desktop toolbar's own D3
          fix). FINAL BOOKINGS UX & LIFECYCLE GAP CLOSURE, Section A1:
          a calendar icon button is an ADDITION alongside them, opening
          the same DateCalendar used on desktop, so reaching a date
          weeks/months ahead on mobile doesn't require dozens of taps.
          Also fixes a real pre-existing bug found while touching this
          code: the date label used to call raw `toLocaleDateString`
          (the *browser's* local timezone), inconsistent with every
          other date computation in this file which correctly uses the
          club's real timezone via fromInstant/formatDate -- a
          receptionist viewing from outside the club's own timezone
          could have seen a mislabeled weekday/date here. */}
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" aria-label={t('bookings.page.previousDay')} onClick={() => shiftDate(-1)}><ChevronLeft className="size-4 rtl:rotate-180" /></Button>
        <Button variant="outline" size="sm" className="flex-1" onClick={() => onDateChange(fromInstant(new Date(), clubTimezone).date)}>
          {isToday ? t('common.today') : <FormattedDate value={new Date(`${date}T12:00:00`)} timeZone={clubTimezone} options={{ weekday: 'long', day: 'numeric', month: 'long' }} />}
        </Button>
        <Button variant="outline" size="icon" aria-label={t('bookings.page.nextDay')} onClick={() => shiftDate(1)}><ChevronRight className="size-4 rtl:rotate-180" /></Button>
        <DatePickerButton
          label=""
          value={date}
          onSelect={onDateChange}
          todayDate={fromInstant(new Date(), clubTimezone).date}
          className="flex size-9 items-center justify-center rounded-md border border-border bg-surface text-text-secondary transition-colors hover:bg-page-bg"
        />
      </div>

      {/* Field chips -- primary field-first selector (directive section 4) */}
      {fields.length > 1 && (
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
      )}

      {/* Now / Next cards */}
      {isToday && activeField && (
        <div className="grid grid-cols-2 gap-2">
          <div className={cn('rounded-lg border p-2.5 text-sm', nowBusy ? 'border-status-danger/30 bg-status-danger/5' : 'border-status-success/30 bg-status-success/5')}>
            <p className="text-xs text-text-secondary">{t('bookings.mobile.now')}</p>
            {nowBusy ? (
              <p className="font-medium text-status-danger">{nowBusy.customerName}</p>
            ) : (
              <p className="font-medium text-status-success">{t('bookings.mobile.availableNow')}</p>
            )}
          </div>
          <div className="rounded-lg border border-border p-2.5 text-sm">
            <p className="text-xs text-text-secondary">{t('bookings.mobile.next')}</p>
            {nextBooking ? (
              <p className="font-medium tabular-nums">
                {formatInstant(nextBooking.startAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)} — {nextBooking.customerName}
              </p>
            ) : (
              <p className="text-text-secondary">{t('bookings.mobile.noUpcomingBookings')}</p>
            )}
          </div>
        </div>
      )}

      {/* Current price banner */}
      {activeField && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-2.5 text-sm">
          <span className="text-text-secondary">{t('bookings.mobile.priceNow')}</span>
          {currentPrice != null ? (
            <span className="font-semibold tabular-nums">{t('bookings.mobile.pricePerHour', { price: formatNumberIsolated(Math.round(currentPrice), i18n.language.startsWith('ar') ? 'ar' : 'en') })}</span>
          ) : (
            <span className="text-status-danger">{t('bookings.mobile.noApprovedPrice')}</span>
          )}
        </div>
      )}

      {/* Duration picker -- section 7: the customer/staff picks a
          duration BEFORE seeing available starts, and the start list is
          re-computed server-side for that exact duration (never a
          client-side re-slice of a fixed grid). */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-text-secondary">{t('bookings.mobile.duration')}</label>
        <div className="flex gap-2">
          {DURATION_OPTIONS_MINUTES.map((mins) => (
            <button
              key={mins}
              type="button"
              onClick={() => setDuration(mins)}
              className={cn(
                'flex-1 rounded-lg border px-2 py-1.5 text-center text-sm font-medium transition',
                mins === duration ? 'border-accent bg-accent/10 text-accent-foreground' : 'border-border bg-surface text-text-secondary',
              )}
            >
              {t(`bookings.mobile.durationOptions.${mins}`)}
            </button>
          ))}
        </div>
      </div>

      {/* Merged timeline: booking cards (continuous, real duration) +
          available-start buttons (server-computed for the chosen
          duration), in chronological order. */}
      {availabilityLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/40" />
          ))}
        </div>
      ) : isClosedAllDay ? (
        // Section 22: closed day gets a real empty state, not an empty
        // grid of "closed" rows repeated for every hour.
        <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border py-10 text-center">
          <CalendarX2 className="size-8 text-text-secondary/50" />
          <p className="text-sm font-medium text-text-secondary">{t('bookings.mobile.fieldClosedToday')}</p>
          <p className="text-xs text-text-secondary/70">{t('bookings.mobile.fieldClosedTodayHint')}</p>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {timeline.map((item) => {
            if (item.kind === 'booking') {
              const b = item.booking
              const start = formatInstant(b.startAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)
              const end = formatInstant(b.endAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)
              return (
                <button
                  key={`b-${b.id}`}
                  onClick={() => onBookingSelect(b)}
                  className="flex items-center justify-between gap-2 p-3 text-start active:bg-muted/40"
                >
                  <div className="flex flex-col">
                    <span className="text-xs text-text-secondary tabular-nums"><bdi>{start} — {end}</bdi></span>
                    <span className="font-medium">{b.customerName}</span>
                  </div>
                  <StatusBadge tone={BOOKING_STATUS_TONE[b.status] ?? 'neutral'} label={t(`bookings.statusLabels.${b.status}`, { defaultValue: BOOKING_STATUS_LABELS[b.status] ?? b.status })} />
                </button>
              )
            }

            if (item.kind === 'block') {
              const blk = item.block
              const start = formatInstant(blk.startAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)
              const end = formatInstant(blk.endAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)
              return (
                <div key={`blk-${blk.id}`} className="flex items-center justify-between gap-2 bg-status-danger/5 p-3">
                  <div className="flex flex-col">
                    <span className="text-xs text-text-secondary tabular-nums"><bdi>{start} — {end}</bdi></span>
                    <span className="font-medium text-status-danger">{t(`bookings.fieldBlockTypeLabels.${blk.type}`, { defaultValue: FIELD_BLOCK_TYPE_LABELS[blk.type] ?? blk.type })}</span>
                  </div>
                  {blk.reason && <span className="text-xs text-status-danger/80">{blk.reason}</span>}
                </div>
              )
            }

            const s = item.start
            const start = formatInstant(s.startAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)
            return (
              <button
                key={`a-${s.startAt}`}
                data-testid={activeField ? `booking-slot-${activeField.id}-${fromInstant(s.startAt, clubTimezone).time}` : undefined}
                onClick={() => {
                  if (!activeField) return
                  const { time } = fromInstant(s.startAt, clubTimezone)
                  onSlotSelect({ fieldId: activeField.id, fieldName: activeField.name, branchId: activeField.branch_id, date, startTime: time })
                }}
                className="flex items-center gap-3 p-3 text-start active:bg-accent/10"
              >
                <span className="text-sm font-medium text-status-success tabular-nums"><bdi>{start}</bdi></span>
                <StatusBadge tone="success" label={t('bookings.mobile.available')} />
              </button>
            )
          })}
          {!hasAnyOpenSlot && timeline.every((i) => i.kind !== 'available') && timeline.length > 0 && (
            <p className="p-3 text-center text-xs text-text-secondary">{t('bookings.mobile.noMoreSlotsToday')}</p>
          )}
        </div>
      )}
    </div>
  )
}
