import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { StatusBadge } from '@/components/ui/status-badge'
import { PageHeader } from '@/components/ui/page-header'
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONE } from '@/lib/domain/booking'
import { formatInstant } from '@/lib/domain/time'

// Gate 3 — first real screen of the Unified User Dashboard: My
// Bookings. Read-only (see bookings_self_service_select RLS policy) --
// cancellation/rescheduling stays staff-mediated for now, matching how
// this business actually operates today.
interface PortalBooking {
  id: string
  start_at: string
  end_at: string
  status: string
  total_price: number
  fields: { name: string; branch_id: string; branches: { name: string; timezone?: string } | null } | null
  clubs: { name_ar: string; timezone: string } | null
}

async function fetchMyBookings(): Promise<PortalBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, start_at, end_at, status, total_price, club_id, fields(name, branch_id, branches(name)), clubs(name_ar, timezone)')
    .order('start_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []) as unknown as PortalBooking[]
}

export function PortalBookingsPage() {
  const { data: bookings = [], isLoading } = useQuery({ queryKey: ['portal', 'my-bookings'], queryFn: fetchMyBookings })

  const now = Date.now()
  const upcoming = bookings.filter((b) => new Date(b.start_at).getTime() >= now && b.status !== 'cancelled')
  const past = bookings.filter((b) => new Date(b.start_at).getTime() < now || b.status === 'cancelled')

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="حجوزاتي" description="جميع حجوزاتك للملاعب" />

      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}

      {!isLoading && bookings.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          لا توجد حجوزات بعد.
        </p>
      )}

      {upcoming.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-text-secondary">القادمة</h2>
          {upcoming.map((b) => (
            <BookingCard key={b.id} booking={b} />
          ))}
        </div>
      )}

      {past.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-text-secondary">السابقة</h2>
          {past.map((b) => (
            <BookingCard key={b.id} booking={b} />
          ))}
        </div>
      )}
    </div>
  )
}

function BookingCard({ booking }: { booking: PortalBooking }) {
  const tz = booking.clubs?.timezone ?? 'UTC'
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3">
      <div className="flex flex-col gap-0.5">
        <p className="font-medium">{booking.fields?.name ?? '—'}</p>
        <p className="text-xs text-text-secondary">{booking.fields?.branches?.name}</p>
        <p className="text-xs text-text-secondary tabular-nums">
          {formatInstant(booking.start_at, tz, { day: 'numeric', month: 'long' })}
          {' — '}
          {formatInstant(booking.start_at, tz, { hour: '2-digit', minute: '2-digit' })}
          {' - '}
          {formatInstant(booking.end_at, tz, { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        <StatusBadge tone={BOOKING_STATUS_TONE[booking.status] ?? 'neutral'} label={BOOKING_STATUS_LABELS[booking.status] ?? booking.status} />
        <p className="text-xs font-medium tabular-nums text-text-secondary">{booking.total_price.toFixed(0)} ج.م</p>
      </div>
    </div>
  )
}
