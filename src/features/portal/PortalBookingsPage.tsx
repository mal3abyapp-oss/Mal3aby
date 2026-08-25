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
  fields: { name: string; branch_id: string; branches: { name: string; timezone?: string } | null } | null
  clubs: { name_ar: string; timezone: string } | null
}

// Multi-Club E2E audit (2026-08-24): scoped per-club so a customer
// linked to more than one club doesn't see every club's bookings
// interleaved with no way to tell them apart.
//
// PORTAL CROSS-PERSONA AUTHORIZATION VULNERABILITY FIX (HIGH, 2026-08-25):
// the original `.eq('club_id', clubId)` filter alone was NOT sufficient
// -- bookings_select_club_staff RLS is ALSO club_id-scoped, so a staff
// member's Portal session (same club they're staff on) received every
// customer's bookings in that club, not just their own. Proven live via
// a real authenticated REST call. Now filters by `customer_id`, sourced
// exclusively from get_my_portal_customers() (an explicit,
// ownership-proven id, never re-derived from club membership or RLS
// alone) -- this is safe even though bookings_select_club_staff can
// still independently apply, because the WHERE clause itself no longer
// depends on RLS to narrow the result; customer_id already identifies
// exactly one owned row.
async function fetchMyBookings(customerId: string): Promise<PortalBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('id, start_at, end_at, status, total_price, invoice_id, club_id, fields(name, branch_id, branches(name)), clubs(name_ar, timezone)')
    .eq('customer_id', customerId)
    .order('start_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []) as unknown as PortalBooking[]
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
  const { activeCustomerId, isLoading: clubLoading } = usePortalClub()
  const { data: bookings = [], isLoading } = useQuery({
    queryKey: ['portal', 'my-bookings', activeCustomerId],
    queryFn: () => fetchMyBookings(activeCustomerId!),
    enabled: !!activeCustomerId,
  })

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
