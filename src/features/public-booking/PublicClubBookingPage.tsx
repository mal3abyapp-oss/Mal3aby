import { useEffect, useMemo, useState } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { useParams, useSearchParams, Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatCurrency, formatDate, type SupportedLocale } from '@/lib/i18n/config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { LanguageSwitcher } from '@/components/ui/language-switcher'
import { CheckCircle2, MapPin, ChevronLeft, ChevronRight, Phone, MessageCircle, Copy, Check, CalendarPlus } from 'lucide-react'
import { PaymentMethodsPanel } from './PaymentMethodsPanel'
import { HoldCountdown } from './HoldCountdown'
import { normalizePhone } from '@/lib/domain/phone'

/**
 * PublicClubBookingPage -- the Public Club Booking Page.
 *
 * MAL3ABY PRODUCT/UX/BOOKING/PAYMENT DIRECTIVE: the booking-window
 * policy (same-day online booking off by default, booking opens
 * tomorrow, 2-day window) is enforced SERVER-SIDE by
 * create_public_booking() itself (never trust the frontend alone --
 * this page's date picker only ever offers dates the server would
 * actually accept, but the server re-validates independently so
 * editing the request directly still gets rejected). TODAY is
 * deliberately still selectable here -- it shows real availability and
 * a "contact the club" CTA (call/WhatsApp using the CLUB's own number,
 * never Mal3aby's), not a disabled/hidden day and not an online-booking
 * form that fails at the last step.
 */

type Step = 'field' | 'date' | 'time' | 'details' | 'confirmed'

interface PublicField {
  id: string
  branch_id: string
  name: string
  sport: string
  indoor: boolean
  capacity: number | null
  default_duration_minutes: number
}

interface PublicBranch {
  id: string
  name: string
  address: string | null
}

interface PublicClub {
  clubId: string
  clubName: string
  clubNameEn: string | null
  logoUrl: string | null
  currency: string
  timezone: string
  country: string | null
  primaryPhone: string | null
  whatsappNumber: string | null
  contactEmail: string | null
  address: string | null
  mapsUrl: string | null
  sameDayOnlineBookingEnabled: boolean
  onlineBookingStartOffsetDays: number
  onlineBookingWindowDays: number
  paymentHoldMinutes: number
  branches: PublicBranch[]
  fields: PublicField[]
}

async function fetchPublicClub(slug: string): Promise<PublicClub | null> {
  const { data, error } = await supabase.rpc('get_public_club', { p_slug: slug })
  if (error) throw error
  const row = data?.[0]
  if (!row) return null
  return {
    clubId: row.club_id,
    clubName: row.club_name,
    clubNameEn: row.club_name_en,
    logoUrl: row.logo_url,
    currency: row.currency,
    timezone: row.timezone,
    country: row.country ?? null,
    primaryPhone: row.primary_phone,
    whatsappNumber: row.whatsapp_number,
    contactEmail: row.contact_email,
    address: row.address,
    mapsUrl: row.maps_url,
    sameDayOnlineBookingEnabled: row.same_day_online_booking_enabled ?? false,
    onlineBookingStartOffsetDays: row.online_booking_start_offset_days ?? 1,
    onlineBookingWindowDays: row.online_booking_window_days ?? 2,
    paymentHoldMinutes: row.payment_hold_minutes ?? 60,
    branches: (row.branches ?? []) as unknown as PublicBranch[],
    fields: (row.fields ?? []) as unknown as PublicField[],
  }
}

// BOOKING ENGINE / AVAILABILITY directive, sections 3 + 21-24: duration
// is now a real customer choice (not a hardcoded 60-minute constant),
// and which start times are actually bookable for that duration is
// computed SERVER-SIDE via get_public_field_available_starts -- never
// walked client-side from busy_ranges. 60 minutes remains the default
// to preserve today's exact behavior for anyone who doesn't touch the
// picker. The DB is still the final authority regardless (the
// EXCLUDE constraint + create_public_booking's own exclusion_violation
// catch already guarantee that) -- this only fixes what the UI OFFERS.
const DURATION_OPTIONS_MINUTES = [30, 60, 90, 120] as const
const DEFAULT_DURATION_MINUTES = 60

interface AvailableStart {
  time: string // HH:MM, venue-local
  isAvailable: boolean
}

