import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { StatusBadge } from '@/components/ui/status-badge'
import { PageHeader } from '@/components/ui/page-header'
import { MoneyDisplay } from '@/components/ui/money-display'
import { BOOKING_STATUS_LABELS, BOOKING_STATUS_TONE } from '@/lib/domain/booking'
import { formatInstant } from '@/lib/domain/time'
import { fetchInvoicePaymentSummaries, type InvoicePaymentSummary } from '@/lib/domain/billing'
import { useDirection } from '@/app/providers/DirectionProvider'
import { usePortalClub } from '@/app/providers/PortalClubProvider'
import { QrCode, Receipt } from 'lucide-react'

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
  invoice_id: string | null
  club_id: string
  fields: { name: string; branch_id: string; branches: { name: string; timezone?: string } | null } | null
  clubs: { name_ar: string; timezone: string } | null
}

interface PortalBookingRpcRow {
  booking_id: string
  start_at: string
  end_at: string
  status: string
  total_price: number
  invoice_id: string | null
  club_id: string
  club_name_ar: string | null
  club_timezone: string | null
  field_name: string | null
  branch_id: string | null
  branch_name: string | null
}

// PORTAL PERSONA-SCOPED DATA CONTRACT HARDENING (2026-08-25), follow-up to
// the cross-persona authorization fix. A frontend `.eq('customer_id', ...)`
// filter is a UX scoping concern, not a security boundary on its own -- it
// depends on every current and future Portal code path applying it
// correctly, with bookings_select_club_staff RLS sitting immediately
// behind it as a silent fallback the moment that filter is ever dropped
// or bypassed. get_my_portal_bookings() makes the data contract itself
// persona-scoped: a SECURITY DEFINER RPC hard-coded to
// customers.user_id = auth.uid() in its own SQL body -- no parameter, no
// code path, and no way for a client request to reach outside the
// caller's own linked customer id(s), regardless of any staff permission
// the same auth.uid() might also hold. Live-verified against a real
// production staff+portal session: returns [] where the old
// club_id-filtered direct read still returned 5 real unrelated bookings.
async function fetchMyBookings(): Promise<PortalBooking[]> {
  const { data, error } = await supabase.rpc('get_my_portal_bookings')
  if (error) throw error
  return ((data ?? []) as PortalBookingRpcRow[]).map((r) => ({
    id: r.booking_id,
    start_at: r.start_at,
    end_at: r.end_at,
    status: r.status,
    total_price: Number(r.total_price),
    invoice_id: r.invoice_id,
    club_id: r.club_id,
    fields: r.field_name ? { name: r.field_name, branch_id: r.branch_id ?? '', branches: r.branch_name ? { name: r.branch_name } : null } : null,
    clubs: { name_ar: r.club_name_ar ?? '', timezone: r.club_timezone ?? 'UTC' },
  }))
}

// Master IA/UX audit (Customer Portal phase): confirmed the real gap --
// booking cards showed only total_price, not payment/outstanding status,
// so "did I pay for this?" (the single most common question a customer
// has about a booking) required a tab-switch to Payments and manual
// invoice matching. get_invoice_payment_summary() is security invoker
// (inherits the caller's own RLS on invoices) and is already safely
// called from PortalPaymentsPage -- same call, no new privilege surface.
async function fetchOutstandingByInvoice(invoiceIds: string[]): Promise<Map<string, InvoicePaymentSummary>> {
  if (invoiceIds.length === 0) return new Map()
  return fetchInvoicePaymentSummaries(invoiceIds)
}

export function PortalBookingsPage() {
  const { t } = useTranslation()
  const { activeClubId, activeCustomerId, isLoading: clubLoading } = usePortalClub()
  const { data: allBookings = [], isLoading } = useQuery({
    queryKey: ['portal', 'my-bookings'],
    queryFn: fetchMyBookings,
    enabled: !!activeCustomerId,
  })
  // get_my_portal_bookings() returns every linked club's bookings (it has
  // no club_id parameter -- see the RPC's own rationale) -- filtering to
  // the active club here is purely the same UX scoping the multi-club
  // audit already established, not a re-introduced security dependency.
  const bookings = allBookings.filter((b) => b.club_id === activeClubId)

  const invoiceIds = bookings.map((b) => b.invoice_id).filter((id): id is string => !!id)
  const { data: summaries } = useQuery({
    queryKey: ['portal', 'my-bookings-outstanding', invoiceIds],
    queryFn: () => fetchOutstandingByInvoice(invoiceIds),
    enabled: invoiceIds.length > 0,
  })

  const now = Date.now()
  const upcoming = bookings.filter((b) => new Date(b.start_at).getTime() >= now && b.status !== 'cancelled')
  const past = bookings.filter((b) => new Date(b.start_at).getTime() < now || b.status === 'cancelled')

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('portal.bookingsPage.title')} description={t('portal.bookingsPage.description')} />

      {(isLoading || clubLoading) && <p className="text-sm text-text-secondary">{t('portal.bookingsPage.loading')}</p>}

      {!isLoading && !clubLoading && bookings.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          {t('portal.bookingsPage.emptyTitle')}
        </p>
      )}

      {upcoming.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-text-secondary">{t('portal.bookingsPage.upcoming')}</h2>
          {upcoming.map((b) => (
            <BookingCard key={b.id} booking={b} outstanding={b.invoice_id ? summaries?.get(b.invoice_id) : undefined} />
          ))}
        </div>
      )}

      {past.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-text-secondary">{t('portal.bookingsPage.past')}</h2>
          {past.map((b) => (
            <BookingCard key={b.id} booking={b} outstanding={b.invoice_id ? summaries?.get(b.invoice_id) : undefined} />
          ))}
        </div>
      )}
    </div>
  )
}

