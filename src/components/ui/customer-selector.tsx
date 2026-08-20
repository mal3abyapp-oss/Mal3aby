import { useEffect, useState } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'
import { normalizePhone } from '@/lib/domain/phone'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { WhatsappConsentQuestion, type WhatsappConsentAnswer } from '@/components/ui/whatsapp-consent-question'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

// Customer 360 closure gap: "SHARED CUSTOMER SELECTOR -- REQUIRED, NOT
// DEFERRED." Before this component, three separate module surfaces
// (CustomersPage, QuickBookingSheet, Academy's AddPlayerDialog) each
// reimplemented customer search + create with drifted behavior --
// only CustomersPage routed create/edit through upsert_customer's
// concurrency-safe path; QuickBookingSheet and AddPlayerDialog did a
// raw check-then-insert against `customers` directly (the exact
// pattern upsert_customer's own comments call out as unsafe under
// concurrency), and AddPlayerDialog wrote WhatsApp consent via legacy
// normalizeMobile() digit-stripping instead of the real E.164 pipeline.
//
// This component is the ONE place staff search for or create a
// customer anywhere in the app. Search reads the same `customers`
// table every module already read (no new RPC needed for read-only,
// RLS-scoped search); create/select-with-consent always goes through
// upsert_customer, so duplicate detection, phone normalization, and
// concurrency safety are identical everywhere it's used. Screen layout
// around it (a Select vs. a search box vs. an inline card) is free to
// differ per module -- the identity logic underneath must not.

export interface SelectedCustomer {
  id: string
  fullName: string
  mobileDisplay: string | null
}

interface CustomerSearchRow {
  id: string
  full_name: string
  mobile_display: string | null
}

async function searchCustomers(clubId: string, search: string): Promise<CustomerSearchRow[]> {
  let query = supabase
    .from('customers')
    .select('id, full_name, mobile_display')
    .eq('club_id', clubId)
    .eq('duplicate_review_status', 'none')
    .order('full_name')
    .limit(20)
  if (search.trim()) {
    query = query.or(`full_name.ilike.%${search}%,normalized_mobile.ilike.%${search}%,mobile_display.ilike.%${search}%`)
  }
  const { data, error } = await query
  if (error) throw error
  return data ?? []
}

async function fetchClubCountry(clubId: string): Promise<CountryCode | null> {
  const { data, error } = await supabase.from('clubs').select('country').eq('id', clubId).maybeSingle()
  if (error) return null
  return (data?.country as CountryCode | null) ?? null
}

