import { useEffect, useState, type ReactNode } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { FormattedDate } from '@/components/ui/formatted-date'
import { FormattedCurrency } from '@/components/ui/formatted-currency'
import { LanguageSwitcher } from '@/components/ui/language-switcher'
import { StatusBadge } from '@/components/ui/status-badge'
import { QrCodeViewer } from '@/components/ui/qr-code-viewer'
import { CheckCircle2, XCircle, Clock, Ban } from 'lucide-react'

/**
 * SecureBookingPage -- the Secure Booking Page (directive Sections
 * 28-32). Supersedes the old BookingQrVerifyPage (attendance-QR
 * status card only) as the destination for the WhatsApp booking
 * message's leading link (bookingQrUrl(), unchanged: /qr/:token) --
 * this is now the PRIMARY customer-facing UX for a booking, not the
 * QR image attachment. Directive rule: "WhatsApp QR image must NOT be
 * the Primary UX... the QR should appear inside the Secure Booking
 * Page" -- this page is where the attendance QR now lives, rendered
 * from the token already in the URL (no extra RPC round-trip needed
 * to mint/fetch it, unlike PortalQrPage's authenticated flow).
 *
 * Public (no login) -- same standalone-route pattern as the page it
 * replaces, reachable via verify_booking_qr_public() (anon-granted,
 * opaque-token-only, never a raw booking_id -- directive rule 30).
 * Never mutates anything, never writes qr_scan_events.
 *
 * Bilingual from the start (directive Part V intent, applied here
 * rather than left as new debt): DirectionProvider is mounted
 * globally (App.tsx, above the router), so this standalone page is
 * already inside it and can use useTranslation()/useDirection()
 * directly. An anonymous visitor has no prior localStorage locale on
 * a fresh device/browser, so a one-time `?lang=ar|en` query param
 * (the same WhatsApp link can carry it) seeds the locale on mount --
 * after that, DirectionProvider's own persistence takes over exactly
 * like every other page. Money/date formatting uses formatCurrency()/
 * formatDate() from lib/i18n/config.ts (which take an explicit locale
 * param) rather than formatMoney()/formatInstant() from lib/domain,
 * which are hardcoded to the 'ar-EG' locale regardless of language --
 * a real bug tracked separately for the broader localization sweep,
 * not reproduced in this new page.
 *
 * Production audit finding H-1 (RTL-bidi gap): the formatDate()/
 * formatCurrency() calls below used to render their plain-string
 * output directly, and this file's own InfoRow only isolated it in
 * <bdi> when an explicit `bdi` prop was passed (inconsistently -- the
 * date row had none, the time row and money rows were a mix). Migrated
 * to <FormattedDate>/<FormattedCurrency> (src/components/ui/
 * formatted-date.tsx, formatted-currency.tsx), which always wrap their
 * output in <bdi>, so isolation is no longer a per-call-site opt-in.
 */

type VerifyResult = 'valid' | 'expired' | 'cancelled' | 'already_used' | 'invalid'

interface SecureBookingData {
  result: VerifyResult
  bookingRef: string | null
  fieldName: string | null
  sport: string | null
  startAt: string | null
  endAt: string | null
  timezone: string | null
  bookingStatus: string | null
  clubName: string | null
  branchName: string | null
  customerName: string | null
  total: number | null
  paid: number | null
  outstanding: number | null
  paymentStatus: string | null
  invoiceTokenAvailable: boolean
}

async function fetchSecureBooking(token: string): Promise<SecureBookingData> {
  const { data, error } = await supabase.rpc('verify_booking_qr_public', { p_token: token })
  if (error) throw error
  const row = data?.[0]
  return {
    result: (row?.result as VerifyResult) ?? 'invalid',
    bookingRef: row?.booking_ref ?? null,
    fieldName: row?.field_name ?? null,
    sport: row?.sport ?? null,
    startAt: row?.start_at ?? null,
    endAt: row?.end_at ?? null,
    timezone: row?.timezone ?? null,
    bookingStatus: row?.booking_status ?? null,
    clubName: row?.club_name ?? null,
    branchName: row?.branch_name ?? null,
    customerName: row?.customer_name ?? null,
    total: row?.total !== null && row?.total !== undefined ? Number(row.total) : null,
    paid: row?.paid !== null && row?.paid !== undefined ? Number(row.paid) : null,
    outstanding: row?.outstanding !== null && row?.outstanding !== undefined ? Number(row.outstanding) : null,
    paymentStatus: row?.payment_status ?? null,
    invoiceTokenAvailable: row?.invoice_token_available ?? false,
  }
}