// IA restructuring (Phase 10): "add cross-links between booking cards
// <-> QR <-> invoice via query params" -- confirmed in the audit as a
// missing connection: a customer looking at a booking here had no way
// to jump straight to its check-in QR or its invoice/payment status,
// only the tab-level nav (which loses the specific booking/invoice
// context). Query params keep both target pages usable standalone
// (direct nav still works with no param) while giving these links a
// concrete destination.
const CAN_SHOW_QR_STATUSES = new Set(['confirmed', 'pending_payment'])

function BookingCard({ booking, outstanding }: { booking: PortalBooking; outstanding?: InvoicePaymentSummary }) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const tz = booking.clubs?.timezone ?? 'UTC'
  const showQrLink = CAN_SHOW_QR_STATUSES.has(booking.status) && new Date(booking.start_at).getTime() >= Date.now()
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <p className="font-medium">{booking.fields?.name ?? '—'}</p>
          <p className="text-xs text-text-secondary">{booking.fields?.branches?.name}</p>
          {/* RTL sweep finding: formatInstant() returns a plain
              Intl.DateTimeFormat string with no bidi isolation (unlike
              formatMoney(), which explicitly adds FSI/PDI marks) -- 3
              separately-formatted Latin-digit segments concatenated
              with dash separators could visually reorder relative to
              each other. bdi-wrapping the whole composite range,
              same pattern as BookingDetailSheet's time-range display. */}
          <p className="text-xs text-text-secondary tabular-nums">
            <bdi>
              {formatInstant(booking.start_at, tz, { day: 'numeric', month: 'long' }, locale)}
              {' — '}
              {formatInstant(booking.start_at, tz, { hour: '2-digit', minute: '2-digit' }, locale)}
              {' - '}
              {formatInstant(booking.end_at, tz, { hour: '2-digit', minute: '2-digit' }, locale)}
            </bdi>
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <StatusBadge
            tone={BOOKING_STATUS_TONE[booking.status] ?? 'neutral'}
            label={t(`bookings.statusLabels.${booking.status}`, { defaultValue: BOOKING_STATUS_LABELS[booking.status] ?? booking.status })}
          />
          {/* RTL sweep finding: was the one remaining hand-rolled money
              display in the codebase, bypassing MoneyDisplay's bidi
              isolation. */}
          <MoneyDisplay amount={booking.total_price} size="sm" />
          {/* Master IA/UX audit (Customer Portal phase): "did I pay for
              this?" was previously answerable only via a tab-switch to
              Payments -- this chip answers it right on the card. Only
              shown for a real, positive outstanding balance; a fully
              paid booking shows no extra chip (booking status already
              reads "مؤكد"/confirmed, no need to also say "paid"). */}
          {outstanding && outstanding.outstanding > 0.01 && (
            <StatusBadge tone="danger" label={t('portal.bookingsPage.outstandingChip', { amount: outstanding.outstanding.toFixed(0) })} />
          )}
        </div>
      </div>
      {(showQrLink || booking.invoice_id) && (
        <div className="flex gap-3 border-t border-border pt-2 text-xs">
          {showQrLink && (
            <Link to={`/portal/qr?bookingId=${booking.id}`} className="flex items-center gap-1 font-medium text-accent-foreground hover:underline">
              <QrCode className="size-3.5" />
              {t('portal.bookingsPage.attendanceQrLink')}
            </Link>
          )}
          {booking.invoice_id && (
            <Link to={`/portal/payments?invoiceId=${booking.invoice_id}`} className="flex items-center gap-1 font-medium text-accent-foreground hover:underline">
              <Receipt className="size-3.5" />
              {t('portal.bookingsPage.invoicePaymentLink')}
            </Link>
          )}
        </div>
      )}
    </div>
  )
}
