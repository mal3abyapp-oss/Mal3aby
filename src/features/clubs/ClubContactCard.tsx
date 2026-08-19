import { useEffect, useState } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { translateSupabaseError } from '@/lib/errors'
import { normalizePhone } from '@/lib/domain/phone'
import { COUNTRY_OPTIONS } from '@/components/ui/phone-input'

/**
 * ClubContactCard -- directive Part IV: club-owned contact details
 * (primary/secondary phone, WhatsApp, payment-receipt WhatsApp, email,
 * address, maps link). Deliberately a plain `clubs` table
 * select/update (same pattern as ClubSettingsCard, which already
 * writes club_name/currency/timezone directly) -- these columns are
 * covered by the SAME existing clubs RLS write policy that already
 * lets a club owner/manager edit their own club, no new RPC needed.
 * This is the club's OWN contact data -- never Mal3aby's platform
 * contact (that lives in platform_settings, read via
 * get_platform_contact(), and is never written from this screen).
 *
 * P0 Phone Identity directive: also the home of the club's DEFAULT
 * COUNTRY setting (section 4) -- the one place an admin sets the
 * country used to interpret locally-formatted phone numbers entered
 * anywhere else at this club. Phone fields here store canonical
 * phone_e164 alongside the existing display columns.
 */
interface ClubContact {
  country: CountryCode | null
  primaryPhone: string
  primaryPhoneE164: string | null
  secondaryPhone: string
  whatsappNumber: string
  whatsappNumberE164: string | null
  paymentReceiptWhatsappNumber: string
  paymentReceiptWhatsappNumberE164: string | null
  contactEmail: string
  address: string
  mapsUrl: string
}

async function fetchContact(clubId: string): Promise<ClubContact> {
  const { data, error } = await supabase
    .from('clubs')
    .select('country, primary_phone, primary_phone_e164, secondary_phone, whatsapp_number, whatsapp_number_e164, payment_receipt_whatsapp_number, payment_receipt_whatsapp_number_e164, contact_email, address, maps_url')
    .eq('id', clubId)
    .single()
  if (error) throw error
  return {
    country: (data.country as CountryCode | null) ?? null,
    primaryPhone: data.primary_phone ?? '',
    primaryPhoneE164: data.primary_phone_e164 ?? null,
    secondaryPhone: data.secondary_phone ?? '',
    whatsappNumber: data.whatsapp_number ?? '',
    whatsappNumberE164: data.whatsapp_number_e164 ?? null,
    paymentReceiptWhatsappNumber: data.payment_receipt_whatsapp_number ?? '',
    paymentReceiptWhatsappNumberE164: data.payment_receipt_whatsapp_number_e164 ?? null,
    contactEmail: data.contact_email ?? '',
    address: data.address ?? '',
    mapsUrl: data.maps_url ?? '',
  }
}

