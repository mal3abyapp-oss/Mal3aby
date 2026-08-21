import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { translateSupabaseError } from '@/lib/errors'
import { Plus, CreditCard } from 'lucide-react'

// Master Payment Directive Phase 5-6 (task #82): Settings -> Payments.
// Every tenant manages its own payment methods here instead of a
// hardcoded dropdown (Section 28-29): Cash/InstaPay/Wallet/Bank/POS/
// Custom, each with a customer-visibility toggle and method-specific
// public collection details (Sections 31-36, 44-45). underlying_method
// stays the small stable payments.method enum used for actual money-
// movement bookkeeping (cash-shift/collections-report already key off
// it) -- this table is the display/instruction layer on top of it, per
// the audit-first REUSE/EXTEND rule (not a second payment system).

type UnderlyingMethod = 'cash' | 'card' | 'bank_transfer' | 'wallet' | 'other'

interface PaymentMethodRow {
  id: string
  underlyingMethod: UnderlyingMethod
  provider: string | null
  nameAr: string
  nameEn: string
  instructionsAr: string | null
  instructionsEn: string | null
  details: Record<string, string>
  referenceRequired: boolean
  proofRequired: boolean
  customerVisible: boolean
  isActive: boolean
  displayOrder: number
}

// Directive: at least InstaPay + the major Egyptian mobile wallets need
// to be selectable, not just a generic "wallet" bucket -- provider is
// the existing free-text column (no schema change needed, matches the
// architecture's own "no migration per provider" requirement), this
// is just the curated picker for the common ones plus a free-text
// escape hatch for anything else.
const WALLET_PROVIDER_OPTIONS = [
  { value: 'instapay', labelKey: 'billing.paymentMethods.providerLabels.instapay' },
  { value: 'vodafone_cash', labelKey: 'billing.paymentMethods.providerLabels.vodafone_cash' },
  { value: 'etisalat_cash', labelKey: 'billing.paymentMethods.providerLabels.etisalat_cash' },
  { value: 'orange_cash', labelKey: 'billing.paymentMethods.providerLabels.orange_cash' },
  { value: 'we_pay', labelKey: 'billing.paymentMethods.providerLabels.we_pay' },
  { value: 'other', labelKey: 'billing.paymentMethods.providerLabels.other' },
] as const

const UNDERLYING_METHOD_LABEL_KEYS: Record<UnderlyingMethod, string> = {
  cash: 'billing.paymentMethods.underlyingMethodLabels.cash',
  card: 'billing.paymentMethods.underlyingMethodLabels.card',
  bank_transfer: 'billing.paymentMethods.underlyingMethodLabels.bank_transfer',
  wallet: 'billing.paymentMethods.underlyingMethodLabels.wallet',
  other: 'billing.paymentMethods.underlyingMethodLabels.other',
}

// Which "details" fields to collect per underlying method -- matches
// Sections 31 (InstaPay), 33 (wallets), 34 (bank accounts).
const DETAIL_FIELDS: Record<UnderlyingMethod, { key: string; labelKey: string }[]> = {
  cash: [],
  card: [{ key: 'terminal_reference', labelKey: 'billing.paymentMethods.detailFields.terminalReference' }],
  bank_transfer: [
    { key: 'bank_name', labelKey: 'billing.paymentMethods.detailFields.bankName' },
    { key: 'account_holder', labelKey: 'billing.paymentMethods.detailFields.accountHolder' },
    { key: 'account_number', labelKey: 'billing.paymentMethods.detailFields.accountNumber' },
    { key: 'iban', labelKey: 'billing.paymentMethods.detailFields.iban' },
    { key: 'swift', labelKey: 'billing.paymentMethods.detailFields.swift' },
  ],
  wallet: [
    { key: 'phone', labelKey: 'billing.paymentMethods.detailFields.phone' },
    { key: 'beneficiary', labelKey: 'billing.paymentMethods.detailFields.beneficiary' },
  ],
  other: [
    { key: 'phone', labelKey: 'billing.paymentMethods.detailFields.phoneOptional' },
    { key: 'link', labelKey: 'billing.paymentMethods.detailFields.linkOptional' },
  ],
}

async function fetchPaymentMethods(clubId: string): Promise<PaymentMethodRow[]> {
  const { data, error } = await supabase
    .from('payment_method_configs')
    .select('id, underlying_method, provider, name_ar, name_en, instructions_ar, instructions_en, details, reference_required, proof_required, customer_visible, is_active, display_order')
    .eq('club_id', clubId)
    .order('display_order')
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    underlyingMethod: r.underlying_method as UnderlyingMethod,
    provider: r.provider,
    nameAr: r.name_ar,
    nameEn: r.name_en,
    instructionsAr: r.instructions_ar,
    instructionsEn: r.instructions_en,
    details: (r.details as Record<string, string>) ?? {},
    referenceRequired: r.reference_required,
    proofRequired: r.proof_required,
    customerVisible: r.customer_visible,
    isActive: r.is_active,
    displayOrder: r.display_order,
  }))
}

