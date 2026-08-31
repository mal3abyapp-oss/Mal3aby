import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useDirection } from '@/app/providers/DirectionProvider'
import { usePortalClub } from '@/app/providers/PortalClubProvider'

// Gate 3 — "My QR": shows a scannable QR for a selected upcoming
// booking. Reuses the same ensure_booking_qr() RPC the staff-side
// BookingDetailSheet already calls -- the QR content/security model is
// unchanged, this only exposes the existing secure QR to the booking's
// own customer directly instead of requiring them to ask staff to show it.
interface UpcomingBooking {
  id: string
  start_at: string
  club_id: string
  fields: { name: string } | null
}

interface PortalQrBookingRpcRow {
  booking_id: string
  start_at: string
  field_name: string | null
  club_id: string
}

// PORTAL PERSONA-SCOPED DATA CONTRACT HARDENING (2026-08-25), follow-up
// to the cross-persona authorization fix. ensure_booking_qr resolves
// club_id from the booking row itself, so the QR content was always
// correct -- the selector's club-scoping remains a UX concern. The real
// fix is the LISTING query itself: get_my_portal_qr_bookings() is a
// SECURITY DEFINER RPC hard-coded to customers.user_id = auth.uid() in
// its own SQL body -- the old `.eq('club_id', clubId)` direct-table
// filter alone was NOT sufficient (bookings_select_club_staff RLS is
// ALSO club_id-scoped; same class of bug proven live on
// PortalBookingsPage/PortalPaymentsPage). No client request can make
// this RPC return a booking outside the caller's own linked customer
// id(s), regardless of any staff permission on the same auth.uid().
async function fetchUpcomingBookings(): Promise<UpcomingBooking[]> {
  const { data, error } = await supabase.rpc('get_my_portal_qr_bookings')
  if (error) throw error
  return ((data ?? []) as PortalQrBookingRpcRow[]).map((r) => ({
    id: r.booking_id,
    start_at: r.start_at,
    club_id: r.club_id,
    fields: r.field_name ? { name: r.field_name } : null,
  }))
}