export function ClubContactCard() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [form, setForm] = useState<ClubContact | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['club-contact', currentClubId],
    queryFn: () => fetchContact(currentClubId!),
    enabled: !!currentClubId,
  })

  useEffect(() => {
    if (data && !form) setForm(data)
  }, [data, form])

  const country = form?.country ?? 'EG'

  const mutation = useMutation({
    mutationFn: async () => {
      if (!form) return

      // Directive section 16: an invalid contact phone is never saved.
      const primaryResult = form.primaryPhone.trim() ? normalizePhone(form.primaryPhone, country) : null
      if (form.primaryPhone.trim() && (!primaryResult?.valid || !primaryResult.e164)) {
        throw new Error(t('phoneInput.invalidError'))
      }
      const whatsappResult = form.whatsappNumber.trim() ? normalizePhone(form.whatsappNumber, country) : null
      if (form.whatsappNumber.trim() && (!whatsappResult?.valid || !whatsappResult.e164)) {
        throw new Error(t('phoneInput.invalidError'))
      }
      const receiptResult = form.paymentReceiptWhatsappNumber.trim() ? normalizePhone(form.paymentReceiptWhatsappNumber, country) : null
      if (form.paymentReceiptWhatsappNumber.trim() && (!receiptResult?.valid || !receiptResult.e164)) {
        throw new Error(t('phoneInput.invalidError'))
      }

      const { error: updateError } = await supabase
        .from('clubs')
        .update({
          country,
          primary_phone: form.primaryPhone.trim() || null,
          primary_phone_e164: primaryResult?.e164 ?? null,
          secondary_phone: form.secondaryPhone.trim() || null,
          whatsapp_number: form.whatsappNumber.trim() || null,
          whatsapp_number_e164: whatsappResult?.e164 ?? null,
          payment_receipt_whatsapp_number: form.paymentReceiptWhatsappNumber.trim() || null,
          payment_receipt_whatsapp_number_e164: receiptResult?.e164 ?? null,
          contact_email: form.contactEmail.trim() || null,
          address: form.address.trim() || null,
          maps_url: form.mapsUrl.trim() || null,
        })
        .eq('id', currentClubId!)
      if (updateError) throw updateError
    },
    onSuccess: () => {
      setSaved(true)
      setError(null)
      setTimeout(() => setSaved(false), 3000)
      void queryClient.invalidateQueries({ queryKey: ['club-contact', currentClubId] })
    },
    onError: (err) => setError(err instanceof Error && err.message === t('phoneInput.invalidError') ? err.message : translateSupabaseError(err, t('clubs.contactCard.saveError'))),
  })

  if (isLoading || !form) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">{t('clubs.contactCard.title')}</CardTitle></CardHeader>
        <CardContent><p className="text-sm text-text-secondary">{t('clubs.contactCard.loading')}</p></CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('clubs.contactCard.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-xs text-text-secondary">{t('clubs.contactCard.hint')}</p>

        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-text-secondary">{t('phoneInput.countryLabel')}</label>
          <Select value={country} onValueChange={(v) => setForm({ ...form, country: v as CountryCode })}>
            <SelectTrigger className="max-w-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {COUNTRY_OPTIONS.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.flag} {t(c.labelKey)} ({c.dialCode})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <PhoneInput
            label={t('clubs.contactCard.primaryPhone')}
            value={{ raw: form.primaryPhone, country }}
            onChange={(v) => setForm({ ...form, primaryPhone: v.raw, country: v.country })}
            showValidation={false}
          />
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-text-secondary">{t('clubs.contactCard.secondaryPhone')}</label>
            <Input dir="ltr" value={form.secondaryPhone} onChange={(e) => setForm({ ...form, secondaryPhone: e.target.value })} placeholder="01xxxxxxxxx" />
          </div>
          <div>
            <PhoneInput
              label={t('clubs.contactCard.whatsappNumber')}
              value={{ raw: form.whatsappNumber, country }}
              onChange={(v) => setForm({ ...form, whatsappNumber: v.raw, country: v.country })}
              showValidation={false}
            />
            <p className="mt-1 text-xs text-text-secondary">{t('clubs.contactCard.whatsappNumberHint')}</p>
          </div>
          <div>
            <PhoneInput
              label={t('clubs.contactCard.paymentReceiptWhatsapp')}
              value={{ raw: form.paymentReceiptWhatsappNumber, country }}
              onChange={(v) => setForm({ ...form, paymentReceiptWhatsappNumber: v.raw, country: v.country })}
              showValidation={false}
            />
            <p className="mt-1 text-xs text-text-secondary">{t('clubs.contactCard.paymentReceiptWhatsappHint')}</p>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-text-secondary">{t('clubs.contactCard.email')}</label>
            <Input dir="ltr" type="email" value={form.contactEmail} onChange={(e) => setForm({ ...form, contactEmail: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-text-secondary">{t('clubs.contactCard.mapsUrl')}</label>
            <Input dir="ltr" value={form.mapsUrl} onChange={(e) => setForm({ ...form, mapsUrl: e.target.value })} placeholder="https://maps.google.com/..." />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-sm font-medium text-text-secondary">{t('clubs.contactCard.address')}</label>
          <Input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </div>

        {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? t('clubs.contactCard.saving') : t('clubs.contactCard.save')}
          </Button>
          {saved && <span className="text-sm text-status-success">{t('clubs.contactCard.saved')}</span>}
        </div>
      </CardContent>
    </Card>
  )
}
