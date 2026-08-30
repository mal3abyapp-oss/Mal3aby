import { useState, type FormEvent } from 'react'
import type { CountryCode } from 'libphonenumber-js'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PhoneInput } from '@/components/ui/phone-input'
import { WhatsappConsentQuestion, type WhatsappConsentAnswer } from '@/components/ui/whatsapp-consent-question'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { CustomerRow } from '@/lib/domain/people'
import { translateSupabaseError } from '@/lib/errors'
import { normalizePhone, convertArabicDigits } from '@/lib/domain/phone'

// Phase 4: search, create, edit customers. Guardian linking (from the
// player side) lives in AcademyPage's Player Profile per SCREEN_MAP.md
// (Player Profile route = academy, not customers).
async function fetchCustomers(clubId: string, search: string) {
  let query = supabase
    .from('customers')
    .select('id, full_name, mobile_display, phone_e164, email, whatsapp')
    .eq('club_id', clubId)
    .order('full_name')
    .limit(50)

  const trimmedSearch = search.trim()
  if (trimmedSearch) {
    // Escape ilike wildcard/separator characters so raw user input can't
    // alter the pattern (e.g. a literal '%' or ',' in the search box).
    const escapedSearch = trimmedSearch.replace(/[%,]/g, '\\$&')
    const filters = [`full_name.ilike.%${escapedSearch}%`, `mobile_display.ilike.%${escapedSearch}%`]

    // phone_e164 is the canonical/normalized phone identity column (see
    // supabase/migrations/20260819300000_phone_e164_canonical_schema.sql);
    // mobile_display only stores whatever raw string staff typed at
    // creation time, so a literal ilike against it alone misses matches
    // when the search term's formatting (spacing, leading zero, Arabic-
    // Indic digits) doesn't match the stored display string verbatim.
    // Run every search term through the same Arabic-Indic-digit
    // conversion normalizePhone() applies (per src/lib/domain/phone.ts:
    // "every screen that accepts a phone number must go through
    // normalizePhone()"), then strip to digits-only so a phone search in
    // any format/spacing can still match the canonical E.164 value. Full
    // normalizePhone() isn't used here because it rejects partial digit
    // sequences (e.g. "0111" while the user is still typing), which
    // would silently drop matches instead of broadening them.
    const digitsOnly = convertArabicDigits(trimmedSearch).replace(/\D/g, '')
    if (digitsOnly) {
      filters.push(`phone_e164.ilike.%${digitsOnly}%`)
    }

    query = query.or(filters.join(','))
  }

  const { data, error } = await query
  if (error) throw error

  // Gate 11 (2026-08-16): outstanding balance is a shared KPI -- it must be
  // computed in exactly one place (Doc 3's single-source-of-truth rule).
  // This used to be reimplemented here via a manual invoices+payment_allocations
  // join that never accounted for refunds (a refund on an already-paid invoice
  // re-opens the debt), silently understating what customers actually owed.
  // OutstandingPage.tsx already reads the correct `outstanding_invoices` view,
  // which nets out completed refunds -- read the same view here instead of
  // recomputing the concept independently.
  const customerIds = (data ?? []).map((row) => row.id)
  const outstandingByCustomer = new Map<string, number>()
  if (customerIds.length > 0) {
    const { data: outstandingRows } = await supabase
      .from('outstanding_invoices')
      .select('customer_id, outstanding')
      .in('customer_id', customerIds)
    for (const row of outstandingRows ?? []) {
      if (!row.customer_id) continue
      const amount = Number(row.outstanding)
      if (amount > 0) {
        outstandingByCustomer.set(row.customer_id, (outstandingByCustomer.get(row.customer_id) ?? 0) + amount)
      }
    }
  }

  return (data ?? []).map<CustomerRow>((row) => ({
    id: row.id,
    fullName: row.full_name,
    mobileDisplay: row.mobile_display,
    email: row.email,
    whatsapp: row.whatsapp,
    outstanding: outstandingByCustomer.get(row.id) ?? 0,
  }))
}

async function fetchClubCountry(clubId: string): Promise<CountryCode | null> {
  const { data, error } = await supabase.from('clubs').select('country').eq('id', clubId).single()
  if (error) return null
  return (data?.country as CountryCode | null) ?? null
}

