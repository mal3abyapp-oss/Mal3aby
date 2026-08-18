import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatCurrency, formatDate, type SupportedLocale } from '@/lib/i18n/config'
import { LanguageSwitcher } from '@/components/ui/language-switcher'
import { StatusBadge } from '@/components/ui/status-badge'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { CheckCircle2, XCircle, Clock, Ban, Maximize2 } from 'lucide-react'

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
  const [fullScreenOpen, setFullScreenOpen] = useState(false)

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
  const qrUrl = typeof window !== 'undefined' && token ? `${window.location.origin}/qr/${token}` : null

  useEffect(() => {
    if (result !== 'valid' || !qrUrl) {
      setQrDataUrl(null)
      return
    }
    let cancelled = false
    void QRCode.toDataURL(qrUrl, { width: 480, margin: 1 }).then((url) => {
      if (!cancelled) setQrDataUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [result, qrUrl])

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
                  value={formatDate(data.startAt, locale, tz, { day: 'numeric', month: 'long', year: 'numeric' })}
                />
              )}
              {data.startAt && (
                <InfoRow
                  label={t('secureBooking.time')}
                  value={formatDate(data.startAt, locale, tz, { hour: '2-digit', minute: '2-digit' })}
                  bdi
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
                <InfoRow label={t('secureBooking.total')} value={formatCurrency(data.total, locale as SupportedLocale)} />
                {data.paid !== null && (
                  <InfoRow label={t('secureBooking.paid')} value={formatCurrency(data.paid, locale as SupportedLocale)} valueClassName="text-status-success" />
                )}
                {data.outstanding !== null && data.outstanding > 0 && (
                  <InfoRow label={t('secureBooking.outstanding')} value={formatCurrency(data.outstanding, locale as SupportedLocale)} valueClassName="text-status-danger" />
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
                  <a
                    href={`/verify/${token ?? ''}`}
                    className="mt-2 inline-block text-sm font-medium text-accent-foreground underline"
                  >
                    {t('secureBooking.viewInvoice')}
                  </a>
                )}
              </div>
            )}

            {qrDataUrl && (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-surface p-4">
                <p className="text-xs font-medium text-text-secondary">{t('secureBooking.attendanceQr')}</p>
                <button
                  type="button"
                  onClick={() => setFullScreenOpen(true)}
                  className="group relative"
                  aria-label={t('secureBooking.viewFullScreen')}
                >
                  <img src={qrDataUrl} alt={t('secureBooking.attendanceQr')} className="size-40" />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition group-hover:bg-black/40 group-hover:opacity-100">
                    <Maximize2 className="size-6 text-white" />
                  </span>
                </button>
                <p className="text-xs text-text-secondary">{t('secureBooking.attendanceQrHint')}</p>
              </div>
            )}
          </div>
        )}
      </div>

      <Dialog open={fullScreenOpen} onOpenChange={setFullScreenOpen}>
        <DialogContent className="flex max-w-none flex-col items-center justify-center gap-4 border-none bg-white p-8 sm:max-w-none">
          <DialogTitle className="sr-only">{t('secureBooking.attendanceQr')}</DialogTitle>
          {qrDataUrl && <img src={qrDataUrl} alt={t('secureBooking.attendanceQr')} className="size-[min(80vw,80vh)]" />}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function stateKey(result: VerifyResult): string {
  return result === 'already_used' ? 'alreadyUsed' : result
}

function InfoRow({ label, value, bdi, valueClassName }: { label: string; value: string; bdi?: boolean; valueClassName?: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-text-secondary">{label}</span>
      <span className={`font-medium tabular-nums ${valueClassName ?? ''}`}>{bdi ? <bdi>{value}</bdi> : value}</span>
    </div>
  )
}