export function PortalQrPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { activeClubId, activeCustomerId, isLoading: clubLoading } = usePortalClub()
  const { data: allBookings = [], isLoading } = useQuery({
    queryKey: ['portal', 'qr-bookings'],
    queryFn: fetchUpcomingBookings,
    enabled: !!activeCustomerId,
  })
  const bookings = allBookings.filter((b) => b.club_id === activeClubId)
  const [selectedId, setSelectedId] = useState<string>('')
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrError, setQrError] = useState<string | null>(null)
  const [loadingQr, setLoadingQr] = useState(false)
  // IA restructuring (Phase 10): preselect from a ?bookingId= query
  // param so PortalBookingsPage's "رمز الحضور" cross-link lands
  // directly on this booking's QR instead of an empty selector the
  // customer has to search through again.
  const [searchParams] = useSearchParams()
  // Master IA/UX audit (Customer Portal phase): confirmed a real gap --
  // when ?bookingId= doesn't resolve (the booking already happened, was
  // cancelled since the link was shared, or the id is simply wrong),
  // this silently fell through to the plain empty selector with zero
  // explanation, leaving the customer to wonder why their link "didn't
  // work". Only shown once bookings have actually loaded, so it can't
  // fire during the normal brief loading window before the real match
  // succeeds.
  const [preselectNotFound, setPreselectNotFound] = useState(false)
  // Multi-Club E2E audit (2026-08-24): a ?bookingId= deep link (from
  // email/WhatsApp/the bookings-page cross-link) can legitimately belong
  // to a DIFFERENT linked club than the one currently active -- e.g. the
  // customer has Club A selected but opens a Club B booking's QR link.
  // Before club-scoping this query, that booking simply appeared in the
  // merged list; now it correctly won't appear under the wrong club, so
  // "not found" needs to be disambiguated from "found, but in another of
  // your clubs" -- the latter gets an explicit one-click switch instead
  // of a dead-end error, per this audit's own deep-link requirement.
  const [wrongClubBookingId, setWrongClubBookingId] = useState<string | null>(null)
  const { customerMemberships, setActiveClubId } = usePortalClub()
  // QA acceptance fix (2026-08-31): `bookings` is `allBookings.filter(...)`
  // recomputed fresh on every render (a new array reference each time),
  // and it was previously in this effect's own dependency array. Since
  // handleSelect's setState calls (setSelectedId/setLoadingQr/
  // setQrDataUrl) each trigger a re-render, that re-render always
  // produced a new `bookings` reference, which re-ran this effect, which
  // called handleSelect again -- an unbounded render loop with no
  // termination condition. Live-reproduced: opening a booking's QR via
  // the ?bookingId= deep link from PortalBookingsPage fired
  // ensure_booking_qr() ~70 times/second, permanently stuck the page on
  // its "generating..." state (a later loop iteration's setLoadingQr(true)
  // always raced ahead of any single iteration's setLoadingQr(false)),
  // and minted a fresh real qr_credentials row on every single firing --
  // over 6,700 rows for one booking in a few seconds of an open tab, a
  // genuine unbounded-write/resource-exhaustion bug, not merely a UI
  // glitch. Fix: track which bookingId this effect has already
  // auto-selected and only act again when the deep link itself changes
  // (or the resolved match for it changes), never merely because
  // `bookings`/`customerMemberships` were recomputed with new but
  // equivalent content.
  const autoSelectedBookingIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (isLoading) return
    const bookingId = searchParams.get('bookingId')
    if (!bookingId) return
    if (autoSelectedBookingIdRef.current === bookingId) return
    if (bookings.some((b) => b.id === bookingId)) {
      autoSelectedBookingIdRef.current = bookingId
      setWrongClubBookingId(null)
      void handleSelect(bookingId)
      return
    }
    if (customerMemberships.length > 1) {
      // Check whether this booking belongs to one of the OTHER clubs
      // this customer is linked to, rather than assuming it's simply
      // invalid -- RLS still guarantees this lookup can only ever
      // resolve to a club this same auth.uid() actually has a linked
      // customer record in.
      autoSelectedBookingIdRef.current = bookingId
      void supabase.from('bookings').select('club_id').eq('id', bookingId).maybeSingle().then(({ data }) => {
        if (data?.club_id && customerMemberships.some((m) => m.clubId === data.club_id)) {
          setWrongClubBookingId(bookingId)
        } else {
          setPreselectNotFound(true)
        }
      })
    } else {
      autoSelectedBookingIdRef.current = bookingId
      setPreselectNotFound(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookings, isLoading, searchParams, customerMemberships])

  async function handleSelect(id: string) {
    setSelectedId(id)
    setQrDataUrl(null)
    setQrError(null)
    setLoadingQr(true)
    const { data, error } = await supabase.rpc('ensure_booking_qr', { p_booking_id: id })
    setLoadingQr(false)
    if (error || !data) {
      setQrError(t('portal.qrPage.generateError'))
      return
    }
    const url = await QRCode.toDataURL(data as string, { width: 240, margin: 1 })
    setQrDataUrl(url)
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('portal.qrPage.title')} description={t('portal.qrPage.description')} />

      {(isLoading || clubLoading) && <p className="text-sm text-text-secondary">{t('portal.qrPage.loading')}</p>}

      {!isLoading && preselectNotFound && (
        <p role="alert" className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-sm text-status-warning">
          {t('portal.qrPage.bookingNotFound')}
        </p>
      )}

      {!isLoading && wrongClubBookingId && (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-sm text-status-warning">
          <p>{t('portal.qrPage.wrongClubBooking')}</p>
          <button
            type="button"
            className="self-start font-medium underline"
            onClick={async () => {
              const { data } = await supabase.from('bookings').select('club_id').eq('id', wrongClubBookingId).maybeSingle()
              if (data?.club_id) setActiveClubId(data.club_id)
              setWrongClubBookingId(null)
            }}
          >
            {t('portal.qrPage.switchClubAction')}
          </button>
        </div>
      )}

      {!isLoading && bookings.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          {t('portal.qrPage.emptyTitle')}
        </p>
      )}

      {bookings.length > 0 && (
        <Select value={selectedId} onValueChange={handleSelect}>
          <SelectTrigger>
            <SelectValue placeholder={t('portal.qrPage.choosePlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            {bookings.map((b) => (
              <SelectItem key={b.id} value={b.id}>
                {b.fields?.name} — {new Date(b.start_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG', { day: 'numeric', month: 'long' })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {loadingQr && <p className="text-sm text-text-secondary">{t('portal.qrPage.generating')}</p>}
      {qrError && <p className="text-sm text-status-danger">{qrError}</p>}

      {qrDataUrl && (
        <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-6">
          <img src={qrDataUrl} alt={t('portal.qrPage.qrAlt')} className="size-60" />
          <p className="text-xs text-text-secondary">{t('portal.qrPage.showAtClubHint')}</p>
        </div>
      )}
    </div>
  )
}
