import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { formatCurrency, formatDate, type SupportedLocale } from '@/lib/i18n/config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CheckCircle2, MapPin, ChevronLeft, ChevronRight, Phone, MessageCircle, Copy, Check } from 'lucide-react'
import { PaymentMethodsPanel } from './PaymentMethodsPanel'
import { HoldCountdown } from './HoldCountdown'

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

interface Availability {
  openTime: string | null
  closeTime: string | null
  hasAnyConfig: boolean
  busyRanges: Array<{ start_at: string; end_at: string }>
}

async function fetchAvailability(fieldId: string, date: string): Promise<Availability> {
  const { data, error } = await supabase.rpc('get_public_field_availability', { p_field_id: fieldId, p_date: date })
  if (error) throw error
  const row = data?.[0]
  return {
    openTime: row?.open_time ?? null,
    closeTime: row?.close_time ?? null,
    hasAnyConfig: row?.has_any_config ?? false,
    busyRanges: (row?.busy_ranges ?? []) as Array<{ start_at: string; end_at: string }>,
  }
}

const DURATION_MINUTES = 60

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

export function PublicClubBookingPage() {
  const { slug } = useParams<{ slug: string }>()
  const { t } = useTranslation()
  const { direction, locale } = useDirection()

  const [step, setStep] = useState<Step>('field')
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState<Date | null>(null)
  const [selectedTime, setSelectedTime] = useState<string | null>(null)
  const [customerName, setCustomerName] = useState('')
  const [customerMobile, setCustomerMobile] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [confirmedRef, setConfirmedRef] = useState<string | null>(null)
  const [confirmedBookingId, setConfirmedBookingId] = useState<string | null>(null)
  const [confirmedHoldExpiresAt, setConfirmedHoldExpiresAt] = useState<string | null>(null)
  const [confirmedTotal, setConfirmedTotal] = useState<number | null>(null)
  const [copiedField, setCopiedField] = useState<string | null>(null)

  const { data: club, isLoading: clubLoading, isError: clubError } = useQuery({
    queryKey: ['public-club', slug],
    queryFn: () => fetchPublicClub(slug!),
    enabled: !!slug,
    retry: false,
  })

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

  const { data: availability, isLoading: availabilityLoading } = useQuery({
    queryKey: ['public-field-availability', selectedFieldId, dateKey],
    queryFn: () => fetchAvailability(selectedFieldId!, dateKey!),
    enabled: !!selectedFieldId && !!dateKey && (step === 'time' || step === 'date'),
  })

  const { data: price } = useQuery({
    queryKey: ['public-field-price', selectedFieldId, dateKey, selectedTime],
    queryFn: async () => {
      const [h, m] = selectedTime!.split(':').map(Number)
      const endMinutes = (h ?? 0) * 60 + (m ?? 0) + DURATION_MINUTES
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
    if (!availability?.hasAnyConfig || !availability.openTime || !availability.closeTime || !dateKey) return []
    const slots: Array<{ time: string; isAvailable: boolean }> = []
    const [openH, openM] = availability.openTime.split(':').map(Number)
    const [closeH, closeM] = availability.closeTime.split(':').map(Number)
    let cursor = (openH ?? 0) * 60 + (openM ?? 0)
    const end = (closeH ?? 0) * 60 + (closeM ?? 0)
    const now = new Date()
    while (cursor + DURATION_MINUTES <= end) {
      const h = Math.floor(cursor / 60)
      const m = cursor % 60
      const slotStart = new Date(`${dateKey}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`)
      const slotEnd = new Date(slotStart.getTime() + DURATION_MINUTES * 60000)
      const isPast = slotStart <= now
      const isBusy = availability.busyRanges.some((r) => new Date(r.start_at) < slotEnd && new Date(r.end_at) > slotStart)
      // TODAY slots that are past or busy are simply omitted (matches
      // future-day behavior) -- what differs for today is the CTA shown
      // per remaining slot (contact, not online booking), handled at
      // render time via isTodaySelected, not here.
      if (!isPast) {
        slots.push({ time: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, isAvailable: !isBusy })
      }
      cursor += DURATION_MINUTES
    }
    return slots
  }, [availability, dateKey])

  const bookMutation = useMutation({
    mutationFn: async () => {
      if (!slug || !selectedFieldId || !dateKey || !selectedTime) throw new Error('missing input')
      const [h, m] = selectedTime.split(':').map(Number)
      const endMinutes = (h ?? 0) * 60 + (m ?? 0) + DURATION_MINUTES
      const endTime = `${String(Math.floor(endMinutes / 60) % 24).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`
      const startAt = new Date(`${dateKey}T${selectedTime}:00`).toISOString()
      const endAt = new Date(`${dateKey}T${endTime}:00`).toISOString()

      const { data, error } = await supabase.rpc('create_public_booking', {
        p_club_slug: slug,
        p_field_id: selectedFieldId,
        p_start_at: startAt,
        p_end_at: endAt,
        p_customer_name: customerName.trim(),
        p_customer_mobile: customerMobile.trim(),
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
      setStep('confirmed')
    },
    onError: (error: { message?: string }) => {
      setFormError(error?.message ?? t('publicBooking.genericError'))
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
        <div className="mx-auto flex max-w-lg items-center gap-3">
          {club.logoUrl && <img src={club.logoUrl} alt={club.clubName} className="size-10 rounded-full object-cover" />}
          <div>
            <p className="font-semibold">{club.clubName}</p>
            {selectedBranch && <p className="text-xs text-text-secondary">{selectedBranch.name}</p>}
          </div>
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

            {isTodaySelected && (
              <div className="rounded-lg border border-info/30 bg-info/5 p-3 text-sm text-info">
                {t('publicBooking.todayContactExplainer')}
              </div>
            )}

            {availabilityLoading && <p className="text-sm text-text-secondary">{t('publicBooking.loading')}</p>}
            {!availabilityLoading && timeSlots.length === 0 && <p className="text-sm text-text-secondary">{t('publicBooking.noSlotsAvailable')}</p>}

            {!isTodaySelected && (
              <div className="grid grid-cols-3 gap-2">
                {timeSlots.filter((s) => s.isAvailable).map((s) => (
                  <button
                    key={s.time}
                    type="button"
                    className="rounded-lg border border-border bg-surface p-3 text-center text-sm font-medium tabular-nums shadow-sm transition hover:border-accent"
                    onClick={() => {
                      setSelectedTime(s.time)
                      setStep('details')
                    }}
                  >
                    <bdi>{s.time}</bdi>
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
                {clubWaNumber && (
                  <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border bg-surface p-4">
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
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('publicBooking.mobileLabel')}</label>
              <Input value={customerMobile} onChange={(e) => setCustomerMobile(e.target.value)} placeholder={t('publicBooking.mobilePlaceholder')} dir="ltr" />
            </div>

            {formError && <p role="alert" className="text-sm text-status-danger">{formError}</p>}

            <Button
              className="w-full"
              disabled={!customerName.trim() || !customerMobile.trim() || bookMutation.isPending}
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
                        <a href={`tel:${club.primaryPhone}`}><Phone className="size-4" /></a>
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => copyToClipboard(club.primaryPhone!, 'club-phone')}>
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

            <p className="text-center text-xs text-text-secondary">{t('publicBooking.whatsappHint')}</p>
          </div>
        )}
      </main>
    </div>
  )
}
