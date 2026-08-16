import { useState } from 'react'
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
  details: Record<string, string>
  referenceRequired: boolean
  proofRequired: boolean
  customerVisible: boolean
  isActive: boolean
  displayOrder: number
}

const UNDERLYING_METHOD_LABELS: Record<UnderlyingMethod, string> = {
  cash: 'نقدًا',
  card: 'بطاقة / نقطة بيع',
  bank_transfer: 'تحويل بنكي',
  wallet: 'محفظة إلكترونية',
  other: 'أخرى / يدوية',
}

// Which "details" fields to collect per underlying method -- matches
// Sections 31 (InstaPay), 33 (wallets), 34 (bank accounts).
const DETAIL_FIELDS: Record<UnderlyingMethod, { key: string; label: string }[]> = {
  cash: [],
  card: [{ key: 'terminal_reference', label: 'مرجع الماكينة (اختياري)' }],
  bank_transfer: [
    { key: 'bank_name', label: 'اسم البنك' },
    { key: 'account_holder', label: 'اسم صاحب الحساب' },
    { key: 'account_number', label: 'رقم الحساب' },
    { key: 'iban', label: 'IBAN' },
    { key: 'swift', label: 'SWIFT / BIC' },
  ],
  wallet: [
    { key: 'phone', label: 'رقم الهاتف' },
    { key: 'beneficiary', label: 'اسم المستفيد' },
  ],
  other: [
    { key: 'phone', label: 'رقم الهاتف (اختياري)' },
    { key: 'link', label: 'رابط الدفع (اختياري)' },
  ],
}

async function fetchPaymentMethods(clubId: string): Promise<PaymentMethodRow[]> {
  const { data, error } = await supabase
    .from('payment_method_configs')
    .select('id, underlying_method, provider, name_ar, name_en, instructions_ar, details, reference_required, proof_required, customer_visible, is_active, display_order')
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
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [underlyingMethod, setUnderlyingMethod] = useState<UnderlyingMethod>('bank_transfer')
  const [nameAr, setNameAr] = useState('')
  const [nameEn, setNameEn] = useState('')
  const [instructionsAr, setInstructionsAr] = useState('')
  const [detailValues, setDetailValues] = useState<Record<string, string>>({})
  const [customerVisible, setCustomerVisible] = useState(true)
  const [formError, setFormError] = useState<string | null>(null)

  const { data: methods = [], isLoading } = useQuery({
    queryKey: ['payment-method-configs', currentClubId],
    queryFn: () => fetchPaymentMethods(currentClubId!),
    enabled: !!currentClubId,
  })

  const resetForm = () => {
    setUnderlyingMethod('bank_transfer')
    setNameAr('')
    setNameEn('')
    setInstructionsAr('')
    setDetailValues({})
    setCustomerVisible(true)
    setFormError(null)
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!nameAr.trim() || !nameEn.trim()) throw new Error('أدخل الاسم بالعربية والإنجليزية')
      const { error } = await supabase.from('payment_method_configs').insert({
        club_id: currentClubId!,
        underlying_method: underlyingMethod,
        name_ar: nameAr.trim(),
        name_en: nameEn.trim(),
        instructions_ar: instructionsAr.trim() || null,
        details: detailValues,
        customer_visible: customerVisible,
        display_order: methods.length,
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payment-method-configs', currentClubId] })
      setDialogOpen(false)
      resetForm()
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, 'تعذّر إضافة طريقة الدفع')),
  })

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const { error } = await supabase.from('payment_method_configs').update({ is_active: !isActive }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['payment-method-configs', currentClubId] }),
  })

  const toggleVisibleMutation = useMutation({
    mutationFn: async ({ id, customerVisible: visible }: { id: string; customerVisible: boolean }) => {
      const { error } = await supabase.from('payment_method_configs').update({ customer_visible: !visible }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['payment-method-configs', currentClubId] }),
  })

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">طرق الدفع</CardTitle>
        <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm() }}>
          <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
            <Plus className="me-1 size-4" /> إضافة طريقة دفع
          </Button>
          <DialogContent>
            <DialogHeader><DialogTitle>إضافة طريقة دفع</DialogTitle></DialogHeader>
            <div className="flex flex-col gap-3">
              {formError && <p className="text-sm text-status-danger">{formError}</p>}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">نوع الطريقة</label>
                <Select value={underlyingMethod} onValueChange={(v) => { setUnderlyingMethod(v as UnderlyingMethod); setDetailValues({}) }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(Object.keys(UNDERLYING_METHOD_LABELS) as UnderlyingMethod[]).map((m) => (
                      <SelectItem key={m} value={m}>{UNDERLYING_METHOD_LABELS[m]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium">الاسم (بالعربية)</label>
                  <Input value={nameAr} onChange={(e) => setNameAr(e.target.value)} placeholder="مثال: فودافون كاش" />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-sm font-medium">الاسم (بالإنجليزية)</label>
                  <Input value={nameEn} onChange={(e) => setNameEn(e.target.value)} placeholder="e.g. Vodafone Cash" />
                </div>
              </div>
              {DETAIL_FIELDS[underlyingMethod].map((field) => (
                <div key={field.key} className="flex flex-col gap-1">
                  <label className="text-sm font-medium">{field.label}</label>
                  <Input
                    value={detailValues[field.key] ?? ''}
                    onChange={(e) => setDetailValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  />
                </div>
              ))}
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium">تعليمات للعميل (اختياري)</label>
                <Input value={instructionsAr} onChange={(e) => setInstructionsAr(e.target.value)} placeholder="مثال: اذكر رقم الفاتورة عند التحويل" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={customerVisible} onChange={(e) => setCustomerVisible(e.target.checked)} className="size-4" />
                إظهار هذه الطريقة للعملاء عند الدفع
              </label>
              <Button onClick={() => createMutation.mutate()} disabled={createMutation.isPending}>
                حفظ
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {isLoading ? (
          <p className="text-sm text-text-secondary">جارٍ التحميل...</p>
        ) : methods.length === 0 ? (
          <p className="text-sm text-text-secondary">لا توجد طرق دفع بعد.</p>
        ) : (
          methods.map((m) => (
            <div key={m.id} className="flex flex-col gap-2 rounded-md border border-border p-3 text-sm md:flex-row md:items-center md:justify-between">
              <div className="flex items-center gap-2">
                <CreditCard className="size-4 shrink-0 text-text-secondary" />
                <div>
                  <p className="font-medium">{m.nameAr}</p>
                  <p className="text-xs text-text-secondary">
                    {UNDERLYING_METHOD_LABELS[m.underlyingMethod]}
                    {Object.entries(m.details).filter(([, v]) => v).map(([, v]) => ` — ${v}`).join('')}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <StatusBadge tone={m.customerVisible ? 'success' : 'neutral'} label={m.customerVisible ? 'ظاهرة للعملاء' : 'مخفية عن العملاء'} />
                <StatusBadge tone={m.isActive ? 'success' : 'danger'} label={m.isActive ? 'نشطة' : 'موقوفة'} />
                <Button size="sm" variant="outline" onClick={() => toggleVisibleMutation.mutate({ id: m.id, customerVisible: m.customerVisible })}>
                  {m.customerVisible ? 'إخفاء' : 'إظهار'}
                </Button>
                <Button size="sm" variant="outline" onClick={() => toggleActiveMutation.mutate({ id: m.id, isActive: m.isActive })}>
                  {m.isActive ? 'إيقاف' : 'تفعيل'}
                </Button>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