export function CustomersPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  // Master IA/UX audit (Reports decomposition phase): reports must not
  // be dead ends -- a "top spenders" list row now links here with
  // ?q=<name> so the customer is pre-searched instead of landing on an
  // empty list the manager has to re-search by hand.
  const [searchParams] = useSearchParams()
  const [search, setSearch] = useState(() => searchParams.get('q') ?? '')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [fullName, setFullName] = useState('')
  const [mobile, setMobile] = useState('')
  const [mobileCountry, setMobileCountry] = useState<CountryCode>('EG')
  const [phoneValid, setPhoneValid] = useState(false)
  const [email, setEmail] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [duplicateCustomerId, setDuplicateCustomerId] = useState<string | null>(null)
  // Correction: creating a customer record is never itself consent.
  // Staff must explicitly ask the customer and record the real
  // answer -- no pre-selected default, same pattern as the government-
  // affiliation question at onboarding.
  const [whatsappConsent, setWhatsappConsent] = useState<WhatsappConsentAnswer>(null)

  const { data: clubCountry } = useQuery({
    queryKey: ['club-country', currentClubId],
    queryFn: () => fetchClubCountry(currentClubId!),
    enabled: !!currentClubId,
  })

  // Directive section 76: minimal actionable view of customers whose
  // phone couldn't be safely normalized -- never guessed, surfaced for
  // a human to fix via the normal edit flow (which now runs through
  // the real parser).
  const { data: phoneIssues = [] } = useQuery({
    queryKey: ['phone-data-issues', currentClubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_phone_data_issues', { p_club_id: currentClubId as string })
      if (error) throw error
      return data ?? []
    },
    enabled: !!currentClubId,
  })

  // V1 Implementation Gap Audit (2026-08-16): this file's own original
  // comment said "Phase 4: search, create, edit customers" but edit was
  // never actually built -- a typo in a customer's name/phone had no
  // correction path through the product. editingCustomer !== null reuses
  // the same dialog/form as create, pre-filled, submitting an update
  // instead of an insert.
  const [editingCustomer, setEditingCustomer] = useState<CustomerRow | null>(null)

  const { data: customers = [], isLoading } = useQuery({
    queryKey: ['customers', currentClubId, search],
    queryFn: () => fetchCustomers(currentClubId!, search),
    enabled: !!currentClubId,
  })

  // Phase G (G2/G7): "outstanding only" is the single highest-value
  // filter beyond the existing name/phone search -- lets a
  // collections-focused staff member instantly narrow to who actually
  // owes money, client-side since outstanding is already computed per
  // row (no new RPC needed).
  const [outstandingOnly, setOutstandingOnly] = useState(false)
  const visibleCustomers = outstandingOnly ? customers.filter((c) => (c.outstanding ?? 0) > 0) : customers

  function openCreateDialog() {
    setEditingCustomer(null)
    setFullName('')
    setMobile('')
    setMobileCountry((clubCountry as CountryCode) ?? 'EG')
    setEmail('')
    setFormError(null)
    setDuplicateCustomerId(null)
    setWhatsappConsent(null)
    setDialogOpen(true)
  }

  function openEditDialog(c: CustomerRow) {
    setEditingCustomer(c)
    setFullName(c.fullName)
    setMobile(c.mobileDisplay ?? '')
    setMobileCountry((clubCountry as CountryCode) ?? 'EG')
    setWhatsappConsent(null)
    setEmail(c.email ?? '')
    setFormError(null)
    setDuplicateCustomerId(null)
    setDialogOpen(true)
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      let phoneE164: string | undefined
      if (mobile.trim()) {
        // Directive section 16/23: an invalid phone is never saved --
        // the previous value (if editing) stays untouched.
        const result = normalizePhone(mobile, mobileCountry)
        if (!result.valid || !result.e164) {
          throw new Error(t('phoneInput.invalidError'))
        }
        phoneE164 = result.e164
      }

      // Customer 360 closure gap: single write path shared with every
      // other customer-creation surface -- upsert_customer's own
      // concurrency-safe create (database unique_violation + retry)
      // and duplicate-on-edit detection (directive section 31) replace
      // what used to be a check-then-insert done independently here.
      const { data, error: rpcError } = await supabase.rpc('upsert_customer', {
        p_club_id: currentClubId as string,
        p_full_name: fullName,
        p_phone_e164: phoneE164 as string,
        p_mobile_display: mobile || undefined,
        // '' (not undefined) so a deliberately-cleared field is sent as
        // an explicit clear signal, not "no change" -- see
        // upsert_customer's NULL-vs-'' semantics in
        // 20260824070000_upsert_customer_email_clear_semantics.sql.
        p_email: email.trim(),
        p_whatsapp_consent: phoneE164 && whatsappConsent !== null ? whatsappConsent : undefined,
        p_customer_id: editingCustomer?.id,
      })
      if (rpcError) throw rpcError
      const row = data?.[0]
      if (!row) throw new Error('upsert_customer returned no row')
      if (row.duplicate_of_customer_id) {
        throw { isDuplicate: true, customerId: row.duplicate_of_customer_id }
      }
    },
    onSuccess: () => {
      setDialogOpen(false)
      setEditingCustomer(null)
      setFullName('')
      setMobile('')
      setEmail('')
      setFormError(null)
      setDuplicateCustomerId(null)
      setWhatsappConsent(null)
      void queryClient.invalidateQueries({ queryKey: ['customers', currentClubId] })
    },
    onError: (error: unknown) => {
      if (error && typeof error === 'object' && 'isDuplicate' in error) {
        const dup = (error as unknown as { customerId: string })
        setDuplicateCustomerId(dup.customerId)
        setFormError(null)
        return
      }
      setFormError(translateSupabaseError(error, editingCustomer ? t('customers.saveEditError') : t('customers.addError')))
    },
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setFormError(null)
    setDuplicateCustomerId(null)
    saveMutation.mutate()
  }

  const columns: DataTableColumn<CustomerRow>[] = [
    {
      key: 'name',
      header: t('common.name'),
      render: (c) => (
        <button className="text-accent-foreground hover:underline" onClick={() => navigate(`/app/customers/${c.id}`)}>
          {c.fullName}
        </button>
      ),
    },
    { key: 'mobile', header: t('common.phone'), render: (c) => c.mobileDisplay ?? '—' },
    { key: 'email', header: t('common.email'), render: (c) => c.email ?? '—' },
    {
      key: 'outstanding',
      header: t('customers.outstanding'),
      render: (c) => (c.outstanding && c.outstanding > 0 ? <span className="font-medium text-status-danger tabular-nums">{c.outstanding.toFixed(0)} {t('common.currency')}</span> : <span className="text-status-success">—</span>),
    },
    {
      key: 'actions',
      header: '',
      render: (c) => (
        <button className="text-xs text-text-secondary hover:text-accent-foreground hover:underline" onClick={() => openEditDialog(c)}>
          {t('common.edit')}
        </button>
      ),
    },
  ]

  return (
    <div>
      {phoneIssues.length > 0 && (
        <div className="mb-4 flex flex-col gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3 text-sm">
          <p className="font-medium">{t('customers.phoneIssues.title', { count: phoneIssues.length })}</p>
          <div className="flex flex-col gap-1">
            {phoneIssues.slice(0, 5).map((issue) => (
              <button
                key={issue.customer_id}
                className="flex items-center justify-between rounded border border-transparent px-2 py-1 text-start hover:border-border hover:bg-muted/40"
                onClick={() => {
                  const c = customers.find((row) => row.id === issue.customer_id)
                  if (c) openEditDialog(c)
                }}
              >
                <span>{issue.full_name}</span>
                <span dir="ltr" className="text-xs tabular-nums text-text-secondary">{issue.mobile_display}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      <PageHeader
        title={t('customers.page.title')}
        description={t('customers.page.description')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => navigate('/app/customers/duplicates')}>
              {t('customers.duplicates.reviewLink', { defaultValue: 'Review duplicates' })}
            </Button>
            <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingCustomer(null) }}>
              <DialogTrigger asChild>
                <Button onClick={openCreateDialog}>{t('customers.addCustomer')}</Button>
              </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{editingCustomer ? t('customers.editCustomer') : t('customers.addCustomer')}</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">{t('customers.fullName')}</label>
                  <Input required value={fullName} onChange={(e) => setFullName(e.target.value)} />
                </div>
                <PhoneInput
                  label={t('common.phone')}
                  value={{ raw: mobile, country: mobileCountry }}
                  onChange={(v) => {
                    setMobile(v.raw)
                    setMobileCountry(v.country)
                    setDuplicateCustomerId(null)
                    setFormError(null)
                  }}
                  onValidChange={(r) => setPhoneValid(r.valid)}
                />
                {mobile.trim() && phoneValid && (
                  <WhatsappConsentQuestion value={whatsappConsent} onChange={setWhatsappConsent} />
                )}
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">{t('customers.emailOptional')}</label>
                  <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                {duplicateCustomerId && (
                  <div className="flex flex-col gap-2 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-sm">
                    <p>{t('phoneInput.duplicateCustomer')}</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDialogOpen(false)
                        navigate(`/app/customers/${duplicateCustomerId}`)
                      }}
                    >
                      {t('phoneInput.openCustomer')}
                    </Button>
                  </div>
                )}
                {formError && (
                  <p role="alert" className="text-sm text-status-danger">
                    {formError}
                  </p>
                )}
                <Button
                  type="submit"
                  disabled={
                    saveMutation.isPending ||
                    (mobile.trim().length > 0 && !phoneValid) ||
                    (mobile.trim().length > 0 && phoneValid && whatsappConsent === null)
                  }
                >
                  {saveMutation.isPending ? t('common.saving') : editingCustomer ? t('customers.saveChanges') : t('common.add')}
                </Button>
              </form>
            </DialogContent>
            </Dialog>
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Input
          placeholder={t('customers.searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-sm"
        />
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={outstandingOnly} onChange={(e) => setOutstandingOnly(e.target.checked)} className="size-4" />
          {t('customers.outstandingOnlyFilter')}
        </label>
      </div>

      <DataTable
        columns={columns}
        rows={visibleCustomers}
        rowKey={(c) => c.id}
        isLoading={isLoading}
        emptyTitle={t('customers.emptyTitle')}
        emptyDescription={t('customers.emptyDescription')}
      />
    </div>
  )
}
