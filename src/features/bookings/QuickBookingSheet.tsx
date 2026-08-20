import { useEffect, useMemo, useState } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { WhatsappConsentQuestion, type WhatsappConsentAnswer } from '@/components/ui/whatsapp-consent-question'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useResolvedFieldPrice, useClubTimezone } from './useFieldPricing'
import { toInstant } from '@/lib/domain/time'
import { useDirection } from '@/app/providers/DirectionProvider'
import { normalizePhone } from '@/lib/domain/phone'
import { useOfficialReceipt, OfficialCollectionReceiptFields, translateReceiptError } from '@/components/ui/official-collection-receipt-fields'
import { PAYMENT_METHOD_LABELS } from '@/lib/domain/billing'

// Section E3 — Quick Booking: a right-side drawer opened from an empty
// calendar slot. Price is ALWAYS server-resolved (resolve_field_price)
// and shown before confirmation -- never guessed client-side.

export interface QuickBookingSlot {
  fieldId: string
  fieldName: string
  branchId: string
  date: string // YYYY-MM-DD
  startTime: string // HH:MM
}

interface Customer {
  id: string
  full_name: string
  mobile_display: string | null
}

async function fetchCustomers(clubId: string, search: string) {
  let query = supabase.from('customers').select('id, full_name, mobile_display').eq('club_id', clubId).order('full_name').limit(50)
  if (search.trim()) {
    query = query.or(`full_name.ilike.%${search}%,normalized_mobile.ilike.%${search}%,mobile_display.ilike.%${search}%`)
  }
  const { data, error } = await query
  if (error) throw error
  return (data ?? []) as Customer[]
}

async function fetchClubCountry(clubId: string): Promise<CountryCode | null> {
  const { data, error } = await supabase.from('clubs').select('country').eq('id', clubId).single()
  if (error) return null
  return (data?.country as CountryCode | null) ?? null
}

function legacyNormalize(input: string): string {
  return input.replace(/\D/g, '').replace(/^0+/, '')
}

const DURATION_VALUES = ['0.5', '1', '1.5', '2', '3'] as const

