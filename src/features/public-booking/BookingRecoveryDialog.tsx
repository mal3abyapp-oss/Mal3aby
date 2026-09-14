import { useState } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { useDirection } from '@/app/providers/DirectionProvider'
import { normalizePhone } from '@/lib/domain/phone'
import { supabase } from '@/lib/supabase/client'
import { bookingPathFromLink } from './booking-access'

export function BookingRecoveryDialog({ open, onOpenChange, slug, country, phone }: {
  open: boolean; onOpenChange: (open: boolean) => void; slug: string; country: string; phone: string | null
}) {
  const { t } = useTranslation()
  const { direction, locale } = useDirection()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'request' | 'link'>('request')
  const [reference, setReference] = useState('')
  const [mobile, setMobile] = useState({ raw: '', country: country as CountryCode })
  const [link, setLink] = useState('')
  const [invalidLink, setInvalidLink] = useState(false)
  // GAP CLOSURE (2026-09-14, owner-reported): the booking reference used
  // to be mandatory here, so a customer who never wrote it down and
  // never saved the link had no way back in at all. It's now OPTIONAL --
  // left blank, this falls through to request_public_booking_links_by_phone(),
  // which resends every currently-active booking for this phone at this
  // club (server-side capped, independently rate-limited) instead of one
  // exact ref match. Always void, never reveals whether/how many
  // bookings matched -- there's no single destination to navigate to
  // when the match could be zero, one, or several bookings, so this
  // path stays message-based by necessity.
  const hasReference = reference.trim().length > 0
  // GAP CLOSURE (2026-09-14, owner follow-up): "اجعل عند وضع رقم الحجز
  // يرسل المستخدم الي صفحه الحجز مثل الرابط" -- entering a SPECIFIC
  // ref (unlike the phone-only path above) names exactly one intended
  // booking, so there IS a single destination once the phone genuinely
  // matches that booking's own customer record. resolve_public_booking_
  // by_ref_and_phone() verifies ref+phone together (the phone is the
  // real verification step here, not a formality) and returns a real
  // token on a match -- rate-limited/enumeration-hardened exactly like
  // request_public_booking_link (same shared table/thresholds), the
  // difference is only that a genuine match now returns the actual
  // credential instead of queuing a message, saving the customer a
  // trip to WhatsApp/email for the one-specific-booking case.
  const [resolvedNotFound, setResolvedNotFound] = useState(false)
  const resolve = useMutation({
    mutationFn: async () => {
      const normalized = normalizePhone(mobile.raw, mobile.country)
      if (!normalized.valid || !normalized.e164) throw new Error('invalid phone')
      const { data, error } = await supabase.rpc('resolve_public_booking_by_ref_and_phone', {
        p_club_slug: slug, p_booking_ref: reference.trim().toUpperCase(), p_phone_e164: normalized.e164,
      })
      if (error) throw error
      const result = data as unknown as { result: 'valid' | 'invalid'; token?: string }
      return result
    },
    onSuccess: (result) => {
      if (result.result === 'valid' && result.token) {
        setResolvedNotFound(false)
        onOpenChange(false)
        navigate(`/qr/${encodeURIComponent(result.token)}?lang=${locale}`)
      } else {
        // Deliberately vague -- "not found or not matched" covers
        // both a genuine miss and a throttled real match identically,
        // same enumeration-safety contract as every other recovery
        // path on this page. The phone-only tab below remains
        // available as a fallback.
        setResolvedNotFound(true)
      }
    },
  })
  const request = useMutation({
    mutationFn: async () => {
      const normalized = normalizePhone(mobile.raw, mobile.country)
      if (!normalized.valid || !normalized.e164) throw new Error('invalid phone')
      const { error } = await supabase.rpc('request_public_booking_links_by_phone', {
        p_club_slug: slug, p_phone_e164: normalized.e164,
      })
      if (error) throw error
    },
  })
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent dir={direction} className="booking-page rounded-2xl">
      <DialogHeader className="pe-6 text-start">
        <DialogTitle>{t('publicBooking.recovery.title')}</DialogTitle>
        <DialogDescription className="pt-2 leading-6">{t('publicBooking.recovery.description')}</DialogDescription>
      </DialogHeader>
      <div className="flex gap-2">
        {(['request', 'link'] as const).map(value => <Button key={value} variant={mode === value ? 'default' : 'outline'} className="min-h-11 flex-1" aria-pressed={mode === value} onClick={() => setMode(value)}>{t(`publicBooking.recovery.${value}Tab`)}</Button>)}
      </div>
      {mode === 'request' ? <form className="flex flex-col gap-4" onSubmit={e => {
        e.preventDefault()
        setResolvedNotFound(false)
        if (hasReference) resolve.mutate(); else request.mutate()
      }}>
        <div><label htmlFor="recovery-reference" className="mb-2 block text-sm font-medium">{t('secureBooking.bookingRef')}</label>
          <Input id="recovery-reference" dir="ltr" placeholder="MB-1234ABCD" autoComplete="off" maxLength={11} value={reference} onChange={e => { setReference(e.target.value.toUpperCase()); setResolvedNotFound(false) }} />
          {/* GAP CLOSURE (2026-09-14): reference is now optional -- a
              customer who genuinely never had it can leave this blank
              and still recover every active booking on their phone. */}
          <p className="mt-1.5 text-xs text-text-secondary">{t('publicBooking.recovery.referenceOptionalHint')}</p>
        </div>
        <PhoneInput label={t('publicBooking.mobileLabel')} required value={mobile} onChange={setMobile} />
        {request.isSuccess ? <p role="status" className="rounded-xl bg-page-bg p-4 text-sm leading-7">{t('publicBooking.recovery.sent')}</p> : <Button type="submit" className="min-h-12" disabled={resolve.isPending || request.isPending || (hasReference && !/^MB-[A-F0-9]{8}$/i.test(reference.trim())) || !normalizePhone(mobile.raw, mobile.country).valid}>{t((resolve.isPending || request.isPending) ? 'publicBooking.loading' : hasReference ? 'publicBooking.recovery.send' : 'publicBooking.recovery.sendAny')}</Button>}
        {/* GAP CLOSURE (2026-09-14, owner follow-up): a matched ref+phone
            navigates straight to /qr/:token (handled in resolve's
            onSuccess) -- this form only ever renders a message for the
            "not found" case, matched-and-throttled being indistinguishable
            from a genuine miss by design (same enumeration-safety
            contract as every other recovery path here). */}
        {resolvedNotFound && <p role="alert" className="text-sm text-status-danger">{t('publicBooking.recovery.notFound')}</p>}
        {(request.isError || resolve.isError) && <p role="alert" className="text-sm text-status-danger">{t('publicBooking.recovery.error')}</p>}
      </form> : <form className="flex flex-col gap-3" onSubmit={e => {
        e.preventDefault()
        const path = bookingPathFromLink(link, window.location.origin)
        if (!path) { setInvalidLink(true); return }
        onOpenChange(false)
        navigate(`${path}?lang=${locale}`)
      }}>
        <label htmlFor="recovery-link" className="text-sm font-medium">{t('publicBooking.recovery.linkLabel')}</label>
        <Input id="recovery-link" dir="ltr" value={link} onChange={e => { setLink(e.target.value); setInvalidLink(false) }} placeholder="https://mal3aby.app/qr/…" />
        {invalidLink && <p role="alert" className="text-sm text-status-danger">{t('publicBooking.recovery.invalidLink')}</p>}
        <Button type="submit" className="min-h-12" disabled={!link.trim()}>{t('publicBooking.recovery.open')}</Button>
      </form>}
      <div className="border-t border-border pt-4 text-sm leading-7">
        <Link className="font-semibold underline underline-offset-4" to="/portal/bookings">{t('publicBooking.recovery.account')}</Link>
        <p className="mt-1 text-xs text-text-secondary">{t('publicBooking.recovery.accountHint')}</p>
        {phone && <a href={`tel:${phone}`} className="mt-3 inline-block underline underline-offset-4">{t('publicBooking.recovery.contact')}</a>}
      </div>
    </DialogContent>
  </Dialog>
}