async function fetchAvailableStarts(fieldId: string, date: string, durationMinutes: number, timezone: string): Promise<AvailableStart[]> {
  const { data, error } = await supabase.rpc('get_public_field_available_starts', {
    p_field_id: fieldId,
    p_date: date,
    p_duration_minutes: durationMinutes,
  })
  if (error) throw error
  return (data ?? []).map((row) => ({
    time: new Date(row.start_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone }),
    isAvailable: row.is_available,
  }))
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function addDays(base: Date, n: number): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + n)
  return d
}

/** Formats a phone for wa.me (digits only, no leading +). */
function toWaDigits(phone: string): string {
  return phone.replace(/\D/g, '')
}

// Phone validation is now handled by the shared normalizePhone()
// pipeline (src/lib/domain/phone.ts) via <PhoneInput> below -- see the
// P0 Phone Identity directive. The old hand-rolled digit-strip regex
// (no country-code awareness) is retired from this file.

// Email stays OPTIONAL on the public booking form (product decision --
// do not make this required). This is a light format check only, used
// to block obviously-malformed input before it reaches the RPC; the
// server independently normalizes/trims (nullif(trim(p_customer_email),
// '')) and never requires the field.
const EMAIL_FORMAT_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function isPlausibleEmail(value: string): boolean {
  return EMAIL_FORMAT_RE.test(value.trim())
}

// HIGH-ROI UX PASS 01, item 19 (Add to Calendar): builds a plain .ics
// data URI from already-known booking fields -- no payment
// secrets/tokens in the description, per the directive's explicit
// instruction.
function buildIcsDataUri(opts: {
  clubName: string
  fieldName: string
  address: string | null
  startAt: Date
  endAt: Date
  bookingRef: string | null
}): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const toIcsUtc = (d: Date) =>
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  const escapeIcs = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n')
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Mal3aby//Booking//EN',
    'BEGIN:VEVENT',
    `UID:${opts.bookingRef ?? crypto.randomUUID()}@mal3aby.app`,
    `DTSTAMP:${toIcsUtc(new Date())}`,
    `DTSTART:${toIcsUtc(opts.startAt)}`,
    `DTEND:${toIcsUtc(opts.endAt)}`,
    `SUMMARY:${escapeIcs(`${opts.clubName} — ${opts.fieldName}`)}`,
    opts.address ? `LOCATION:${escapeIcs(opts.address)}` : null,
    opts.bookingRef ? `DESCRIPTION:${escapeIcs(opts.bookingRef)}` : null,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter((l): l is string => l !== null)
  return `data:text/calendar;charset=utf-8,${encodeURIComponent(lines.join('\r\n'))}`
}

