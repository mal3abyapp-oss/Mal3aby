import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
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
import { Button } from '@/components/ui/button'
import { CheckCircle2, Clock, CalendarDays, MapPin, Copy, Download, RefreshCw, Ticket, Phone, QrCode as QrIcon } from 'lucide-react'
import { PaymentMethodsPanel } from '@/features/public-booking/PaymentMethodsPanel'
import { HoldCountdown } from '@/features/public-booking/HoldCountdown'
import '@/features/public-booking/public-booking.css'

interface BookingContext {
  result: 'valid' | 'expired' | 'cancelled' | 'already_used' | 'invalid'
  booking_id?: string
  club_id?: string
  booking_ref?: string
  club_name?: string
  club_slug?: string
  club_phone?: string
  field_name?: string
  branch_name?: string
  start_at?: string
  end_at?: string
  timezone?: string
  currency?: string
  booking_status?: string
  total?: number | null
  paid?: number | null
  outstanding?: number | null
  payment_status?: string
  invoice_token_available?: boolean
  hold_expires_at?: string | null
  can_pay?: boolean
  can_check_in?: boolean
}

export function SecureBookingPage() {
  const { token } = useParams<{ token: string }>()
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const { locale, direction, setLocale } = useDirection()
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [qrRevealed, setQrRevealed] = useState(false)
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  // OWNER FEEDBACK (2026-09-14): "من الأفضل وضع إشعار للاحتفاظ برقم
  // الحجز بعلامة مميزة أو أي طريقة تلفت النظر" -- the booking ref is
  // the one input request_public_booking_link() (the exact-match
  // recovery path) actually needs, so drawing deliberate attention to
  // it here, at the moment the customer is most likely to still have
  // this tab open, reduces how often anyone needs the phone-only
  // fallback at all. A separate copy state from the link's own
  // copyState -- the two are independent actions with independent
  // feedback, copying one should never silently reset the other's
  // "copied" confirmation mid-read.
  const [refCopyState, setRefCopyState] = useState<'idle' | 'copied' | 'error'>('idle')
  const [qrError, setQrError] = useState(false)
  const [now, setNow] = useState(Date.now())
  const { data, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: ['secure-booking-context', token],
    queryFn: async () => {
      const { data: context, error } = await supabase.rpc('get_public_booking_context', { p_token: token! })
      if (error) throw error
      return context as unknown as BookingContext
    },
    enabled: !!token,
    retry: false,
    refetchInterval: 15000,
    refetchOnWindowFocus: 'always',
    staleTime: 0,
  })
  useEffect(() => { document.title = `${data?.club_name ?? 'Mal3aby'} — ${t('secureBooking.title')}` }, [data?.club_name, t])
  const invoice = useMutation({
    mutationFn: async () => {
      const { data: invoiceToken, error } = await supabase.rpc('mint_invoice_token_for_booking_qr', { p_booking_qr_token: token! })
      if (error || !invoiceToken) throw error ?? new Error('invoice unavailable')
      return invoiceToken
    },
    onSuccess: invoiceToken => window.location.assign(`/verify/${encodeURIComponent(invoiceToken)}?lang=${locale}`),
  })
  useEffect(() => {
    const lang = searchParams.get('lang')
    if (lang === 'ar' || lang === 'en') setLocale(lang)
    // URL initializes language; subsequent manual changes remain authoritative.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (data?.booking_status !== 'pending_payment') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [data?.booking_status])
  useEffect(() => { setQrRevealed(false); setCopyState('idle') }, [token])
  useEffect(() => {
    setQrDataUrl(null)
    setQrError(false)
    if (!qrRevealed || !data?.can_check_in || !token || isError) return
    let cancelled = false
    // Staff scanners require the bare credential, not the page URL.
    void QRCode.toDataURL(token, { width: 480, margin: 1 }).then(value => {
      if (!cancelled) setQrDataUrl(value)
    }).catch(() => { if (!cancelled) setQrError(true) })
    return () => { cancelled = true }
  }, [token, qrRevealed, data?.can_check_in, isError])
  const accessible = !!data?.booking_id && data.result !== 'invalid' && data.result !== 'expired'
  const pending = data?.booking_status === 'pending_payment'
  const holdExpired = pending && !!data?.hold_expires_at && Date.parse(data.hold_expires_at) <= now
  const canPay = accessible && !isError && !holdExpired && data?.can_pay && Number(data.outstanding ?? 0) > 0
  const currency = data?.currency ?? 'EGP'
  const tz = data?.timezone ?? 'Africa/Cairo'
  const savedUrl = `${window.location.origin}/qr/${encodeURIComponent(token ?? '')}?lang=${locale}`
  const statusTone = pending ? 'warning' : data?.booking_status === 'cancelled' || data?.booking_status === 'no_show' ? 'danger' : 'success'
  return <div dir={direction} className="booking-page min-h-screen bg-page-bg">
    <header className="border-b border-border bg-surface px-4 py-4">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
        <Link to={data?.club_slug ? `/c/${encodeURIComponent(data.club_slug)}` : '/'} className="flex items-center gap-2 font-semibold"><Ticket className="size-5" />{data?.club_name ?? 'Mal3aby'}</Link>
        <div className="flex items-center gap-3"><Link className="text-sm font-medium" to="/portal/bookings">{t('publicBooking.recovery.account')}</Link><LanguageSwitcher /></div>
      </div>
    </header>
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      {isLoading && <p role="status" className="booking-content">{t('secureBooking.loading')}</p>}
      {isError && <div role="alert" className="booking-content mb-6"><p>{t('publicBooking.manage.loadError')}</p><Button className="mt-4" disabled={isFetching} onClick={() => void refetch()}>{t('publicBooking.experience.retry')}</Button></div>}
      {!isLoading && !isError && !accessible && <div className="booking-content mx-auto max-w-lg text-center"><Ticket className="mx-auto mb-4 size-10 text-text-secondary" /><h1 className="text-xl font-semibold">{t(`secureBooking.states.${data?.result === 'expired' ? 'expired' : 'invalid'}Title`)}</h1><p className="mt-3 text-sm leading-7 text-text-secondary">{t('publicBooking.manage.invalidHint')}</p><Button asChild className="mt-5"><Link to="/portal/bookings">{t('publicBooking.recovery.account')}</Link></Button></div>}
      {accessible && data && <>
        <section className="booking-venue-banner booking-manage-banner">
          <div><div className="mb-3 inline-flex items-center gap-2 text-sm text-white/80">{pending ? <Clock className="size-4" /> : <Ticket className="size-4" />}{t(`secureBooking.bookingStatusLabels.${data.booking_status}`, { defaultValue: data.booking_status })}</div>
            <h1>{t('publicBooking.manage.title')}</h1><p>{data.field_name}</p>
          </div>
          <div className="text-start sm:text-end">
            <span className="block text-xs text-white/60">{t('secureBooking.bookingRef')}</span>
            <div className="mt-2 flex items-center gap-2 sm:justify-end">
              <bdi className="text-xl font-semibold tracking-wider">{data.booking_ref}</bdi>
              {data.booking_ref && <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-white/80 hover:bg-white/10 hover:text-white"
                aria-label={t('publicBooking.manage.copyRef')}
                onClick={async () => {
                  try { await navigator.clipboard.writeText(data.booking_ref!); setRefCopyState('copied') } catch { setRefCopyState('error') }
                  window.setTimeout(() => setRefCopyState('idle'), 2000)
                }}
              >
                {refCopyState === 'copied' ? <CheckCircle2 className="size-4" /> : <Copy className="size-4" />}
              </Button>}
            </div>
          </div>
        </section>
        <div className="booking-layout booking-manage-layout">
          <div className="flex min-w-0 flex-col gap-6">
            <section className="booking-content">
              <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h2 className="text-xl font-semibold">{t('secureBooking.title')}</h2><StatusBadge tone={statusTone} label={t(`secureBooking.bookingStatusLabels.${data.booking_status}`, { defaultValue: data.booking_status })} /></div>
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="flex items-start gap-3"><MapPin className="mt-1 size-5 text-text-secondary" /><div><p className="font-semibold">{data.field_name}</p><p className="mt-1 text-sm text-text-secondary">{data.branch_name}</p></div></div>
                <div className="flex items-start gap-3"><CalendarDays className="mt-1 size-5 text-text-secondary" /><div>{data.start_at && <FormattedDate value={data.start_at} timeZone={tz} options={{ weekday: 'long', day: 'numeric', month: 'long' }} />}<p className="mt-1 text-sm text-text-secondary">{data.start_at && <FormattedDate value={data.start_at} timeZone={tz} options={{ hour: '2-digit', minute: '2-digit' }} />} – {data.end_at && <FormattedDate value={data.end_at} timeZone={tz} options={{ hour: '2-digit', minute: '2-digit' }} />}</p></div></div>
              </div>
              {pending && data.hold_expires_at && <div className="mt-6"><HoldCountdown holdExpiresAt={data.hold_expires_at} /></div>}
            </section>
            <section className="booking-content" aria-label={t('publicBooking.manage.paymentTitle')}>
              <div className="mb-5 flex items-center justify-between gap-3"><h2 className="text-xl font-semibold">{t('publicBooking.manage.paymentTitle')}</h2><Button variant="ghost" aria-label={t('publicBooking.manage.refresh')} disabled={isFetching} onClick={() => void refetch()}><RefreshCw className={`size-4 ${isFetching ? 'animate-spin' : ''}`} /></Button></div>
              {canPay && data.booking_id && data.club_id ? <PaymentMethodsPanel bookingId={data.booking_id} clubId={data.club_id} bookingRef={data.booking_ref ?? null} clubName={data.club_name ?? ''} total={Number(data.outstanding)} currency={currency} locale={locale} /> : <p className="text-sm leading-7 text-text-secondary">{t(isError ? 'publicBooking.manage.loadError' : holdExpired ? 'publicBooking.holdExpiredMessage' : Number(data.outstanding ?? 0) === 0 && data.payment_status === 'paid' ? 'publicBooking.manage.paid' : 'publicBooking.manage.paymentUnavailable')}</p>}
              {invoice.isError && <p role="alert" className="mt-3 text-sm text-status-danger">{t('publicBooking.manage.invoiceError')}</p>}
              {data.result === 'valid' && !isError && <Button variant="outline" className="mt-4 min-h-11" disabled={invoice.isPending} onClick={() => invoice.mutate()}>{t(invoice.isPending ? 'secureBooking.loadingInvoice' : 'secureBooking.viewInvoice')}</Button>}
            </section>
            {data.can_check_in && !isError && <section className="booking-content">
              <Button variant="outline" className="min-h-12 w-full gap-2" onClick={() => setQrRevealed(value => !value)}><QrIcon className="size-5" />{t('secureBooking.viewQrButton')}</Button>
              {qrRevealed && !qrDataUrl && !qrError && <p role="status" className="mt-3 text-sm">{t('secureBooking.generatingQr')}</p>}
              {qrError && <p role="alert" className="mt-3 text-sm text-status-danger">{t('publicBooking.manage.loadError')}</p>}
              {qrRevealed && qrDataUrl && <QrCodeViewer qrDataUrl={qrDataUrl} label={t('secureBooking.attendanceQr')} hint={t('secureBooking.attendanceQrHint')} />}
            </section>}
          </div>
          <aside className="booking-summary">
            <h2 className="mb-5 text-lg font-semibold">{t('secureBooking.paymentSummary')}</h2>
            <dl className="flex flex-col gap-4 text-sm"><div className="flex justify-between gap-3"><dt>{t('secureBooking.total')}</dt><dd><FormattedCurrency value={Number(data.total ?? 0)} currencyCode={currency} /></dd></div><div className="flex justify-between gap-3"><dt>{t('secureBooking.paid')}</dt><dd><FormattedCurrency value={Number(data.paid ?? 0)} currencyCode={currency} /></dd></div><div className="flex justify-between gap-3 border-t border-border pt-4 text-lg font-semibold"><dt>{t('secureBooking.outstanding')}</dt><dd><FormattedCurrency value={Number(data.outstanding ?? 0)} currencyCode={currency} /></dd></div></dl>
            {/* OWNER FEEDBACK (2026-09-14): "من الأفضل وضع إشعار
                للاحتفاظ برقم الحجز بعلامة مميزة أو أي طريقة تلفت
                النظر" -- a deliberately distinct, bordered callout
                (not a full-color fill, not a pulse/flash -- see
                .booking-ref-callout's own comment) right above the
                existing "save your link" card, since the ref is the
                one input the exact-match recovery path actually needs. */}
            <div className="booking-ref-callout mt-6">
              <h3 className="text-sm font-semibold">{t('publicBooking.manage.refCalloutTitle')}</h3>
              <p className="mt-1.5 text-xs leading-6 text-text-secondary">{t('publicBooking.manage.refCalloutHint')}</p>
              <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
                <bdi className="text-base font-semibold tracking-wider">{data.booking_ref}</bdi>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={t('publicBooking.manage.copyRef')}
                  onClick={async () => {
                    try { await navigator.clipboard.writeText(data.booking_ref ?? ''); setRefCopyState('copied') } catch { setRefCopyState('error') }
                    window.setTimeout(() => setRefCopyState('idle'), 2000)
                  }}
                >
                  {refCopyState === 'copied' ? <CheckCircle2 className="size-4" /> : <Copy className="size-4" />}
                </Button>
              </div>
              {refCopyState === 'copied' && <p role="status" className="mt-1.5 text-xs text-status-success">{t('publicBooking.manage.refCopied')}</p>}
              {refCopyState === 'error' && <p role="alert" className="mt-1.5 text-xs text-text-secondary">{t('publicBooking.manage.refCopyErrorHint')}</p>}
            </div>
            <div className="booking-return-card"><h3 className="font-semibold">{t('publicBooking.manage.saveTitle')}</h3><p className="mt-2 text-xs leading-6 text-text-secondary">{t('publicBooking.manage.saveHint')}</p>
              <Button variant="outline" className="mt-3 min-h-11 w-full gap-2" onClick={async () => { try { await navigator.clipboard.writeText(savedUrl); setCopyState('copied') } catch { setCopyState('error') } }}>{copyState === 'copied' ? <CheckCircle2 className="size-4" /> : <Copy className="size-4" />}{t(copyState === 'copied' ? 'publicBooking.manage.copied' : 'publicBooking.manage.copy')}</Button>
              {copyState === 'error' && <p role="alert" className="mt-2 break-all text-xs">{savedUrl}</p>}
              <Button asChild variant="ghost" className="mt-2 min-h-11 w-full gap-2"><a href={`data:text/plain;charset=utf-8,${encodeURIComponent(`${data.club_name}\n${data.booking_ref}\n${savedUrl}`)}`} download={`booking-${data.booking_ref ?? 'link'}.txt`}><Download className="size-4" />{t('publicBooking.manage.download')}</a></Button>
              {data.club_phone && <a className="mt-4 flex items-center gap-2 text-sm underline underline-offset-4" href={`tel:${data.club_phone}`}><Phone className="size-4" />{t('publicBooking.callClub')}</a>}
              {data.club_slug && <Link className="mt-4 block text-sm font-medium underline underline-offset-4" to={`/c/${encodeURIComponent(data.club_slug)}`}>{t('publicBooking.manage.newBooking')}</Link>}
            </div>
          </aside>
        </div>
      </>}
    </main>
  </div>
}
