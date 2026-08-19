import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Clock } from 'lucide-react'

/**
 * HoldCountdown -- directive requirement: "vعرض Deadline...مع Countdown"
 * everywhere a payment hold matters (Booking Success, Secure Booking,
 * Customer Portal). The countdown itself is a plain client-side timer
 * (setInterval), but the value it counts down TO is always
 * holdExpiresAt -- a real server timestamp returned by
 * create_public_booking()/read from bookings.hold_expires_at, never a
 * client-invented duration. If the tab stays open past expiry this
 * just shows 00:00 and an "expired" message; it never re-derives or
 * extends the deadline locally -- the server-side
 * expire_stale_booking_holds() reaper is the actual source of truth
 * for whether the booking is still held, this is display-only.
 */
export function HoldCountdown({ holdExpiresAt }: { holdExpiresAt: string }) {
  const { t } = useTranslation()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const expiresAtMs = new Date(holdExpiresAt).getTime()
  const remainingMs = Math.max(0, expiresAtMs - now)
  const expired = remainingMs <= 0

  const totalSeconds = Math.floor(remainingMs / 1000)
  const hh = Math.floor(totalSeconds / 3600)
  const mm = Math.floor((totalSeconds % 3600) / 60)
  const ss = totalSeconds % 60
  const display = hh > 0
    ? `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
    : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`

  if (expired) {
    return (
      <div className="rounded-lg border border-status-danger/40 bg-status-danger/5 p-4 text-center">
        <p className="text-sm font-medium text-status-danger">{t('publicBooking.holdExpiredTitle')}</p>
        <p className="mt-1 text-xs text-text-secondary">{t('publicBooking.holdExpiredMessage')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center gap-1 rounded-lg border border-status-warning/40 bg-status-warning/5 p-4 text-center">
      <p className="text-sm font-medium text-status-warning">{t('publicBooking.holdActiveTitle')}</p>
      <div className="flex items-center gap-2 text-2xl font-bold tabular-nums text-status-warning">
        <Clock className="size-5" />
        <bdi dir="ltr">{display}</bdi>
      </div>
      <p className="text-xs text-text-secondary">{t('publicBooking.holdActiveMessage')}</p>
    </div>
  )
}