export function PublicClubBookingPage() {
  const { slug } = useParams<{ slug: string }>()
  const [searchParams] = useSearchParams()
  const { t } = useTranslation()
  const { direction, locale, setLocale } = useDirection()
  const queryClient = useQueryClient()

  const [step, setStep] = useState<Step>('field')
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [selectedDuration, setSelectedDuration] = useState<number>(DEFAULT_DURATION_MINUTES)
  const [selectedTime, setSelectedTime] = useState<string | null>(null)
  const [customerName, setCustomerName] = useState('')
  const [customerEmail, setCustomerEmail] = useState('')
  const [customerMobile, setCustomerMobile] = useState('')
  const [customerPhoneCountry, setCustomerPhoneCountry] = useState<CountryCode>('EG')
  const [phoneValid, setPhoneValid] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [conflictSlot, setConflictSlot] = useState<string | null>(null)
  const [confirmedRef, setConfirmedRef] = useState<string | null>(null)
  const [confirmedBookingId, setConfirmedBookingId] = useState<string | null>(null)
  const [confirmedHoldExpiresAt, setConfirmedHoldExpiresAt] = useState<string | null>(null)
  const [confirmedTotal, setConfirmedTotal] = useState<number | null>(null)
  // FINAL ACCEPTANCE CLOSURE (2026-08-29) -- WhatsApp-independent entry
  // credential: create_public_booking() now returns the same raw
  // booking_qr_token it already mints and sends via WhatsApp/email, so
  // the confirmation screen can offer a direct, reliable link to the
  // already-built, already-secured /qr/:token page (SecureBookingPage)
  // regardless of whether either notification channel actually
  // delivers. See the accompanying migration's header comment for the
  // full security reasoning.
  const [confirmedQrToken, setConfirmedQrToken] = useState<string | null>(null)
  const [copiedField, setCopiedField] = useState<string | null>(null)

  // HIGH-ROI UX PASS 01, supplementary item 6 (Public Booking language
  // switcher): seed from a one-time ?lang= param on first mount only,
  // same pattern already proven in SecureBookingPage.tsx -- never
  // fights the in-page LanguageSwitcher afterward, never overrides a
  // returning visitor's stored preference beyond this first read. This
  // controls the SYSTEM UI language only; club/user-generated data
  // (club name, address) is never machine-translated.
  useEffect(() => {
    const langParam = searchParams.get('lang')
    if (langParam === 'ar' || langParam === 'en') {
      if (langParam !== locale) setLocale(langParam)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const { data: club, isLoading: clubLoading, isError: clubError } = useQuery({
    queryKey: ['public-club', slug],
    queryFn: () => fetchPublicClub(slug!),
    enabled: !!slug,
    retry: false,
  })

  // Directive section 5: default the phone country to the club's own
  // default country once known -- never a hardcoded EG assumption, and
  // the customer can still explicitly override it (section 6).
  useEffect(() => {
    if (club?.country) setCustomerPhoneCountry(club.country as CountryCode)
  }, [club?.country])

  const selectedField = useMemo(() => club?.fields.find((f) => f.id === selectedFieldId) ?? null, [club, selectedFieldId])
  const selectedBranch = useMemo(() => club?.branches.find((b) => b.id === selectedField?.branch_id) ?? null, [club, selectedField])
  const dateKey = selectedDate ? toDateKey(selectedDate) : null

  // The exact 3 dates this page ever offers: Today, Tomorrow, Day after
  // tomorrow -- Today is always shown (contact experience), Tomorrow/
  // day-after are only shown if inside the club's configured window
  // (directive: "do not show dates beyond the allowed window").
  const dateOptions = useMemo(() => {
    if (!club) return []
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const options: Array<{ date: Date; daysOut: number; isToday: boolean; isOnlineBookable: boolean }> = [
      { date: today, daysOut: 0, isToday: true, isOnlineBookable: club.sameDayOnlineBookingEnabled },
    ]
    const lastWindowDay = club.onlineBookingStartOffsetDays + club.onlineBookingWindowDays - 1
    for (let d = club.onlineBookingStartOffsetDays; d <= lastWindowDay; d++) {
      options.push({ date: addDays(today, d), daysOut: d, isToday: false, isOnlineBookable: true })
    }
    return options
  }, [club])

  const selectedDateOption = useMemo(
    () => dateOptions.find((o) => dateKey && toDateKey(o.date) === dateKey) ?? null,
    [dateOptions, dateKey],
  )
  const isTodaySelected = selectedDateOption?.isToday ?? false

  // BOOKING ENGINE / AVAILABILITY directive: available START TIMES for
  // the chosen duration are now server-computed (get_public_field_available_starts),
  // not walked client-side from raw busy_ranges. The DB is the final
  // authority on every candidate this returns -- this call can only
  // ever be as fresh as its last fetch, which is exactly why
  // create_public_booking() still independently re-validates on submit
  // (see bookMutation's exclusion_violation handling below); this list
  // is UX, not the enforcement boundary.
  const { data: timeSlotsRaw, isLoading: availabilityLoading } = useQuery({
    queryKey: ['public-field-available-starts', selectedFieldId, dateKey, selectedDuration],
    queryFn: () => fetchAvailableStarts(selectedFieldId!, dateKey!, selectedDuration, club!.timezone),
    enabled: !!selectedFieldId && !!dateKey && !!club && (step === 'time' || step === 'date'),
  })

  const { data: price } = useQuery({
    queryKey: ['public-field-price', selectedFieldId, dateKey, selectedTime, selectedDuration],
    queryFn: async () => {
      const [h, m] = selectedTime!.split(':').map(Number)
      const endMinutes = (h ?? 0) * 60 + (m ?? 0) + selectedDuration
      const endTime = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`
      const { data, error } = await supabase.rpc('get_public_field_price', {
        p_field_id: selectedFieldId!,
        p_date: dateKey!,
        p_start_time: `${selectedTime}:00`,
        p_end_time: `${endTime}:00`,
      })
      if (error) throw error
      return data as number
    },
    enabled: !!selectedFieldId && !!dateKey && !!selectedTime && step === 'details' && !isTodaySelected,
  })

  const timeSlots = useMemo(() => {
    if (!timeSlotsRaw) return []
    // HIGH-ROI UX PASS 01, supplementary item 8: force this exact slot
    // unavailable in the UI the instant a real booking-conflict error
    // names it, even if the availability refetch triggered alongside it
    // hasn't resolved yet -- avoids a flash where the just-taken slot
    // briefly still renders as bookable.
    return timeSlotsRaw.map((s) => (s.time === conflictSlot ? { ...s, isAvailable: false } : s))
  }, [timeSlotsRaw, conflictSlot])

  const bookMutation = useMutation({
    mutationFn: async () => {
      if (!slug || !selectedFieldId || !dateKey || !selectedTime) throw new Error('missing input')
      const [h, m] = selectedTime.split(':').map(Number)
      const endMinutes = (h ?? 0) * 60 + (m ?? 0) + selectedDuration
      const endTime = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`
      const startAt = new Date(`${dateKey}T${selectedTime}:00`).toISOString()
      const endAt = new Date(`${dateKey}T${endTime}:00`).toISOString()

      const phoneResult = normalizePhone(customerMobile, customerPhoneCountry)
      if (!phoneResult.valid || !phoneResult.e164) {
        throw new Error(t('publicBooking.mobileInvalid'))
      }

      const trimmedEmail = customerEmail.trim()
      if (trimmedEmail && !isPlausibleEmail(trimmedEmail)) {
        throw new Error(t('publicBooking.emailInvalid'))
      }

      const { data, error } = await supabase.rpc('create_public_booking', {
        p_club_slug: slug,
        p_field_id: selectedFieldId,
        p_start_at: startAt,
        p_end_at: endAt,
        p_customer_name: customerName.trim(),
        p_customer_mobile: customerMobile.trim(),
        p_customer_phone_e164: phoneResult.e164,
        p_customer_email: trimmedEmail || undefined,
        p_source: 'club_public_link',
      })
      if (error) throw error
      return data?.[0]
    },
    onSuccess: (row) => {
      setFormError(null)
      setConfirmedRef(row?.booking_ref ?? null)
      setConfirmedBookingId(row?.booking_id ?? null)
      setConfirmedHoldExpiresAt(row?.hold_expires_at ?? null)
      setConfirmedTotal(row?.total_price != null ? Number(row.total_price) : null)
      setConfirmedQrToken(row?.booking_qr_token ?? null)
      setStep('confirmed')
    },
    onError: (error: { message?: string }) => {
      const message = error?.message ?? ''
      // HIGH-ROI UX PASS 01, supplementary item 8 (booking conflict
      // recovery): create_public_booking() raises this exact,
      // human-readable string when the EXCLUDE constraint on bookings
      // catches a real race (the slot was booked by someone else
      // between selection and submit) -- matched by substring since the
      // RPC error is the real, single source of truth for this
      // condition, not a guessed error code. On this specific failure,
      // route the customer back to a refreshed time step with the
      // now-taken slot remembered so it renders visibly unavailable,
      // instead of leaving them stuck on the details step reading a
      // flat error string with no guided next step.
      if (message.includes('just booked by someone else')) {
        setConflictSlot(selectedTime)
        setSelectedTime(null)
        setFormError(null)
        setStep('time')
        void queryClient.invalidateQueries({ queryKey: ['public-field-availability', selectedFieldId, dateKey] })
        return
      }
      setFormError(message || t('publicBooking.genericError'))
    },
  })

  useEffect(() => {
    document.title = club ? `${club.clubName} — ${t('publicBooking.bookNow')}` : 'Mal3aby'
  }, [club, t])

  async function copyToClipboard(value: string, fieldKey: string) {
    await navigator.clipboard.writeText(value)
    setCopiedField(fieldKey)
    setTimeout(() => setCopiedField((cur) => (cur === fieldKey ? null : cur)), 2000)
  }

  const BackIcon = direction === 'rtl' ? ChevronRight : ChevronLeft

  if (clubLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page-bg p-4">
        <p className="text-sm text-text-secondary">{t('publicBooking.loading')}</p>
      </div>
    )
  }

  if (clubError || !club) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-page-bg p-4">
        <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 text-center shadow">
          <p className="font-medium text-status-danger">{t('publicBooking.notFoundTitle')}</p>
          <p className="mt-2 text-sm text-text-secondary">{t('publicBooking.notFoundMessage')}</p>
        </div>
      </div>
    )
  }

  const clubWaNumber = club.whatsappNumber || club.primaryPhone

  return (
    <div dir={direction} className="min-h-screen bg-page-bg pb-24">
      <header className="border-b border-border bg-surface px-4 py-4">
        <div className="mx-auto flex max-w-lg items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {club.logoUrl && <img src={club.logoUrl} alt={club.clubName} className="size-10 rounded-full object-cover" />}
            <div>
              <p className="font-semibold">{club.clubName}</p>
              {selectedBranch && <p className="text-xs text-text-secondary">{selectedBranch.name}</p>}
            </div>
          </div>
          {/* HIGH-ROI UX PASS 01, supplementary item 6: the highest-
              traffic anonymous screen in the product previously had no
              way to change language at all -- stuck on whatever the
              browser/localStorage default was. Only the system UI
              switches; club-owned data (name, address) is never
              machine-translated. */}
          <LanguageSwitcher />
        </div>
      </header>

      <main className="mx-auto max-w-lg px-4 py-5">
        {step !== 'field' && step !== 'confirmed' && (
          <button
            type="button"
            className="mb-4 flex items-center gap-1 text-sm text-text-secondary"
            onClick={() => {
              if (step === 'date') setStep('field')
              else if (step === 'time') setStep('date')
              else if (step === 'details') setStep('time')
            }}
          >
            <BackIcon className="size-4" /> {t('publicBooking.back')}
          </button>
        )}

        {step === 'field' && (
          <div className="flex flex-col gap-3">
            <h1 className="text-lg font-semibold">{t('publicBooking.chooseField')}</h1>
            {club.fields.length === 0 && <p className="text-sm text-text-secondary">{t('publicBooking.noFields')}</p>}
            {club.fields.map((f) => {
              const branch = club.branches.find((b) => b.id === f.branch_id)
              return (
                <button
                  key={f.id}
                  type="button"
                  className="flex items-center justify-between rounded-lg border border-border bg-surface p-4 text-start shadow-sm transition hover:border-accent"
                  onClick={() => {
                    setSelectedFieldId(f.id)
                    setStep('date')
                  }}
                >
                  <div>
                    <p className="font-medium">{f.name}</p>
                    <p className="text-sm text-text-secondary">{t(`publicBooking.sportLabels.${f.sport}`, { defaultValue: f.sport })}</p>
                    {branch && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-text-secondary">
                        <MapPin className="size-3" /> {branch.name}
                      </p>
                    )}
                  </div>
                  <ChevronRight className={direction === 'rtl' ? 'size-4 rotate-180' : 'size-4'} />
                </button>
              )
            })}
          </div>
        )}

        {step === 'date' && (
          <div className="flex flex-col gap-3">
            <h1 className="text-lg font-semibold">{t('publicBooking.chooseDate')}</h1>
            <div className="grid grid-cols-3 gap-2">
              {dateOptions.map((opt) => (
                <button
                  key={toDateKey(opt.date)}
                  type="button"
                  className="flex flex-col items-center gap-1 rounded-lg border border-border bg-surface p-3 text-center text-sm shadow-sm transition hover:border-accent"
                  onClick={() => {
                    setSelectedDate(opt.date)
                    setStep('time')
                  }}
                >
                  <p className="font-medium">
                    {opt.isToday ? t('publicBooking.today') : formatDate(opt.date, locale as SupportedLocale, club.timezone, { weekday: 'short' })}
                  </p>
                  <p className="text-text-secondary">{formatDate(opt.date, locale as SupportedLocale, club.timezone, { day: 'numeric', month: 'short' })}</p>
                  {opt.isToday && (
                    <span className="rounded-full bg-info/10 px-2 py-0.5 text-[11px] font-medium text-info">
                      {t('publicBooking.todayContactBadge')}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 'time' && (
          <div className="flex flex-col gap-3">
            <h1 className="text-lg font-semibold">{t('publicBooking.chooseTime')}</h1>
            {selectedDate && <p className="text-sm text-text-secondary">{formatDate(selectedDate, locale as SupportedLocale, club.timezone, { day: 'numeric', month: 'long', year: 'numeric' })}</p>}

            {/* BOOKING ENGINE / AVAILABILITY directive section 3: duration
                is a real, separate choice from the 30-minute availability
                increment -- picking a duration re-queries
                get_public_field_available_starts server-side (see the
                timeSlotsRaw query above), it never re-slices a
                client-cached grid. Changing duration after a time was
                already picked clears the pick so the customer can't
                submit a stale start/duration pairing the server never
                actually validated together. */}
            <div className="flex flex-wrap gap-2">
              {DURATION_OPTIONS_MINUTES.map((mins) => (
                <button
                  key={mins}
                  type="button"
                  onClick={() => {
                    if (mins !== selectedDuration) {
                      setSelectedDuration(mins)
                      setSelectedTime(null)
                      setConflictSlot(null)
                    }
                  }}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                    mins === selectedDuration
                      ? 'border-accent bg-accent/10 text-accent-foreground'
                      : 'border-border bg-surface text-text-secondary hover:border-accent'
                  }`}
                >
                  {t(`publicBooking.durationOptions.${mins}`)}
                </button>
              ))}
            </div>

            {conflictSlot && (
              <div role="alert" className="rounded-lg border border-status-warning/40 bg-status-warning/5 p-3 text-sm text-status-warning">
                {t('publicBooking.slotConflictMessage')}
              </div>
            )}

            {isTodaySelected && (
              <div className="rounded-lg border border-info/30 bg-info/5 p-3 text-sm text-info">
                {t('publicBooking.todayContactExplainer')}
              </div>
            )}

            {/* HIGH-ROI UX PASS 01, supplementary item 18: the same-day
                contact card moved above the (possibly long) slot list --
                a customer in a hurry to reach the club right now no
                longer has to scroll past every remaining slot first.
                Not duplicated: this is the ONLY render of this card,
                just repositioned. */}
            {isTodaySelected && clubWaNumber && (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
                <p className="text-sm font-medium">{t('publicBooking.todayContactTitle')}</p>
                <p className="text-xs text-text-secondary">{t('publicBooking.todayRaceWarning')}</p>
                <div className="flex flex-wrap gap-2">
                  <Button asChild size="sm" variant="outline">
                    <a href={`tel:${clubWaNumber}`}>
                      <Phone className="me-1 size-4" /> {t('publicBooking.callClub')}
                    </a>
                  </Button>
                  <Button asChild size="sm">
                    <a
                      href={`https://wa.me/${toWaDigits(clubWaNumber)}?text=${encodeURIComponent(
                        t('publicBooking.todayWaMessage', {
                          club: club.clubName,
                          field: selectedField?.name ?? '',
                          date: selectedDate ? formatDate(selectedDate, locale as SupportedLocale, club.timezone, { day: 'numeric', month: 'long' }) : '',
                        }),
                      )}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <MessageCircle className="me-1 size-4" /> {t('publicBooking.whatsappClub')}
                    </a>
                  </Button>
                </div>
              </div>
            )}

            {availabilityLoading && <p className="text-sm text-text-secondary">{t('publicBooking.loading')}</p>}
            {!availabilityLoading && timeSlots.length === 0 && <p className="text-sm text-text-secondary">{t('publicBooking.noSlotsAvailable')}</p>}

            {!isTodaySelected && (
              <div className="grid grid-cols-3 gap-2">
                {timeSlots.map((s) => (
                  <button
                    key={s.time}
                    type="button"
                    disabled={!s.isAvailable}
                    className="rounded-lg border border-border bg-surface p-3 text-center text-sm font-medium tabular-nums shadow-sm transition hover:border-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border"
                    onClick={() => {
                      setConflictSlot(null)
                      setSelectedTime(s.time)
                      setStep('details')
                    }}
                  >
                    <bdi>{s.time}</bdi>
                    {!s.isAvailable && <span className="mt-0.5 block text-[10px] text-text-secondary">{t('publicBooking.unavailable')}</span>}
                  </button>
                ))}
              </div>
            )}

            {isTodaySelected && (
              <div className="flex flex-col gap-2">
                {timeSlots.map((s) => (
                  <div
                    key={s.time}
                    className={`flex items-center justify-between rounded-lg border p-3 text-sm ${s.isAvailable ? 'border-status-success/40 bg-status-success/5' : 'border-border bg-surface opacity-60'}`}
                  >
                    <span className="font-medium tabular-nums"><bdi>{s.time}</bdi></span>
                    {s.isAvailable ? (
                      <span className="text-xs font-medium text-status-success">{t('publicBooking.availableNow')}</span>
                    ) : (
                      <span className="text-xs text-text-secondary">{t('publicBooking.unavailable')}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {step === 'details' && !isTodaySelected && (
          <div className="flex flex-col gap-4">
            <h1 className="text-lg font-semibold">{t('publicBooking.yourDetails')}</h1>

            <div className="rounded-lg border border-border bg-surface p-4 text-sm">
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">{t('publicBooking.field')}</span>
                <span className="font-medium">{selectedField?.name}</span>
              </div>
              {selectedDate && (
                <div className="flex justify-between py-1">
                  <span className="text-text-secondary">{t('publicBooking.date')}</span>
                  <span className="font-medium">{formatDate(selectedDate, locale as SupportedLocale, club.timezone, { day: 'numeric', month: 'long' })}</span>
                </div>
              )}
              <div className="flex justify-between py-1">
                <span className="text-text-secondary">{t('publicBooking.time')}</span>
                <span className="font-medium tabular-nums"><bdi>{selectedTime}</bdi></span>
              </div>
              {price != null && (
                <div className="mt-1 flex justify-between border-t border-border pt-2 font-semibold">
                  <span>{t('publicBooking.total')}</span>
                  <span className="tabular-nums">{formatCurrency(price, locale as SupportedLocale, club.currency)}</span>
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('publicBooking.nameLabel')}</label>
              <Input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder={t('publicBooking.namePlaceholder')} />
            </div>
            {/* P0 phone identity directive: canonical E.164
                normalization via the shared PhoneInput/normalizePhone
                pipeline, defaulting to the club's own country
                (section 21), explicitly overridable per customer
                (section 6/39). This is client-side feedback only --
                create_public_booking() re-validates the E.164 value
                server-side regardless. */}
            <PhoneInput
              label={t('publicBooking.mobileLabel')}
              required
              value={{ raw: customerMobile, country: customerPhoneCountry }}
              onChange={(v) => {
                setCustomerMobile(v.raw)
                setCustomerPhoneCountry(v.country)
                setFormError(null)
              }}
              onValidChange={(r) => setPhoneValid(r.valid)}
            />
            <p className="-mt-1 text-xs text-text-secondary">{t('publicBooking.mobileHelper')}</p>

            {/* Email stays OPTIONAL -- product decision, do not make this
                required. Explaining what providing it unlocks (and what
                skipping it costs) so the customer can make an informed
                choice, without pressuring them. */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('publicBooking.emailLabel')}</label>
              <Input
                type="email"
                autoComplete="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                placeholder={t('publicBooking.emailPlaceholder')}
                dir="ltr"
              />
              <p className="text-xs text-text-secondary">{t('publicBooking.emailHelper')}</p>
            </div>

            {formError && <p role="alert" className="text-sm text-status-danger">{formError}</p>}

            <Button
              className="w-full"
              disabled={
                !customerName.trim() ||
                !customerMobile.trim() ||
                !phoneValid ||
                (!!customerEmail.trim() && !isPlausibleEmail(customerEmail)) ||
                bookMutation.isPending
              }
              onClick={() => bookMutation.mutate()}
            >
              {bookMutation.isPending ? t('publicBooking.booking') : t('publicBooking.confirmBooking')}
            </Button>
          </div>
        )}

        {step === 'confirmed' && (
          <div className="flex flex-col gap-5">
            <div className="flex flex-col items-center gap-2 text-center">
              <CheckCircle2 className="size-14 text-status-success" />
              <h1 className="text-lg font-semibold">{t('publicBooking.confirmedTitle')}</h1>
              <p className="text-sm text-text-secondary">{t('publicBooking.confirmedMessage')}</p>
              {confirmedRef && (
                <p className="text-sm">
                  {t('publicBooking.bookingRef')}: <bdi className="font-medium">{confirmedRef}</bdi>
                </p>
              )}
              {confirmedTotal != null && (
                <p className="text-sm font-semibold">{formatCurrency(confirmedTotal, locale as SupportedLocale, club.currency)}</p>
              )}
            </div>

            {confirmedHoldExpiresAt && (
              <HoldCountdown holdExpiresAt={confirmedHoldExpiresAt} />
            )}

            {/* FINAL ACCEPTANCE CLOSURE (2026-08-29): the primary,
                reliable path to the booking/entry-code page -- does not
                depend on WhatsApp or email delivery succeeding, unlike
                the notification-only channels below. Rendered directly
                from the token this page's own browser just received in
                the booking-creation response, linking to the existing,
                already-secured /qr/:token page. Prominent placement
                (right after the reference number, before the calendar/
                payment panels) since this is now the one guaranteed way
                every customer can reach their credential. */}
            {confirmedQrToken && (
              <Button asChild size="lg" className="w-full">
                <a href={`/qr/${confirmedQrToken}`}>
                  {t('publicBooking.viewBookingAndEntryCode')}
                </a>
              </Button>
            )}

            {/* HIGH-ROI UX PASS 01, item 19: a plain .ics download for
                the just-created booking -- low cost, reduces no-shows.
                No payment secrets/tokens in the description, per the
                directive. dateKey/selectedTime are still the values
                that were just submitted (this step only renders right
                after a successful mutation, before either could change). */}
            {selectedField && dateKey && selectedTime && (
              <Button asChild size="sm" variant="outline" className="w-fit self-center">
                <a
                  href={buildIcsDataUri({
                    clubName: club.clubName,
                    fieldName: selectedField.name,
                    address: club.address,
                    startAt: new Date(`${dateKey}T${selectedTime}:00`),
                    endAt: new Date(new Date(`${dateKey}T${selectedTime}:00`).getTime() + selectedDuration * 60000),
                    bookingRef: confirmedRef,
                  })}
                  download={`${confirmedRef ?? 'booking'}.ics`}
                >
                  <CalendarPlus className="me-1 size-4" /> {t('publicBooking.addToCalendar')}
                </a>
              </Button>
            )}

            {confirmedBookingId && (
              <PaymentMethodsPanel
                bookingId={confirmedBookingId}
                clubId={club.clubId}
                bookingRef={confirmedRef}
                clubName={club.clubName}
                total={confirmedTotal}
                currency={club.currency}
                locale={locale as SupportedLocale}
              />
            )}

            {(club.primaryPhone || clubWaNumber || club.address) && (
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
                <p className="text-sm font-medium">{t('publicBooking.contactClubTitle')}</p>
                {club.primaryPhone && (
                  <div className="flex items-center justify-between text-sm">
                    <span dir="ltr" className="tabular-nums">{club.primaryPhone}</span>
                    <div className="flex gap-1">
                      <Button asChild size="sm" variant="ghost">
                        <a href={`tel:${club.primaryPhone}`} aria-label={t('publicBooking.callClub')}><Phone className="size-4" /></a>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => copyToClipboard(club.primaryPhone!, 'club-phone')}
                        aria-label={t('publicBooking.copyPhoneNumber')}
                      >
                        {copiedField === 'club-phone' ? <Check className="size-4" /> : <Copy className="size-4" />}
                      </Button>
                    </div>
                  </div>
                )}
                {clubWaNumber && (
                  <Button asChild size="sm" variant="outline" className="w-fit">
                    <a href={`https://wa.me/${toWaDigits(clubWaNumber)}`} target="_blank" rel="noreferrer">
                      <MessageCircle className="me-1 size-4" /> {t('publicBooking.whatsappClub')}
                    </a>
                  </Button>
                )}
                {club.address && (
                  <p className="text-xs text-text-secondary">{club.address}</p>
                )}
                {club.mapsUrl && (
                  <a href={club.mapsUrl} target="_blank" rel="noreferrer" className="text-xs text-accent-foreground underline">
                    {t('publicBooking.directions')}
                  </a>
                )}
              </div>
            )}

            {/* FINAL ACCEPTANCE CLOSURE (2026-08-29): reworded from an
                unconditional "check WhatsApp for your link and code"
                promise -- WhatsApp delivery silently no-ops when the
                club's account is disconnected (queue_whatsapp_notification()),
                so that copy could leave a customer with no working
                instructions at all. Now describes WhatsApp/email as an
                additional copy of what the button above already
                guarantees, not the only path to it. */}
            <p className="text-center text-xs text-text-secondary">{t('publicBooking.whatsappHintSupplementary')}</p>

            {/* Confirmed gap fix: the confirmation screen previously never
                mentioned that a self-service account/portal exists at all
                (see claim_customer_self_service() /
                customers.user_id -- My Bookings, My Subscriptions, etc).
                This is a short, informational note only -- no new CTA/flow
                is invented here; it just tells the customer, at the one
                moment they'd care most, that providing an email (above,
                still optional) is what would let them access that portal
                later. Only shown when an email was actually provided this
                time, since that's the precondition for future access.
                FINAL PRODUCT COMPLETENESS ROUND (2026-08-25) -- Customer
                persona: this note was informational text only, with no
                actual link -- a customer who wanted to act on it had
                nowhere to click. /login is the safe target (its own
                post-auth logic already correctly routes a linked customer
                to /portal, unchanged here; an unlinked one lands on the
                portal's claim screen, also already correct). */}
            {customerEmail.trim() && (
              <p className="text-center text-xs text-text-secondary">
                {t('publicBooking.accountAwarenessNote')}{' '}
                <Link to="/login" className="text-accent-foreground hover:underline">
                  {t('publicBooking.accountAwarenessLink')}
                </Link>
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
