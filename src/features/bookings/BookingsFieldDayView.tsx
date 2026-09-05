import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { CalendarX2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONE, FIELD_BLOCK_TYPE_LABELS, type BookingRow, type FieldBlockRow } from '@/lib/domain/booking'
import { StatusBadge } from '@/components/ui/status-badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useResolvedFieldPrice } from './useFieldPricing'
import { fromInstant, formatInstant } from '@/lib/domain/time'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatNumberIsolated } from '@/lib/i18n/config'
import type { QuickBookingSlot } from './QuickBookingSheet'

// BOOKING CALENDAR UX PHASE (2026-08-23) -- desktop primary workflow:
// Date -> Branch -> Field -> that field's daily availability (directive
// sections 3-4, 25-27). This is the desktop analog of
// BookingsMobileView.tsx -- same server-computed availability engine
// (get_field_available_starts), same continuous-booking-card rendering,
// but a richer two-column layout that uses desktop's extra width
// (directive section 27: "richer timeline, same engine"). The prior
// desktop-only surface was the dense multi-field spreadsheet grid,
// which BookingsPage.tsx now keeps as a secondary "All Fields" view
// (toggle), not the default landing experience.
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

export function BookingsFieldDayView({
  date,
  fields,
  selectedFieldId,
  onFieldChange,
  bookings,
  blocks,
  clubTimezone,
  onSlotSelect,
  onBookingSelect,
}: {
  date: string
  fields: FieldWithBranch[]
  selectedFieldId: string | null
  onFieldChange: (fieldId: string) => void
  bookings: BookingRow[]
  blocks: FieldBlockRow[]
  clubTimezone: string
  onSlotSelect: (slot: QuickBookingSlot) => void
  onBookingSelect: (booking: BookingRow) => void
}) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const [duration, setDuration] = useState<number>(DEFAULT_DURATION_MINUTES)
  const activeFieldId = selectedFieldId ?? fields[0]?.id ?? null
  const activeField = fields.find((f) => f.id === activeFieldId)

  // BOOKINGS/FIELDS ACCEPTANCE, D3: club-local "today"/"now", not the
  // browser's own UTC date / local wall-clock -- clubTimezone is
  // already a required prop here, so there's no reason to use the
  // browser's timezone for either check.
  const isToday = date === fromInstant(new Date(), clubTimezone).date
  const nowTime = fromInstant(new Date(), clubTimezone).time
  const { data: currentPrice } = useResolvedFieldPrice(activeFieldId, date, `${nowTime}:00`, `${nowTime}:00`)

  const { data: availableStarts, isLoading: availabilityLoading } = useQuery({
    queryKey: ['bookings-field-day-available-starts', activeFieldId, date, duration],
    queryFn: () => fetchAvailableStarts(activeFieldId!, date, duration),
    enabled: !!activeFieldId,
  })

  function slotMinutesOf(iso: string) {
    const { time } = fromInstant(iso, clubTimezone)
    const [h = 0, m = 0] = time.split(':').map(Number)
    return h * 60 + m
  }

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

  const nowMin = useMemo(() => {
    const { time } = fromInstant(new Date(), clubTimezone)
    const [h = 0, m = 0] = time.split(':').map(Number)
    return h * 60 + m
  }, [clubTimezone])
  const nowBusy = isToday && fieldBookings.find((b) => nowMin >= slotMinutesOf(b.startAt) && nowMin < slotMinutesOf(b.endAt))
  const nextBooking = isToday ? fieldBookings.find((b) => slotMinutesOf(b.startAt) > nowMin) : fieldBookings[0]

  const isClosedAllDay = !availabilityLoading && (availableStarts ?? []).length === 0 && fieldBookings.length === 0 && fieldBlocks.length === 0

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      {/* Sidebar: field selector + status summary + duration picker --
          desktop's extra width lets these live beside the timeline
          instead of stacked above it (section 27's "richer timeline"). */}
      <div className="flex w-full flex-col gap-3 lg:w-72 lg:shrink-0">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">{t('bookings.page.field')}</label>
          <Select value={activeFieldId ?? undefined} onValueChange={onFieldChange}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {fields.map((f) => (
                <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

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

        {activeField && (
          <div className="rounded-lg border border-accent/30 bg-accent/5 p-2.5 text-sm">
            <span className="text-text-secondary">{t('bookings.mobile.priceNow')}</span>
            {currentPrice != null ? (
              <span className="font-semibold tabular-nums">{t('bookings.mobile.pricePerHour', { price: formatNumberIsolated(Math.round(currentPrice), locale) })}</span>
            ) : (
              <span className="text-status-danger">{t('bookings.mobile.noApprovedPrice')}</span>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-text-secondary">{t('bookings.mobile.duration')}</label>
          <div className="grid grid-cols-2 gap-2">
            {DURATION_OPTIONS_MINUTES.map((mins) => (
              <button
                key={mins}
                type="button"
                onClick={() => setDuration(mins)}
                className={cn(
                  'rounded-lg border px-2 py-1.5 text-center text-sm font-medium transition',
                  mins === duration ? 'border-accent bg-accent/10 text-accent-foreground' : 'border-border bg-surface text-text-secondary hover:border-accent/50',
                )}
              >
                {t(`bookings.mobile.durationOptions.${mins}`)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div className="min-w-0 flex-1">
        {availabilityLoading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-12 w-full rounded-lg" />
            ))}
          </div>
        ) : isClosedAllDay ? (
          <EmptyState
            icon={CalendarX2}
            title={t('bookings.mobile.fieldClosedToday')}
            description={t('bookings.mobile.fieldClosedTodayHint')}
            className="rounded-lg border border-dashed border-border py-16"
          />
        ) : (
          <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
            {timeline.map((item) => {
              if (item.kind === 'booking') {
                const b = item.booking
                const start = formatInstant(b.startAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)
                const end = formatInstant(b.endAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)
                return (
                  <button
                    key={`b-${b.id}`}
                    onClick={() => onBookingSelect(b)}
                    className="col-span-2 flex flex-col items-start gap-1 rounded-lg border border-border bg-surface p-3 text-start transition hover:border-accent/50 xl:col-span-1"
                  >
                    <span className="text-xs text-text-secondary tabular-nums"><bdi>{start} — {end}</bdi></span>
                    <span className="font-medium">{b.customerName}</span>
                    <StatusBadge tone={BOOKING_STATUS_TONE[b.status] ?? 'neutral'} label={t(`bookings.statusLabels.${b.status}`, { defaultValue: BOOKING_STATUS_LABELS[b.status] ?? b.status })} />
                  </button>
                )
              }

              if (item.kind === 'block') {
                const blk = item.block
                const start = formatInstant(blk.startAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)
                const end = formatInstant(blk.endAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)
                return (
                  <div
                    key={`blk-${blk.id}`}
                    className="col-span-2 flex flex-col items-start gap-1 rounded-lg border border-dashed border-status-danger/40 bg-status-danger/5 p-3 xl:col-span-1"
                  >
                    <span className="text-xs text-text-secondary tabular-nums"><bdi>{start} — {end}</bdi></span>
                    <span className="font-medium text-status-danger">{t(`bookings.fieldBlockTypeLabels.${blk.type}`, { defaultValue: FIELD_BLOCK_TYPE_LABELS[blk.type] ?? blk.type })}</span>
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
                  className="flex flex-col items-start gap-1 rounded-lg border border-status-success/30 bg-status-success/5 p-3 text-start transition hover:border-status-success/60"
                >
                  <span className="text-sm font-medium tabular-nums text-status-success"><bdi>{start}</bdi></span>
                  <StatusBadge tone="success" label={t('bookings.mobile.available')} />
                </button>
              )
            })}
            {timeline.every((i) => i.kind !== 'available') && timeline.length > 0 && (
              <p className="col-span-2 p-3 text-center text-sm text-text-secondary xl:col-span-3">{t('bookings.mobile.noMoreSlotsToday')}</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