export function CustomerSelector({
  clubId,
  value,
  onSelect,
  disabled,
}: {
  clubId: string
  value: SelectedCustomer | null
  onSelect: (customer: SelectedCustomer) => void
  disabled?: boolean
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'existing' | 'new'>('existing')
  const [search, setSearch] = useState('')
  const [newName, setNewName] = useState('')
  const [newMobile, setNewMobile] = useState('')
  const [newMobileCountry, setNewMobileCountry] = useState<CountryCode>('EG')
  const [newPhoneValid, setNewPhoneValid] = useState(false)
  const [whatsappConsent, setWhatsappConsent] = useState<WhatsappConsentAnswer>(null)
  const [duplicateOf, setDuplicateOf] = useState<SelectedCustomer | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: clubCountry } = useQuery({
    queryKey: ['club-country', clubId],
    queryFn: () => fetchClubCountry(clubId),
    enabled: !!clubId,
  })
  useEffect(() => { if (clubCountry) setNewMobileCountry(clubCountry) }, [clubCountry])

  const { data: candidates = [] } = useQuery({
    queryKey: ['customer-selector-search', clubId, search],
    queryFn: () => searchCustomers(clubId, search),
    enabled: !!clubId && mode === 'existing' && search.trim().length > 0,
  })

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!newName.trim()) throw new Error(t('customers.fullName'))
      let phoneE164: string | undefined
      if (newMobile.trim()) {
        const result = normalizePhone(newMobile, newMobileCountry)
        if (!result.valid || !result.e164) throw new Error(t('phoneInput.invalidError'))
        phoneE164 = result.e164
      }
      // Single write path for every module: upsert_customer provides
      // the concurrency-safe create (database unique_violation +
      // retry, not check-then-insert) and returns a real duplicate
      // conflict instead of silently creating a second record.
      const { data, error: rpcError } = await supabase.rpc('upsert_customer', {
        p_club_id: clubId,
        p_full_name: newName,
        p_phone_e164: phoneE164 as string,
        p_mobile_display: newMobile || undefined,
        p_whatsapp_consent: phoneE164 && whatsappConsent !== null ? whatsappConsent : undefined,
      })
      if (rpcError) throw rpcError
      const row = data?.[0]
      if (!row) throw new Error('upsert_customer returned no row')
      if (row.duplicate_of_customer_id) {
        // Bug found in live QA: falling back to the just-typed newName
        // here (rather than fetching the real record) displayed the
        // WRONG customer's name -- staff would see their own typed
        // name next to what is actually a different, pre-existing
        // customer's id, an identity-confusion risk. Always fetch the
        // real row instead of trusting client-side state.
        const { data: dup } = await supabase.from('customers').select('id, full_name, mobile_display').eq('id', row.duplicate_of_customer_id).maybeSingle()
        setDuplicateOf({ id: row.duplicate_of_customer_id, fullName: dup?.full_name ?? '', mobileDisplay: dup?.mobile_display ?? null })
        throw new Error('duplicate')
      }
      // Same correctness requirement on the success path: upsert_customer
      // may have resolved to a pre-existing customer (concurrent-create
      // race winner) whose real name can differ from newName -- fetch
      // rather than assume.
      const { data: created } = await supabase.from('customers').select('id, full_name, mobile_display').eq('id', row.customer_id).maybeSingle()
      return { id: row.customer_id, fullName: created?.full_name ?? newName, mobileDisplay: created?.mobile_display ?? (newMobile || null) }
    },
    onSuccess: (customer) => {
      setError(null)
      onSelect(customer)
    },
    onError: (err) => {
      if (err instanceof Error && err.message === 'duplicate') return
      setError(translateSupabaseError(err, t('customers.addError')))
    },
  })

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-md border border-accent/30 bg-accent/5 p-2 text-sm">
        <div className="flex flex-col">
          <span className="font-medium">{value.fullName}</span>
          {value.mobileDisplay && <span dir="ltr" className="text-xs text-text-secondary">{value.mobileDisplay}</span>}
        </div>
        {!disabled && (
          <button type="button" className="text-xs text-accent hover:underline" onClick={() => onSelect({ id: '', fullName: '', mobileDisplay: null })}>
            {t('bookings.quick.changeCustomer', { defaultValue: 'Change' })}
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <Button type="button" size="sm" variant={mode === 'existing' ? 'default' : 'outline'} className="flex-1" onClick={() => setMode('existing')}>
          {t('academy.players.existingCustomer', { defaultValue: 'Existing customer' })}
        </Button>
        <Button type="button" size="sm" variant={mode === 'new' ? 'default' : 'outline'} className="flex-1" onClick={() => setMode('new')}>
          {t('academy.players.newCustomer', { defaultValue: 'New customer' })}
        </Button>
      </div>

      {mode === 'existing' ? (
        <div className="flex flex-col gap-1.5">
          <Input placeholder={t('bookings.quick.searchPlaceholder', { defaultValue: 'Search by name or mobile...' })} value={search} onChange={(e) => setSearch(e.target.value)} />
          {candidates.length > 0 && (
            <Select value="" onValueChange={(id) => {
              const c = candidates.find((row) => row.id === id)
              if (c) onSelect({ id: c.id, fullName: c.full_name, mobileDisplay: c.mobile_display })
            }}>
              <SelectTrigger><SelectValue placeholder={t('bookings.quick.chooseCustomerPlaceholder', { defaultValue: 'Choose a customer' })} /></SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.full_name}{c.mobile_display ? ` — ${c.mobile_display}` : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border border-border p-2">
          <Input placeholder={t('customers.fullName')} value={newName} onChange={(e) => setNewName(e.target.value)} />
          <PhoneInput
            label={t('common.phone')}
            value={{ raw: newMobile, country: newMobileCountry }}
            onChange={(v) => { setNewMobile(v.raw); setNewMobileCountry(v.country); setDuplicateOf(null) }}
            onValidChange={(r) => setNewPhoneValid(r.valid)}
          />
          {newMobile.trim() && newPhoneValid && (
            <WhatsappConsentQuestion value={whatsappConsent} onChange={setWhatsappConsent} />
          )}
          {duplicateOf && (
            <div className="flex flex-col gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-2 text-xs">
              <p>{t('phoneInput.duplicateCustomer')} ({duplicateOf.fullName})</p>
              <Button type="button" size="sm" variant="outline" onClick={() => { onSelect(duplicateOf); setDuplicateOf(null) }}>
                {t('phoneInput.useExisting', { defaultValue: 'Use existing customer' })}
              </Button>
            </div>
          )}
          {error && <p role="alert" className="text-xs text-status-danger">{error}</p>}
          <Button
            type="button"
            size="sm"
            disabled={
              !newName.trim() ||
              (newMobile.trim().length > 0 && !newPhoneValid) ||
              (newMobile.trim().length > 0 && newPhoneValid && whatsappConsent === null) ||
              createMutation.isPending
            }
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? t('bookings.quick.adding', { defaultValue: 'Adding...' }) : t('bookings.quick.addCustomer', { defaultValue: 'Add customer' })}
          </Button>
        </div>
      )}
    </div>
  )
}