export function PaymentMethodsCard() {
  const { currentClubId } = useAuth()
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingMethod, setEditingMethod] = useState<PaymentMethodRow | null>(null)
  const [underlyingMethod, setUnderlyingMethod] = useState<UnderlyingMethod>('bank_transfer')
  const [provider, setProvider] = useState<string>('')
  const [nameAr, setNameAr] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [instructionsAr, setInstructionsAr] = useState('')
  const [instructionsEn, setInstructionsEn] = useState('')
  const [detailValues, setDetailValues] = useState<Record<string, string>>({})
  const [customerVisible, setCustomerVisible] = useState(true)
  const [formError, setFormError] = useState<string | null>(null)

  const { data: methods = [], isLoading } = useQuery({
    queryKey: ['payment-method-configs', currentClubId],
    queryFn: () => fetchPaymentMethods(currentClubId!),
    enabled: !!currentClubId,
  })

  const resetForm = () => {
    setEditingMethod(null)
    setUnderlyingMethod('bank_transfer')
    setProvider('')
    setNameAr('')
    setNameEn('')
    setInstructionsAr('')
    setInstructionsEn('')
    setDetailValues({})
    setCustomerVisible(true)
    setFormError(null)
  }

  const openEdit = (method: PaymentMethodRow) => {
    setEditingMethod(method)
    setUnderlyingMethod(method.underlyingMethod)
    setProvider(method.provider ?? '')
    setNameAr(method.nameAr)
    setNameEn(method.nameEn)
    setInstructionsAr(method.instructionsAr ?? '')
    setInstructionsEn(method.instructionsEn ?? '')
    setDetailValues(method.details)
    setCustomerVisible(method.customerVisible)
    setFormError(null)
    setDialogOpen(true)
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!nameAr.trim() || !nameEn.trim()) throw new Error(t('billing.paymentMethods.nameRequiredError'))
      const { error } = await supabase.rpc('create_payment_method_config', {
        p_club_id: currentClubId!,
        p_underlying_method: underlyingMethod,
        p_provider: provider.trim(),
        p_name_ar: nameAr.trim(),
        p_name_en: nameEn.trim(),
        p_instructions_ar: instructionsAr.trim(),
        p_instructions_en: instructionsEn.trim(),
        p_details: detailValues,
        p_customer_visible: customerVisible,
        p_reason: 'Payment method created from settings',
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-method-configs', currentClubId] })
      setDialogOpen(false)
      resetForm()
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, t('billing.paymentMethods.addError'))),
  })

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editingMethod) throw new Error(t('billing.paymentMethods.addError'))
      if (!nameAr.trim() || !nameEn.trim()) throw new Error(t('billing.paymentMethods.nameRequiredError'))
      const { error } = await supabase.rpc('update_payment_method_config', {
        p_config_id: editingMethod.id,
        p_provider: provider.trim(),
        p_name_ar: nameAr.trim(),
        p_name_en: nameEn.trim(),
        p_instructions_ar: instructionsAr.trim(),
        p_instructions_en: instructionsEn.trim(),
        p_details: detailValues,
        p_customer_visible: customerVisible,
        p_is_active: editingMethod.isActive,
        p_reason: 'Payment method details corrected from settings',
      })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['payment-method-configs', currentClubId] })
      setDialogOpen(false)
      resetForm()
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, t('billing.paymentMethods.addError'))),
  })

  const toggleActiveMutation = useMutation({
    mutationFn: async (method: PaymentMethodRow) => {
      const { error } = await supabase.rpc('update_payment_method_config', {
        p_config_id: method.id, p_provider: method.provider ?? '', p_name_ar: method.nameAr,
        p_name_en: method.nameEn, p_instructions_ar: method.instructionsAr ?? '',
        p_instructions_en: method.instructionsEn ?? '', p_details: method.details,
        p_customer_visible: method.customerVisible, p_is_active: !method.isActive,
        p_reason: method.isActive ? 'Payment method deactivated' : 'Payment method reactivated',
      })
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['payment-method-configs', currentClubId] }),
  })

  const toggleVisibleMutation = useMutation({
    mutationFn: async (method: PaymentMethodRow) => {
      const { error } = await supabase.rpc('update_payment_method_config', {
        p_config_id: method.id, p_provider: method.provider ?? '', p_name_ar: method.nameAr,
        p_name_en: method.nameEn, p_instructions_ar: method.instructionsAr ?? '',
        p_instructions_en: method.instructionsEn ?? '', p_details: method.details,
        p_customer_visible: !method.customerVisible, p_is_active: method.isActive,
        p_reason: method.customerVisible ? 'Payment method hidden from customers' : 'Payment method shown to customers',
      })
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['payment-method-configs', currentClubId] }),
  })

  return (
    <Card className="min-w-0">
      <CardHeader className="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base">{t('billing.paymentMethods.cardTitle')}</CardTitle>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm() }}>
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            <Plus className="me-1 size-4" /> {t('billing.paymentMethods.addMethod')}
          </Button>
          <DialogContent>
            <DialogHeader><DialogTitle>{editingMethod ? t('common.edit') : t('billing.paymentMethods.dialogTitle')}</DialogTitle></DialogHeader>
            <div className="flex flex-col gap-3">
              {formError && <p className="text-sm text-status-danger">{formError}</p>}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">{t('billing.paymentMethods.methodTypeLabel')}</label>
                <Select disabled={!!editingMethod} value={underlyingMethod} onValueChange={(v) => { setUnderlyingMethod(v as UnderlyingMethod); setDetailValues({}); setProvider('') }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(UNDERLYING_METHOD_LABEL_KEYS) as UnderlyingMethod[]).map((m) => (
                      <SelectItem key={m} value={m}>{t(UNDERLYING_METHOD_LABEL_KEYS[m])}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {underlyingMethod === 'wallet' && (
                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium">{t('billing.paymentMethods.providerLabel')}</label>
                  <Select value={provider} onValueChange={setProvider}>
                    <SelectTrigger><SelectValue placeholder={t('billing.paymentMethods.providerPlaceholder')} /></SelectTrigger>
                    <SelectContent>
                      {WALLET_PROVIDER_OPTIONS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>{t(p.labelKey)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <div className="grid gap-3 md:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium">{t('billing.paymentMethods.nameArLabel')}</label>
                  <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder={t('billing.paymentMethods.nameArPlaceholder')} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium">{t('billing.paymentMethods.nameEnLabel')}</label>
                  <Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="e.g. Vodafone Cash" />
                </div>
              </div>
              {DETAIL_FIELDS[underlyingMethod].map((field) => (
                <div key={field.key} className="flex flex-col gap-1">
                  <label className="text-sm font-medium">{t(field.labelKey)}</label>
                  <Input
                    value={detailValues[field.key] ?? ''}
                    onChange={(e) => setDetailValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  />
                </div>
              ))}
              <div className="grid gap-3 md:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium">{t('billing.paymentMethods.instructionsArLabel')}</label>
                  <Input value={instructionsAr} onChange={(e) => setInstructionsAr(e.target.value)} placeholder={t('billing.paymentMethods.instructionsPlaceholder')} />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium">{t('billing.paymentMethods.instructionsEnLabel')}</label>
                  <Input value={instructionsEn} onChange={(e) => setInstructionsEn(e.target.value)} placeholder={t('billing.paymentMethods.instructionsPlaceholder')} />
                </div>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={customerVisible} onChange={(e) => setCustomerVisible(e.target.checked)} className="size-4" />
                {t('billing.paymentMethods.customerVisibleCheckbox')}
              </label>
              <Button onClick={() => editingMethod ? updateMutation.mutate() : createMutation.mutate()} disabled={createMutation.isPending || updateMutation.isPending}>
                {t('billing.paymentMethods.save')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {isLoading ? (
          <p className="text-sm text-text-secondary">{t('billing.paymentMethods.loading')}</p>
        ) : methods.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('billing.paymentMethods.empty')}</p>
        ) : (
          methods.map((m) => (
            <div key={m.id} className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm md:flex-row md:items-center md:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <CreditCard className="size-4 shrink-0 text-text-secondary" />
                <div>
                  <p className="font-medium">{m.nameAr}</p>
                  <p className="text-xs text-text-secondary">
                    {t(UNDERLYING_METHOD_LABEL_KEYS[m.underlyingMethod])}
                    {Object.entries(m.details).filter(([, v]) => v).map(([, v]) => ` — ${v}`).join('')}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge tone={m.customerVisible ? 'success' : 'neutral'} label={m.customerVisible ? t('billing.paymentMethods.visibleToCustomers') : t('billing.paymentMethods.hiddenFromCustomers')} />
                <StatusBadge tone={m.isActive ? 'success' : 'danger'} label={m.isActive ? t('billing.paymentMethods.active') : t('billing.paymentMethods.suspended')} />
                <Button size="sm" variant="outline" onClick={() => openEdit(m)}>{t('common.edit')}</Button>
                <Button size="sm" variant="outline" onClick={() => toggleVisibleMutation.mutate(m)}>
                  {m.customerVisible ? t('billing.paymentMethods.hide') : t('billing.paymentMethods.show')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => toggleActiveMutation.mutate(m)}>
                  {m.isActive ? t('billing.paymentMethods.deactivate') : t('billing.paymentMethods.activate')}
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
