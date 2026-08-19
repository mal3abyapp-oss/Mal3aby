import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translateSupabaseError } from '@/lib/errors'

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
 */
interface ClubContact {
  primaryPhone: string
  secondaryPhone: string
  whatsappNumber: string
  paymentReceiptWhatsappNumber: string
  contactEmail: string
  address: string
  mapsUrl: string
}

async function fetchContact(clubId: string): Promise<ClubContact> {
  const { data, error } = await supabase
    .from('clubs')
    .select('primary_phone, secondary_phone, whatsapp_number, payment_receipt_whatsapp_number, contact_email, address, maps_url')
    .eq('id', clubId)
    .single()
  if (error) throw error
  return {
    primaryPhone: data.primary_phone ?? '',
    secondaryPhone: data.secondary_phone ?? '',
    whatsappNumber: data.whatsapp_number ?? '',
    paymentReceiptWhatsappNumber: data.payment_receipt_whatsapp_number ?? '',
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

  const mutation = useMutation({
    mutationFn: async () => {
      if (!form) return
      const { error: updateError } = await supabase
        .from('clubs')
        .update({
          primary_phone: form.primaryPhone.trim() || null,
          secondary_phone: form.secondaryPhone.trim() || null,
          whatsapp_number: form.whatsappNumber.trim() || null,
          payment_receipt_whatsapp_number: form.paymentReceiptWhatsappNumber.trim() || null,
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
    onError: (err) => setError(translateSupabaseError(err, t('clubs.contactCard.saveError'))),
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
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-text-secondary">{t('clubs.contactCard.primaryPhone')}</label>
            <Input dir="ltr" value={form.primaryPhone} onChange={(e) => setForm({ ...form, primaryPhone: e.target.value })} placeholder="01xxxxxxxxx" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-text-secondary">{t('clubs.contactCard.secondaryPhone')}</label>
            <Input dir="ltr" value={form.secondaryPhone} onChange={(e) => setForm({ ...form, secondaryPhone: e.target.value })} placeholder="01xxxxxxxxx" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-text-secondary">{t('clubs.contactCard.whatsappNumber')}</label>
            <Input dir="ltr" value={form.whatsappNumber} onChange={(e) => setForm({ ...form, whatsappNumber: e.target.value })} placeholder="01xxxxxxxxx" />
            <p className="text-xs text-text-secondary">{t('clubs.contactCard.whatsappNumberHint')}</p>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-text-secondary">{t('clubs.contactCard.paymentReceiptWhatsapp')}</label>
            <Input dir="ltr" value={form.paymentReceiptWhatsappNumber} onChange={(e) => setForm({ ...form, paymentReceiptWhatsappNumber: e.target.value })} placeholder="01xxxxxxxxx" />
            <p className="text-xs text-text-secondary">{t('clubs.contactCard.paymentReceiptWhatsappHint')}</p>
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
