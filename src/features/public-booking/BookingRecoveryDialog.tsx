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
  // exact ref match. Same enumeration-safe contract either way: always
  // void, never reveals whether/how many bookings matched.
  const hasReference = reference.trim().length > 0
  const request = useMutation({
    mutationFn: async () => {
      const normalized = normalizePhone(mobile.raw, mobile.country)
      if (!normalized.valid || !normalized.e164) throw new Error('invalid phone')
      const { error } = hasReference
        ? await supabase.rpc('request_public_booking_link', {
            p_club_slug: slug, p_booking_ref: reference.trim().toUpperCase(), p_phone_e164: normalized.e164,
          })
        : await supabase.rpc('request_public_booking_links_by_phone', {
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
      {mode === 'request' ? <form className="flex flex-col gap-4" onSubmit={e => { e.preventDefault(); request.mutate() }}>
        <div><label htmlFor="recovery-reference" className="mb-2 block text-sm font-medium">{t('secureBooking.bookingRef')}</label>
          <Input id="recovery-reference" dir="ltr" placeholder="MB-1234ABCD" autoComplete="off" maxLength={11} value={reference} onChange={e => setReference(e.target.value.toUpperCase())} />
          {/* GAP CLOSURE (2026-09-14): reference is now optional -- a
              customer who genuinely never had it can leave this blank
              and still recover every active booking on their phone. */}
          <p className="mt-1.5 text-xs text-text-secondary">{t('publicBooking.recovery.referenceOptionalHint')}</p>
        </div>
        <PhoneInput label={t('publicBooking.mobileLabel')} required value={mobile} onChange={setMobile} />
        {request.isSuccess ? <p role="status" className="rounded-xl bg-page-bg p-4 text-sm leading-7">{t('publicBooking.recovery.sent')}</p> : <Button type="submit" className="min-h-12" disabled={request.isPending || (hasReference && !/^MB-[A-F0-9]{8}$/i.test(reference.trim())) || !normalizePhone(mobile.raw, mobile.country).valid}>{t(request.isPending ? 'publicBooking.loading' : hasReference ? 'publicBooking.recovery.send' : 'publicBooking.recovery.sendAny')}</Button>}
        {request.isError && <p role="alert" className="text-sm text-status-danger">{t('publicBooking.recovery.error')}</p>}
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