export function QuickBookingSheet({
  slot,
  clubId,
  onOpenChange,
  onCreated,
  preselectedCustomer,
}: {
  slot: QuickBookingSlot | null
  clubId: string
  onOpenChange: (open: boolean) => void
  onCreated: () => void
  // Customer 360 directive section 13: "New Booking" from a customer's
  // profile must land here with the customer already selected -- staff
  // must never re-search/re-select. Only the identity is passed in
  // (not trusted display data) so the sheet still fetches its own
  // customer row and can't be tricked by a stale/forged URL param.
  preselectedCustomer?: { id: string; name: string } | null
}) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const queryClient = useQueryClient()
  const { data: clubTimezone } = useClubTimezone(clubId)
  const [customerId, setCustomerId] = useState('')
  const [customerSearch, setCustomerSearch] = useState('')
  const [duration, setDuration] = useState('1')
  const [payNow, setPayNow] = useState(true)
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [formError, setFormError] = useState<string | null>(null)
  const [showNewCustomer, setShowNewCustomer] = useState(false)
  const [newCustomerName, setNewCustomerName] = useState('')
  const [newCustomerMobile, setNewCustomerMobile] = useState('')
  const [newCustomerMobileCountry, setNewCustomerMobileCountry] = useState<CountryCode>('EG')
  const [newCustomerPhoneValid, setNewCustomerPhoneValid] = useState(false)
  const [duplicateCustomer, setDuplicateCustomer] = useState<{ id: string; full_name: string } | null>(null)
  // Correction: creating a customer record is never itself consent --
  // staff must explicitly ask and record the real answer.
  const [newCustomerWhatsappConsent, setNewCustomerWhatsappConsent] = useState<WhatsappConsentAnswer>(null)

  const { data: clubCountry } = useQuery({
    queryKey: ['club-country', clubId],
    queryFn: () => fetchClubCountry(clubId),
    enabled: !!clubId,
  })
  // Gate 5 — recurring bookings: create_recurring_booking() already
  // existed server-side (delegates to the same, already-fixed
  // _create_booking_internal per occurrence) but had no frontend caller
  // at all. Wired here rather than as a separate screen since the
  // slot/time/customer selection is identical to a single booking.
  const [isRecurring, setIsRecurring] = useState(false)
  const [occurrenceCount, setOccurrenceCount] = useState('8')
  const [recurringResult, setRecurringResult] = useState<{ created: number; requested: number; conflicted: string[] } | null>(null)

  // Government / Ministry Collection Compliance -- Phase B: "pay now"
  // is the create-time equivalent of BookingDetailSheet's collect-
  // existing-balance form, so it uses the exact same shared hook.
  // Recurring bookings never take an upfront payment (see
  // create_recurring_booking's own signature below), so this only ever
  // matters for the single-booking path.
  const receipt = useOfficialReceipt({
    clubId,
    branchId: slot?.branchId,
    fieldId: slot?.fieldId,
    method: paymentMethod,
    enabled: !!slot && payNow,
  })

  const [customerLocked, setCustomerLocked] = useState(false)

  useEffect(() => {
    if (!slot) {
      setCustomerId('')
      setCustomerSearch('')
      setCustomerLocked(false)
      setDuration('1')
      setPayNow(true)
      setPaymentMethod('cash')
      setFormError(null)
      setShowNewCustomer(false)
      setNewCustomerName('')
      setNewCustomerMobile('')
      setNewCustomerMobileCountry((clubCountry as CountryCode) ?? 'EG')
      setDuplicateCustomer(null)
      setNewCustomerWhatsappConsent(null)
      setIsRecurring(false)
      setOccurrenceCount('8')
      setRecurringResult(null)
      receipt.reset()
    } else if (preselectedCustomer) {
      setCustomerId(preselectedCustomer.id)
      setCustomerLocked(true)
    }
  }, [slot])

  const durations = DURATION_VALUES.map((value) => ({ value, label: t(`bookings.quick.durations.${value}`) }))

  const { data: customers = [] } = useQuery({
    queryKey: ['customers-search', clubId, customerSearch],
    queryFn: () => fetchCustomers(clubId, customerSearch),
    enabled: !!clubId && !!slot,
  })

  const endTime = useMemo(() => {
    if (!slot) return null
    const [h, m] = slot.startTime.split(':').map(Number)
    const totalMinutes = (h ?? 0) * 60 + (m ?? 0) + Number(duration) * 60
    const endH = Math.floor(totalMinutes / 60) % 24
    const endM = totalMinutes % 60
    return `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`
  }, [slot, duration])

  const { data: resolvedPrice, isLoading: priceLoading } = useResolvedFieldPrice(
    slot?.fieldId ?? null,
    slot?.date ?? null,
    slot?.startTime ? `${slot.startTime}:00` : null,
    endTime ? `${endTime}:00` : null,
  )

  const createCustomerMutation = useMutation({
    mutationFn: async () => {
      // P0 Phone Identity directive fix: this previously wrote
      // newCustomerMobile completely raw into BOTH mobile_display and
      // normalized_mobile -- the weakest phone-write path in the
      // codebase (not even the old digit-strip cleanup). Now runs
      // through the same normalizePhone() pipeline as every other
      // customer-creation surface, and checks for a tenant-scoped
      // duplicate before creating (directive section 24/29/31).
      let phoneE164: string | null = null
      if (newCustomerMobile.trim()) {
        const result = normalizePhone(newCustomerMobile, newCustomerMobileCountry)
        if (!result.valid || !result.e164) {
          throw new Error(t('phoneInput.invalidError'))
        }
        phoneE164 = result.e164

        const { data: existing } = await supabase
          .from('customers')
          .select('id, full_name')
          .eq('club_id', clubId)
          .eq('phone_e164', phoneE164)
          .limit(1)
          .maybeSingle()
        if (existing) {
          throw { isDuplicate: true, customer: existing }
        }
      }

      const { data, error } = await supabase
        .from('customers')
        .insert({
          club_id: clubId,
          full_name: newCustomerName,
          mobile_display: newCustomerMobile || null,
          normalized_mobile: newCustomerMobile ? legacyNormalize(newCustomerMobile) : null,
          phone_e164: phoneE164,
        })
        .select('id, full_name, mobile_display')
        .single()
      if (error) throw error

      // Correction: creating a customer record is never itself
      // consent. This RPC only writes a decision when staff have
      // actually asked the customer and recorded a real yes/no answer.
      if (phoneE164 && data && newCustomerWhatsappConsent !== null) {
        const { error: consentError } = await supabase.rpc('record_staff_whatsapp_consent', {
          p_club_id: clubId,
          p_customer_id: data.id,
          p_consented: newCustomerWhatsappConsent,
          p_phone_display: newCustomerMobile,
          p_normalized_phone: legacyNormalize(newCustomerMobile),
        })
        if (consentError) throw consentError
      }

      return data
    },
    onSuccess: (data) => {
      setCustomerId(data.id)
      setShowNewCustomer(false)
      setDuplicateCustomer(null)
      setNewCustomerWhatsappConsent(null)
      void queryClient.invalidateQueries({ queryKey: ['customers-search', clubId] })
    },
    onError: (error: unknown) => {
      if (error && typeof error === 'object' && 'isDuplicate' in error) {
        setDuplicateCustomer((error as unknown as { customer: { id: string; full_name: string } }).customer)
        return
      }
      setFormError(error instanceof Error && error.message ? error.message : t('bookings.quick.addCustomerError'))
    },
  })

  const bookMutation = useMutation({
    mutationFn: async () => {
      if (!slot || !customerId) throw new Error('missing input')
      if (!clubTimezone) throw new Error('club timezone not loaded')
      // Gate 1 fix: slot.date/slot.startTime/endTime are venue-local wall-
      // clock values as the user picked them on the calendar. They must
      // be converted through the venue's real IANA timezone into an
      // absolute instant before being sent as a timestamptz RPC param —
      // a naive "date+Ttime+:00" string here was the root cause of the
      // ~2-3h storage drift bug (see src/lib/domain/time.ts).
      const startAt = toInstant(slot.date, slot.startTime, clubTimezone)
      const endAt = toInstant(slot.date, endTime!, clubTimezone)

      if (isRecurring) {
        // Recurring bookings never accept an upfront payment here (each
        // occurrence would need its own payment decision) -- matches
        // create_recurring_booking()'s own signature, which has no
        // payment params at all; each created occurrence lands as
        // 'pending_payment', same as any other new booking.
        const { data, error } = await supabase.rpc('create_recurring_booking', {
          p_field_id: slot.fieldId,
          p_customer_id: customerId,
          p_first_start_at: startAt,
          p_first_end_at: endAt,
          p_occurrence_count: Number(occurrenceCount),
          p_interval_days: 7,
        })
        if (error) throw error
        const row = data?.[0]
        setRecurringResult({
          created: row?.created ?? 0,
          requested: row?.requested ?? Number(occurrenceCount),
          conflicted: (row?.conflicted_occurrences ?? []) as string[],
        })
        return
      }

      // Government / Ministry Collection Compliance -- Phase B: the
      // client-side receipt.isValid gate (see the confirm button below)
      // is a convenience, not the enforcement boundary -- create_booking()
      // itself raises if the effective policy requires a receipt for
      // paymentMethod and none/an invalid one was supplied. create_booking()
      // creates the invoice AND payment in the same transaction as the
      // booking, so it takes the raw receipt fields directly and inserts
      // the receipt row itself once the real payment amount is known --
      // there's no pre-existing receipt id a client could supply here.
      const receiptPayload = payNow ? receipt.getPayload() : null

      const { error } = await supabase.rpc('create_booking', {
        p_field_id: slot.fieldId,
        p_customer_id: customerId,
        p_start_at: startAt,
        p_end_at: endAt,
        p_record_payment: payNow,
        p_payment_amount: payNow ? resolvedPrice ?? undefined : undefined,
        p_payment_method: payNow ? paymentMethod : undefined,
        ...(receiptPayload ?? {}),
      })
      if (error) throw error
    },
    onSuccess: () => {
      onCreated()
      receipt.reset()
      // A recurring booking shows its own result summary (created vs.
      // conflicted occurrences) instead of closing immediately -- the
      // outcome ("6 of 8 created, 2 conflicted") is exactly the kind of
      // partial-success information a single-booking close-and-forget
      // flow would hide.
      if (!isRecurring) {
        onOpenChange(false)
      }
    },
    onError: (error) => {
      const message = error instanceof Error && !('code' in error) ? error.message : translateSupabaseError(error, t('bookings.quick.createError'))
      setFormError(translateReceiptError(message, t, message))
    },
  })

  return (
    <Sheet open={!!slot} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('bookings.quick.title')}</SheetTitle>
          {slot && (
            <SheetDescription>
              {slot.fieldName} — {new Date(slot.date).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG', { weekday: 'long', day: 'numeric', month: 'long' })}
            </SheetDescription>
          )}
        </SheetHeader>

        {slot && (
          <div className="flex flex-1 flex-col gap-5 py-4">
            {/* Field / Date / Time summary */}
            <div className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <div>
                <p className="text-xs text-text-secondary">{t('bookings.quick.field')}</p>
                <p className="font-medium">{slot.fieldName}</p>
              </div>
              <div>
                <p className="text-xs text-text-secondary">{t('bookings.quick.time')}</p>
                {/* Same RTL bidi-swap risk as StatCard's composite values
                    (owner-level review finding). */}
                <p className="font-medium tabular-nums"><bdi>{slot.startTime} — {endTime}</bdi></p>
              </div>
            </div>

            {/* Duration */}
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('bookings.quick.duration')}</label>
              <Select value={duration} onValueChange={setDuration}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {durations.map((d) => (
                    <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Customer */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium text-text-secondary">{t('bookings.quick.customer')}</label>
                {!customerLocked && (
                  <button type="button" className="text-xs text-accent hover:underline" onClick={() => setShowNewCustomer((v) => !v)}>
                    {showNewCustomer ? t('bookings.quick.chooseExistingCustomer') : t('bookings.quick.newCustomer')}
                  </button>
                )}
              </div>
              {customerLocked && preselectedCustomer ? (
                <div className="flex items-center justify-between rounded-md border border-accent/30 bg-accent/5 p-2 text-sm">
                  <span className="font-medium">{preselectedCustomer.name}</span>
                  <button type="button" className="text-xs text-accent hover:underline" onClick={() => { setCustomerLocked(false); setCustomerId('') }}>
                    {t('bookings.quick.changeCustomer', { defaultValue: 'Change' })}
                  </button>
                </div>
              ) : showNewCustomer ? (
                <div className="flex flex-col gap-2 rounded-md border border-border p-2">
                  <Input placeholder={t('bookings.quick.namePlaceholder')} value={newCustomerName} onChange={(e) => setNewCustomerName(e.target.value)} />
                  <PhoneInput
                    label={t('bookings.quick.mobilePlaceholder')}
                    value={{ raw: newCustomerMobile, country: newCustomerMobileCountry }}
                    onChange={(v) => {
                      setNewCustomerMobile(v.raw)
                      setNewCustomerMobileCountry(v.country)
                      setDuplicateCustomer(null)
                    }}
                    onValidChange={(r) => setNewCustomerPhoneValid(r.valid)}
                  />
                  {newCustomerMobile.trim() && newCustomerPhoneValid && (
                    <WhatsappConsentQuestion value={newCustomerWhatsappConsent} onChange={setNewCustomerWhatsappConsent} />
                  )}
                  {duplicateCustomer && (
                    <div className="flex flex-col gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-2 text-xs">
                      <p>{t('phoneInput.duplicateCustomer')} ({duplicateCustomer.full_name})</p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setCustomerId(duplicateCustomer.id)
                          setShowNewCustomer(false)
                          setDuplicateCustomer(null)
                        }}
                      >
                        {t('phoneInput.useExisting')}
                      </Button>
                    </div>
                  )}
                  <Button
                    size="sm"
                    disabled={
                      !newCustomerName.trim() ||
                      (newCustomerMobile.trim().length > 0 && !newCustomerPhoneValid) ||
                      (newCustomerMobile.trim().length > 0 && newCustomerPhoneValid && newCustomerWhatsappConsent === null) ||
                      createCustomerMutation.isPending
                    }
                    onClick={() => createCustomerMutation.mutate()}
                  >
                    {createCustomerMutation.isPending ? t('bookings.quick.adding') : t('bookings.quick.addCustomer')}
                  </Button>
                </div>
              ) : (
                <>
                  <Input placeholder={t('bookings.quick.searchPlaceholder')} value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} />
                  <Select value={customerId} onValueChange={setCustomerId}>
                    <SelectTrigger><SelectValue placeholder={t('bookings.quick.chooseCustomerPlaceholder')} /></SelectTrigger>
                    <SelectContent>
                      {customers.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.full_name}{c.mobile_display ? ` — ${c.mobile_display}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </>
              )}
            </div>

            {/* Price -- server resolved, always visible before confirmation */}
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
              {priceLoading ? (
                <p className="text-sm text-text-secondary">{t('bookings.quick.calculatingPrice')}</p>
              ) : resolvedPrice != null ? (
                <div className="flex flex-col gap-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-text-secondary">{t('bookings.quick.pricePerHour')}</span>
                    <span className="tabular-nums">{(resolvedPrice / Number(duration)).toFixed(0)} {t('common.currency')}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-text-secondary">{t('bookings.quick.duration')}</span>
                    <span className="tabular-nums">{t('bookings.quick.duration_hours', { count: Number(duration) })}</span>
                  </div>
                  <div className="mt-1 flex justify-between border-t border-accent/20 pt-1 font-semibold">
                    <span>{isRecurring ? t('bookings.quick.pricePerBooking') : t('bookings.quick.total')}</span>
                    <span className="tabular-nums">{resolvedPrice.toFixed(0)} {t('common.currency')}</span>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-status-danger">{t('bookings.quick.priceError')}</p>
              )}
            </div>

            {/* Recurring booking -- Gate 5: create_recurring_booking()
                already existed server-side (same field/time/customer
                every week for N occurrences) but had no UI. Each
                occurrence is billed/paid separately as it happens, same
                as any regular booking -- no upfront bulk payment here. */}
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input type="checkbox" checked={isRecurring} onChange={(e) => setIsRecurring(e.target.checked)} className="size-4" />
                {t('bookings.quick.recurringWeekly')}
              </label>
              {isRecurring && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs text-text-secondary">{t('bookings.quick.occurrenceCount')}</label>
                  <Input
                    type="number"
                    min={1}
                    max={52}
                    value={occurrenceCount}
                    onChange={(e) => setOccurrenceCount(e.target.value)}
                  />
                  <p className="text-xs text-text-secondary">
                    {t('bookings.quick.recurringHint')}
                  </p>
                </div>
              )}
            </div>

            {/* Payment -- not applicable to recurring bookings (each
                occurrence is settled on its own later, same as any
                pending_payment booking created elsewhere). */}
            {!isRecurring && (
              <div className="flex flex-col gap-2">
                <label className="text-sm font-medium text-text-secondary">{t('bookings.quick.payment')}</label>
                <div className="flex gap-2">
                  <Button type="button" variant={payNow ? 'default' : 'outline'} size="sm" onClick={() => setPayNow(true)}>
                    {t('bookings.quick.payNow')}
                  </Button>
                  <Button type="button" variant={!payNow ? 'default' : 'outline'} size="sm" onClick={() => setPayNow(false)}>
                    {t('bookings.quick.awaitingPayment')}
                  </Button>
                </div>
                {payNow && (
                  <>
                    {/* Phase B fix: this previously used 'transfer' as
                        the bank-transfer value, but every other
                        surface (record_payment's own check constraint,
                        PAYMENT_METHOD_LABELS, government policy's
                        required_payment_methods) uses 'bank_transfer'.
                        A government-required-receipt policy covering
                        bank transfers would have silently never matched
                        here, and the value would have been semantically
                        wrong even where no policy applied. Also adds
                        the two methods this Select was missing
                        entirely (wallet/other) so every method staff
                        can select elsewhere is selectable here too. */}
                    <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>{t(`common.paymentMethodLabels.${value}`, { defaultValue: label })}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <OfficialCollectionReceiptFields state={receipt} />
                  </>
                )}
              </div>
            )}

            {recurringResult && (
              <div className="rounded-lg border border-status-info/30 bg-status-info/5 p-3 text-sm">
                <p className="font-medium">
                  {t('bookings.quick.recurringSummary', { created: recurringResult.created, requested: recurringResult.requested })}
                </p>
                {recurringResult.conflicted.length > 0 && (
                  <p className="mt-1 text-status-warning">
                    {t('bookings.quick.recurringConflicts', { count: recurringResult.conflicted.length })}
                  </p>
                )}
                <Button size="sm" className="mt-2" onClick={() => onOpenChange(false)}>{t('bookings.quick.done')}</Button>
              </div>
            )}

            {formError && <p role="alert" className="text-sm text-status-danger">{formError}</p>}
          </div>
        )}

        <SheetFooter>
          <Button
            className="w-full"
            disabled={!customerId || !resolvedPrice || !clubTimezone || bookMutation.isPending || !!recurringResult || (isRecurring && (!occurrenceCount || Number(occurrenceCount) < 1 || Number(occurrenceCount) > 52)) || (payNow && !isRecurring && !receipt.isValid)}
            onClick={() => bookMutation.mutate()}
          >
            {bookMutation.isPending ? t('bookings.quick.booking') : isRecurring ? t('bookings.quick.confirmRecurring') : t('bookings.quick.confirmBooking')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
