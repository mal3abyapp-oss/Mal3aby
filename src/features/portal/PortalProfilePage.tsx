import { useState, type FormEvent } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { translateSupabaseError } from '@/lib/errors'
import { ChangePasswordCard } from '@/features/account/ChangePasswordCard'
import { normalizePhone } from '@/lib/domain/phone'

// Gate 3 — "My Account": contact-preference self-service edit (the
// columns protect_customer_identity_columns() explicitly allows a
// self-service customer to change). Name/photo/national_id are
// deliberately NOT editable here -- name/national_id require staff
// (identity data), photo goes through the request_customer_photo_update
// re-approval flow instead of a direct edit.
//
// IA restructuring (Phase 10): confirmed silent-data-drop bug --
// `records[0]` silently picked only the FIRST linked customer record.
// A guardian linked at more than one club (a real, supported state --
// the same phone number can be a customer of two different clubs) had
// every club after the first completely inaccessible here, with no
// indication a second record even existed. Now fetches club_id/name
// alongside each record and offers a club selector whenever more than
// one linked record exists; a single-club guardian sees no selector at
// all (same experience as before for the common case).
interface MyCustomerRecord {
  id: string
  full_name: string
  mobile_display: string | null
  email: string | null
  whatsapp: string | null
  club_id: string
  clubs: { name_ar: string } | null
}

interface PortalCustomerRpcRow {
  customer_id: string
  club_id: string
  club_name_ar: string | null
  full_name: string | null
  mobile_display: string | null
  email: string | null
  whatsapp: string | null
}

// PORTAL CROSS-PERSONA AUTHORIZATION VULNERABILITY FIX (HIGH, 2026-08-25):
// this used to query `customers` with zero filter, relying on RLS alone
// -- for a staff member's Portal session, customers_select_club_staff
// silently returned every customer record in their club instead of just
// their own linked one(s). Now uses get_my_portal_customers(), the one
// SECURITY DEFINER RPC that checks customers.user_id = auth.uid()
// directly and never delegates to RLS's OR-combined policy set (see
// PortalClubProvider.tsx for the full rationale).
async function fetchMyCustomerRecords(): Promise<MyCustomerRecord[]> {
  const { data, error } = await supabase.rpc('get_my_portal_customers')
  if (error) throw error
  return ((data ?? []) as PortalCustomerRpcRow[]).map((r) => ({
    id: r.customer_id,
    full_name: r.full_name ?? '',
    mobile_display: r.mobile_display,
    email: r.email,
    whatsapp: r.whatsapp,
    club_id: r.club_id,
    clubs: r.club_name_ar ? { name_ar: r.club_name_ar } : null,
  }))
}

async function fetchClubCountry(clubId: string): Promise<CountryCode | null> {
  const { data, error } = await supabase.from('clubs').select('country').eq('id', clubId).single()
  if (error) return null
  return (data?.country as CountryCode | null) ?? null
}

