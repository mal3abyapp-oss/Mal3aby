import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { addHoursToTime, rentalSpaceTypeLabel } from '@/lib/domain/rental'
import { fetchMyBookingRequests, fetchPortalBookableSpaces } from './portalRentals'

// Customer-side online hall booking: pick a hall the club opened for
// online requests, a date, start time and hours; the day's booked slots
// are shown so the customer can pick a free one. The request waits for
// staff approval (which creates the booking and its invoice); the
// customer follows its status here and can cancel while it is pending.

const STATUS_TONE = { pending: 'warning', approved: 'success', rejected: 'danger', cancelled: 'neutral' } as const

function toMinutes(time: string): number {
  const [h, m] = time.slice(0, 5).split(':').map(Number) as [number, number]
  return h * 60 + m
}

export function PortalHallBooking({ clubId }: { clubId: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { data: spaces = [] } = useQuery({
    queryKey: ['portal', 'bookable-spaces', clubId],
    queryFn: () => fetchPortalBookableSpaces(clubId),
    retry: false,
  })
  const { data: requests = [], refetch } = useQuery({
    queryKey: ['portal', 'my-booking-requests'],
    queryFn: fetchMyBookingRequests,
    retry: false,
  })
  const clubRequests = requests.filter((r) => r.club_id === clubId)

  const [spaceId, setSpaceId] = useState('')
  const [date, setDate] = useState('')
  const [startTime, setStartTime] = useState('18:00')
  const [hours, setHours] = useState('4')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const space = spaces.find((s) => s.id === spaceId) ?? spaces[0] ?? null
  const endTime = addHoursToTime(startTime, Number(hours))

  const busyThatDay = useMemo(() => {
    if (!space || !date) return []
    return space.busy.filter((b) => b.date <= date && b.end_date >= date)
  }, [space, date])
  const clash = !!endTime && busyThatDay.some((b) =>
    !b.start_time || !b.end_time || b.date !== b.end_date
      || (toMinutes(startTime) < toMinutes(b.end_time) && toMinutes(b.start_time) < toMinutes(endTime)))

  const submit = useMutation({
    mutationFn: async () => {
      if (!space) return
      const { error: rpcError } = await supabase.rpc('request_rental_booking', {
        p_space_id: space.id,
        p_booking_date: date,
        p_start_time: startTime,
        p_hours: Number(hours),
        p_notes: notes.trim() || undefined,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: () => {
      setSent(true); setError(null); setNotes('')
      void refetch()
      void queryClient.invalidateQueries({ queryKey: ['portal', 'bookable-spaces'] })
    },
    onError: (err) => setError(translateSupabaseError(err, t('portal.rentals.booking.error'))),
  })

  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const { error: rpcError } = await supabase.rpc('cancel_my_rental_booking_request', { p_request_id: id })
      if (rpcError) throw rpcError
    },
    onSuccess: () => void refetch(),
    onError: (err) => setError(translateSupabaseError(err, t('portal.rentals.booking.error'))),
  })

  if (spaces.length === 0 && clubRequests.length === 0) return null

  return (
    <div className="mb-5 flex flex-col gap-3">
      {space && (
        <div className="rounded-xl border border-accent/40 bg-surface p-4">
          <p className="mb-1 font-semibold">{t('portal.rentals.booking.title')}</p>
          <p className="mb-3 text-xs text-text-secondary">{t('portal.rentals.booking.hint')}</p>
          <div className="flex flex-col gap-2">
            {spaces.length > 1 && (
              <Select value={space.id} onValueChange={(v) => { setSpaceId(v); setSent(false) }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {spaces.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <p className="text-sm">
              {space.name} · {rentalSpaceTypeLabel(t, space.space_type, space.custom_type_label)}
              {space.capacity ? ` · ${t('portal.rentals.booking.capacity', { count: space.capacity })}` : ''}
              {space.hourly_rate != null && <> · <MoneyDisplay amount={Number(space.hourly_rate)} size="sm" /> / {t('portal.rentals.booking.hour')}</>}
            </p>
            <div className="grid grid-cols-3 gap-2">
              <label className="flex flex-col gap-1 text-xs text-text-secondary">
                {t('portal.rentals.booking.date')}
                <Input type="date" value={date} min={new Date().toISOString().slice(0, 10)} onChange={(e) => { setDate(e.target.value); setSent(false) }} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-text-secondary">
                {t('portal.rentals.booking.from')}
                <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
              </label>
              <label className="flex flex-col gap-1 text-xs text-text-secondary">
                {t('portal.rentals.booking.hours')}
                <Input type="number" min={1} max={24} value={hours} onChange={(e) => setHours(e.target.value)} />
              </label>
            </div>
            {date && (
              <p className="text-xs text-text-secondary">
                {busyThatDay.length === 0
                  ? t('portal.rentals.booking.dayFree')
                  : t('portal.rentals.booking.dayBusy', {
                      slots: busyThatDay.map((b) => (b.start_time && b.date === b.end_date ? `${b.start_time.slice(0, 5)}–${b.end_time?.slice(0, 5)}` : t('portal.rentals.booking.allDay'))).join('، '),
                    })}
              </p>
            )}
            {!endTime && <p className="text-xs text-status-danger">{t('rentals.contracts.errors.pastMidnight')}</p>}
            {clash && <p className="text-xs text-status-danger">{t('portal.rentals.booking.clash')}</p>}
            <Input placeholder={t('portal.rentals.booking.notes')} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
            {space.hourly_rate != null && endTime && (
              <p className="text-sm">
                {t('portal.rentals.booking.estimate')}: <MoneyDisplay amount={Number(space.hourly_rate) * Number(hours || 0)} size="sm" />
              </p>
            )}
            {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
            {sent && <p className="text-sm text-status-success">{t('portal.rentals.booking.sent')}</p>}
            <Button disabled={!date || !endTime || clash || submit.isPending} onClick={() => submit.mutate()}>
              {t('portal.rentals.booking.submit')}
            </Button>
          </div>
        </div>
      )}

      {clubRequests.length > 0 && (
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="mb-2 font-medium">{t('portal.rentals.booking.myRequests')}</p>
          <ul className="flex flex-col divide-y divide-border-subtle text-sm">
            {clubRequests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="tabular-nums">
                  {r.space_name} · <bdi>{r.booking_date} {r.start_time.slice(0, 5)}–{addHoursToTime(r.start_time.slice(0, 5), r.hours) ?? '24:00'}</bdi>
                  {r.decision_note && <span className="block text-xs text-text-secondary">{r.decision_note}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <StatusBadge tone={STATUS_TONE[r.status]} label={t(`rentals.requests.status.${r.status}`)} />
                  {r.status === 'pending' && (
                    <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)}>
                      {t('portal.rentals.booking.cancel')}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