const STATE_ICON: Record<VerifyResult, typeof CheckCircle2> = {
  valid: CheckCircle2,
  expired: Clock,
  cancelled: Ban,
  already_used: CheckCircle2,
  invalid: XCircle,
}

const STATE_TONE: Record<VerifyResult, string> = {
  valid: 'text-status-success',
  expired: 'text-status-warning',
  cancelled: 'text-status-danger',
  already_used: 'text-text-secondary',
  invalid: 'text-status-danger',
}

const BOOKING_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  pending_payment: 'warning',
  confirmed: 'success',
  checked_in: 'success',
  completed: 'neutral',
  cancelled: 'danger',
  no_show: 'danger',
}

const PAYMENT_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  draft: 'neutral',
  void: 'neutral',
  unpaid: 'danger',
  partially_paid: 'warning',
  paid: 'success',
  partially_refunded: 'warning',
  refunded: 'neutral',
}

export function SecureBookingPage() {
  const { token } = useParams<{ token: string }>()
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const { locale, direction, setLocale } = useDirection()
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrRevealed, setQrRevealed] = useState(false)

  // Real bug found 2026-08-23 (same investigation as the QR-payload
  // fix below): "View Invoice" used to build /verify/${token} with
  // this page's own BOOKING QR token -- but /verify/:token needs an
  // INVOICE verification token, a different token from a different
  // table. verify_booking_qr_public() can only ever report a boolean
  // (an invoice token already exists) since the raw invoice token is
  // never persisted/recoverable (hash-only storage). Fixed via a new,
  // narrowly-scoped RPC: possessing a currently-valid booking QR token
  // is treated as sufficient proof of legitimate access to mint a
  // fresh invoice link for that same booking's invoice (mirrors this
  // page's own no-login trust model) -- minting is safe to repeat
  // (does not revoke the invoice link already sent via WhatsApp, per
  // the fix in migration 20260822060000).
  const invoiceLinkMutation = useMutation({
    mutationFn: async () => {
      if (!token) throw new Error('no token')
      const { data, error } = await supabase.rpc('mint_invoice_token_for_booking_qr', { p_booking_qr_token: token })
      if (error) throw error
      return data as string
    },
    onSuccess: (invoiceToken) => {
      window.location.assign(`/verify/${invoiceToken}?lang=${locale}`)
    },
  })

  // Seed the locale from a one-time ?lang= param on first mount only --
  // never fights a visitor who then uses the in-page language switcher,
  // and never overrides a real returning-visitor preference already in
  // localStorage beyond this first read (DirectionProvider's own
  // persistence takes over after this).
  useEffect(() => {
    const langParam = searchParams.get('lang')
    if (langParam === 'ar' || langParam === 'en') {
      if (langParam !== locale) setLocale(langParam)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { data, isLoading, isError } = useQuery({
    queryKey: ['secure-booking', token],
    queryFn: () => fetchSecureBooking(token!),
    enabled: !!token,
    retry: false,
  })

  const result: VerifyResult = isError || !data ? 'invalid' : data.result

  const tz = data?.timezone ?? 'Africa/Cairo'

  // WHATSAPP BUSINESS MESSAGING FINAL HARDENING (2026-08-23) -- real
  // root cause found via the directive's mandated "test the existing
  // button first" step: this page used to encode a full URL
  // (`${origin}/qr/${token}`) into the QR image, but the real
  // production Staff Scanner (ScanPage.tsx) passes whatever raw string
  // it decodes straight to qr_validate()/qr_confirm_checkin() with NO
  // URL parsing -- and those RPCs hash `p_token` exactly as given
  // (`encode(digest(p_token, 'sha256'), 'hex')`) to look it up against
  // qr_credentials.token_hash, which was computed from the BARE raw
  // token at mint time. A URL's hash can never match the bare token's
  // hash, so a QR encoding a URL is structurally unscannable -- this
  // was proven, not assumed: `ensure_booking_qr()` (the existing
  // "عرض رمز QR لتسجيل الحضور" button in BookingDetailSheet.tsx, which
  // already correctly encodes the bare token via
  // `QRCode.toDataURL(rawToken, ...)`) round-tripped through
  // qr_validate() successfully against a real confirmed production
  // booking; the URL-encoding this page used would not have.
  //
  // One canonical QR credential contract, one scanner contract (per
  // this directive's explicit "One QR Source of Truth" requirement) --
  // this page now encodes the SAME bare token the existing button
  // already used successfully in production, rather than inventing a
  // second, incompatible payload shape. The page's own visible link
  // text/URL bar still shows the full `/qr/:token` address (that part
  // was never the problem -- only the QR image's own encoded payload
  // was wrong).
  //
  // MAL3ABY QR DISCOVERY + UNIFICATION (2026-08-23), directive Sections
  // 14/15: this used to render the QR the instant the page loaded (the
  // effect below ran unconditionally on `result === 'valid'`). That
  // directly violates "QR لا يظهر مباشرة... يظهر بعد الضغط على الزر
  // فقط" -- the golden reference (BookingDetailSheet.tsx's "عرض رمز QR
  // لتسجيل الحضور") only ever shows its QR after an explicit click, and
  // this page now matches that exactly: `qrRevealed` starts false, the
  // encode only runs once the visitor taps the button below, mirroring
  // the same lazy-reveal UX the internal screen has always had.
  useEffect(() => {
    if (result !== 'valid' || !token || !qrRevealed) {
      setQrDataUrl(null)
      return
    }
    let cancelled = false
    void QRCode.toDataURL(token, { width: 480, margin: 1 }).then((url) => {
      if (!cancelled) setQrDataUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [result, token, qrRevealed])

  // Reset the reveal state whenever we land on a genuinely different
  // token (a fresh navigation to another booking's secure link) so a
  // previous booking's QR never lingers visible for the new one.
  useEffect(() => {
    setQrRevealed(false)
  }, [token])

  const Icon = STATE_ICON[result]
  const tone = STATE_TONE[result]

  return (
    <div dir={direction} className="flex min-h-screen items-center justify-center bg-page-bg p-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 text-center shadow">
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-medium text-text-secondary">{t('secureBooking.title')}</p>
          <LanguageSwitcher />
        </div>

        {isLoading && <p className="text-sm text-text-secondary">{t('secureBooking.loading')}</p>}

        {!isLoading && result !== 'valid' && (
          <div className="flex flex-col items-center gap-3">
            <Icon className={`size-12 ${tone}`} />
            <p className={`font-medium ${tone}`}>{t(`secureBooking.states.${stateKey(result)}Title`)}</p>
            <p className="text-sm text-text-secondary">{t(`secureBooking.states.${stateKey(result)}Message`)}</p>
            {data?.bookingRef && (
              <p className="text-xs text-text-secondary">
                {t('secureBooking.bookingRef')}: <bdi>{data.bookingRef}</bdi>
              </p>
            )}
          </div>
        )}

        {!isLoading && result === 'valid' && data && (
          <div className="flex flex-col items-center gap-4">
            <div className="flex flex-col items-center gap-2">
              <CheckCircle2 className="size-10 text-status-success" />
              {data.clubName && <p className="text-lg font-semibold">{data.clubName}</p>}
            </div>

            <div className="w-full rounded-md border border-border p-4 text-start text-sm">
              {data.branchName && <InfoRow label={t('secureBooking.branch')} value={data.branchName} />}
              <InfoRow label={t('secureBooking.field')} value={data.fieldName ?? '—'} />
              {data.sport && <InfoRow label={t('secureBooking.sport')} value={data.sport} />}
              {data.startAt && (
                <InfoRow
                  label={t('secureBooking.date')}
                  value={<FormattedDate value={data.startAt} timeZone={tz} options={{ day: 'numeric', month: 'long', year: 'numeric' }} />}
                />
              )}
              {data.startAt && (
                <InfoRow
                  label={t('secureBooking.time')}
                  value={<FormattedDate value={data.startAt} timeZone={tz} options={{ hour: '2-digit', minute: '2-digit' }} />}
                />
              )}
              <InfoRow label={t('secureBooking.bookingRef')} value={data.bookingRef ?? '—'} bdi />
              {data.bookingStatus && (
                <div className="flex items-center justify-between py-1">
                  <span className="text-text-secondary">{t('secureBooking.bookingStatus')}</span>
                  <StatusBadge
                    tone={BOOKING_STATUS_TONE[data.bookingStatus] ?? 'neutral'}
                    label={t(`secureBooking.bookingStatusLabels.${data.bookingStatus}`, { defaultValue: data.bookingStatus })}
                  />
                </div>
              )}
            </div>

            {data.total !== null && (
              <div className="w-full rounded-md border border-border p-4 text-start text-sm">
                <p className="mb-2 text-xs font-medium text-text-secondary">{t('secureBooking.paymentSummary')}</p>
                <InfoRow label={t('secureBooking.total')} value={<FormattedCurrency value={data.total} />} />
                {data.paid !== null && (
                  <InfoRow label={t('secureBooking.paid')} value={<FormattedCurrency value={data.paid} />} valueClassName="text-status-success" />
                )}
                {data.outstanding !== null && data.outstanding > 0 && (
                  <InfoRow label={t('secureBooking.outstanding')} value={<FormattedCurrency value={data.outstanding} />} valueClassName="text-status-danger" />
                )}
                {data.paymentStatus && (
                  <div className="flex items-center justify-between py-1">
                    <span className="text-text-secondary">{t('secureBooking.paymentStatus')}</span>
                    <StatusBadge
                      tone={PAYMENT_STATUS_TONE[data.paymentStatus] ?? 'neutral'}
                      label={t(`secureBooking.paymentStatusLabels.${data.paymentStatus}`, { defaultValue: data.paymentStatus })}
                    />
                  </div>
                )}
                {data.invoiceTokenAvailable && (
                  <button
                    type="button"
                    onClick={() => invoiceLinkMutation.mutate()}
                    disabled={invoiceLinkMutation.isPending}
                    className="mt-2 inline-block text-sm font-medium text-accent-foreground underline disabled:opacity-60"
                  >
                    {invoiceLinkMutation.isPending ? t('secureBooking.loadingInvoice') : t('secureBooking.viewInvoice')}
                  </button>
                )}
              </div>
            )}

            {/* Directive Sections 14/15: hidden by default, only ever
                shown after this explicit tap -- never auto-revealed on
                page load. Only offered for a booking that isn't
                cancelled/no-show (data.bookingStatus already gates the
                whole `result === 'valid'` branch to non-cancelled
                bookings via verify_booking_qr_public()'s own 'cancelled'
                result, so a cancelled booking never reaches this button
                at all -- Section 24 is enforced upstream, not here). */}
            {!qrRevealed && (
              <button
                type="button"
                onClick={() => setQrRevealed(true)}
                className="w-full rounded-md bg-brand-primary px-4 py-2 text-sm font-medium text-white transition hover:opacity-90"
              >
                {t('secureBooking.viewQrButton')}
              </button>
            )}

            {qrRevealed && !qrDataUrl && (
              <p className="text-sm text-text-secondary">{t('secureBooking.generatingQr')}</p>
            )}

            {qrRevealed && qrDataUrl && (
              <QrCodeViewer
                qrDataUrl={qrDataUrl}
                label={t('secureBooking.attendanceQr')}
                hint={t('secureBooking.attendanceQrHint')}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function stateKey(result: VerifyResult): string {
  return result === 'already_used' ? 'alreadyUsed' : result
}

function InfoRow({ label, value, bdi, valueClassName }: { label: string; value: ReactNode; bdi?: boolean; valueClassName?: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-text-secondary">{label}</span>
      <span className={`font-medium tabular-nums ${valueClassName ?? ''}`}>{bdi ? <bdi>{value}</bdi> : value}</span>
    </div>
  )
}