export function PortalProfilePage() {
  const { t } = useTranslation()
  const { session } = useAuth()
  const queryClient = useQueryClient()
  const { data: records = [], isLoading } = useQuery({ queryKey: ['portal', 'my-customer-records'], queryFn: fetchMyCustomerRecords })
  const [selectedClubId, setSelectedClubId] = useState<string | null>(null)
  const record = records.find((r) => r.club_id === selectedClubId) ?? records[0]

  const [mobile, setMobile] = useState(record?.mobile_display ?? '')
  const [mobileCountry, setMobileCountry] = useState<CountryCode>('EG')
  const [phoneValid, setPhoneValid] = useState(true) // existing saved value is presumed valid until edited
  const [email, setEmail] = useState(record?.email ?? '')
  const [whatsapp, setWhatsapp] = useState(record?.whatsapp ?? '')
  const [initializedForId, setInitializedForId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const { data: clubCountry } = useQuery({
    queryKey: ['club-country', record?.club_id],
    queryFn: () => fetchClubCountry(record!.club_id),
    enabled: !!record?.club_id,
  })

  // Re-initialize the form fields whenever the effective record changes
  // (first load, or the guardian switches clubs via the selector) --
  // keyed on record.id so switching clubs always re-syncs to that
  // club's own data instead of carrying over the previous club's
  // edited-but-unsaved field values.
  if (record && initializedForId !== record.id) {
    setMobile(record.mobile_display ?? '')
    setMobileCountry((clubCountry as CountryCode) ?? 'EG')
    setPhoneValid(true)
    setEmail(record.email ?? '')
    setWhatsapp(record.whatsapp ?? '')
    setInitializedForId(record.id)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!record) return
      let phoneE164: string | null = null
      if (mobile.trim()) {
        const result = normalizePhone(mobile, mobileCountry)
        if (!result.valid || !result.e164) {
          throw new Error(t('phoneInput.invalidError'))
        }
        phoneE164 = result.e164
      }
      const { error } = await supabase
        .from('customers')
        .update({
          mobile_display: mobile || null,
          normalized_mobile: mobile ? mobile.replace(/\D/g, '').replace(/^0+/, '') : null,
          phone_e164: phoneE164,
          email: email || null,
          whatsapp: whatsapp || null,
        })
        .eq('id', record.id)
      if (error) throw error
    },
    onSuccess: () => {
      setSaved(true)
      setFormError(null)
      void queryClient.invalidateQueries({ queryKey: ['portal', 'my-customer-records'] })
      setTimeout(() => setSaved(false), 3000)
    },
    onError: (error) => setFormError(translateSupabaseError(error, t('portal.profilePage.saveError'))),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    saveMutation.mutate()
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('portal.profilePage.title')} description={t('portal.profilePage.description')} />

      {isLoading && <p className="text-sm text-text-secondary">{t('portal.profilePage.loading')}</p>}

      {!isLoading && !record && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          {t('portal.profilePage.emptyTitle')}
        </p>
      )}

      {records.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('portal.profilePage.clubLabel')}</label>
          <Select value={record?.club_id ?? ''} onValueChange={(v) => { setSelectedClubId(v); setFormError(null); setSaved(false) }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {records.map((r) => (
                <SelectItem key={r.club_id} value={r.club_id}>{r.clubs?.name_ar ?? r.club_id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-text-secondary">{t('portal.profilePage.multiClubHint')}</p>
        </div>
      )}

      {record && (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <p className="text-xs text-text-secondary">{t('portal.profilePage.nameLabel')}</p>
            <p className="font-medium">{record.full_name}</p>
            <p className="mt-1 text-xs text-text-secondary">{t('portal.profilePage.nameEditHint')}</p>
          </div>

          <PhoneInput
            label={t('portal.profilePage.phoneLabel')}
            value={{ raw: mobile, country: mobileCountry }}
            onChange={(v) => {
              setMobile(v.raw)
              setMobileCountry(v.country)
            }}
            onValidChange={(r) => setPhoneValid(r.valid)}
          />
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('portal.profilePage.whatsappLabel')}</label>
            <Input value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('portal.profilePage.emailLabel')}</label>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </div>

          {formError && <p className="text-sm text-status-danger">{formError}</p>}
          {saved && <p className="text-sm text-status-success">{t('portal.profilePage.saved')}</p>}

          <Button type="submit" disabled={saveMutation.isPending || (mobile.trim().length > 0 && !phoneValid)}>
            {saveMutation.isPending ? t('portal.profilePage.saving') : t('portal.profilePage.saveChanges')}
          </Button>
        </form>
      )}

      {/* Platform Owner & Password Security directive: same shared
          ChangePasswordCard staff use via Settings -- customers get
          the identical self-service flow, not a second implementation. */}
      {session?.user.email && (
        <div className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-text-secondary">{t('account.securitySection')}</h2>
          <ChangePasswordCard userEmail={session.user.email} />
        </div>
      )}
    </div>
  )
}
