import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  fetchInvoicePaymentSummaries,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONE,
  formatMoney,
  type PaymentStatus,
} from '@/lib/domain/billing'
import { translateSupabaseError } from '@/lib/errors'
import { Wallet } from 'lucide-react'

// Master Payment Directive Sections 46-53, 86-87: "My Payments" -- a
// customer sees every invoice with its real payment status (via the
// single source of truth from task #81), and for any invoice that
// still has an outstanding balance, sees the club's active/visible
// payment methods with their instructions and can claim a manual
// transfer. The claim NEVER marks anything paid by itself -- it stays
// pending until staff verifies it (verify_manual_payment_claim(), task
// #83's DB layer), matching Section 51 ("proof is not source of
// truth").

interface InvoiceRow {
  id: string
  invoiceNumber: string
  total: number
  paid: number
  outstanding: number
  paymentStatus: PaymentStatus
  issuedAt: string | null
}

interface PaymentMethodOption {
  id: string
  nameAr: string
  instructionsAr: string | null
  details: Record<string, string>
  referenceRequired: boolean
}

async function fetchMyInvoices(): Promise<InvoiceRow[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, invoice_number, total, status, issued_at')
    .order('created_at', { ascending: false })
    .limit(30)
  if (error) throw error

  const ids = (data ?? []).map((i) => i.id)
  const summaries = await fetchInvoicePaymentSummaries(ids)

  return (data ?? [])
    .filter((i) => i.status !== 'draft')
    .map((i) => {
      const s = summaries.get(i.id)
      return {
        id: i.id,
        invoiceNumber: i.invoice_number,
        total: Number(i.total),
        paid: s?.paid ?? 0,
        outstanding: s?.outstanding ?? Number(i.total),
        paymentStatus: s?.paymentStatus ?? 'unpaid',
        issuedAt: i.issued_at,
      }
    })
}

async function fetchVisiblePaymentMethods(clubId: string): Promise<PaymentMethodOption[]> {
  const { data, error } = await supabase
    .from('payment_method_configs')
    .select('id, name_ar, instructions_ar, details, reference_required')
    .eq('club_id', clubId)
    .eq('is_active', true)
    .eq('customer_visible', true)
    .order('display_order')
  if (error) throw error
  return (data ?? []).map((m) => ({
    id: m.id,
    nameAr: m.name_ar,
    instructionsAr: m.instructions_ar,
    details: (m.details as Record<string, string>) ?? {},
    referenceRequired: m.reference_required,
  }))
}

function ClaimPaymentDialog({ invoice, clubId, onClose }: { invoice: InvoiceRow; clubId: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [methodId, setMethodId] = useState<string | null>(null)
  const [amount, setAmount] = useState(invoice.outstanding.toFixed(2))
  const [reference, setReference] = useState('')
  const [proofNote, setProofNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitted, setSubmitted] = useState(false)

  const { data: methods = [] } = useQuery({
    queryKey: ['portal-payment-methods', clubId],
    queryFn: () => fetchVisiblePaymentMethods(clubId),
  })

  const selectedMethod = methods.find((m) => m.id === methodId) ?? null

  const claimMutation = useMutation({
    mutationFn: async () => {
      if (!methodId) throw new Error('اختر طريقة الدفع أولًا')
      const amountNum = Number(amount)
      if (Number.isNaN(amountNum) || amountNum <= 0) throw new Error('أدخل مبلغًا صحيحًا')
      if (selectedMethod?.referenceRequired && !reference.trim()) throw new Error('هذه الطريقة تتطلب رقم مرجعي للتحويل')
      const { error: rpcError } = await supabase.rpc('claim_manual_payment', {
        p_invoice_id: invoice.id,
        p_payment_method_config_id: methodId,
        p_claimed_amount: amountNum,
        p_reference: reference.trim() || undefined,
        p_proof_note: proofNote.trim() || undefined,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: () => {
      setSubmitted(true)
      queryClient.invalidateQueries({ queryKey: ['portal', 'my-invoices'] })
    },
    onError: (err) => setError(err instanceof Error ? err.message : translateSupabaseError(err, 'تعذّر إرسال طلب الدفع')),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>دفع فاتورة {invoice.invoiceNumber}</DialogTitle></DialogHeader>
        {submitted ? (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-status-success">تم إرسال طلبك بنجاح. سيقوم فريق النادي بمراجعته وتأكيده قريبًا.</p>
            <p className="text-text-secondary">لن يتغير حساب فاتورتك إلى "مدفوعة" إلا بعد تأكيد النادي للتحويل.</p>
            <Button onClick={onClose}>إغلاق</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            {error && <p className="text-status-danger">{error}</p>}
            <p className="text-text-secondary">المبلغ المتبقي: {formatMoney(invoice.outstanding)}</p>
            <div className="flex flex-col gap-1">
              <label className="font-medium">طريقة الدفع</label>
              <div className="flex flex-col gap-2">
                {methods.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setMethodId(m.id)}
                    className={`rounded-md border p-3 text-start ${methodId === m.id ? 'border-accent-foreground' : 'border-border'}`}
                  >
                    <p className="font-medium">{m.nameAr}</p>
                    {Object.entries(m.details).filter(([, v]) => v).map(([k, v]) => (
                      <p key={k} className="text-xs text-text-secondary">{v}</p>
                    ))}
                    {m.instructionsAr && <p className="text-xs text-text-secondary">{m.instructionsAr}</p>}
                  </button>
                ))}
                {methods.length === 0 && <p className="text-text-secondary">لا توجد طرق دفع متاحة حاليًا. تواصل مع النادي.</p>}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="font-medium">المبلغ الذي حوّلته</label>
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="font-medium">
                الرقم المرجعي للتحويل {selectedMethod?.referenceRequired ? '' : '(اختياري)'}
              </label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="font-medium">ملاحظة إثبات إضافية (اختياري)</label>
              <Input value={proofNote} onChange={(e) => setProofNote(e.target.value)} placeholder="مثال: رابط لقطة شاشة التحويل" />
            </div>
            <Button onClick={() => claimMutation.mutate()} disabled={claimMutation.isPending || !methodId}>
              إرسال طلب الدفع
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function PortalPaymentsPage() {
  const [claimingInvoice, setClaimingInvoice] = useState<InvoiceRow | null>(null)
  const [claimClubId, setClaimClubId] = useState<string | null>(null)
  // IA restructuring (Phase 10): auto-open the claim dialog when arriving
  // via PortalBookingsPage's "الفاتورة والدفع" cross-link (?invoiceId=)
  // and that invoice still has an outstanding balance -- otherwise the
  // customer lands on the full list and has to find the same invoice
  // again by eye, defeating the point of a direct link.
  const [searchParams] = useSearchParams()

  const { data: invoices = [], isLoading } = useQuery({ queryKey: ['portal', 'my-invoices'], queryFn: fetchMyInvoices })

  useEffect(() => {
    const invoiceId = searchParams.get('invoiceId')
    if (!invoiceId || claimingInvoice) return
    const target = invoices.find((i) => i.id === invoiceId)
    if (target && target.outstanding > 0) {
      void supabase.from('invoices').select('club_id').eq('id', invoiceId).single().then(({ data }) => {
        setClaimClubId(data?.club_id ?? null)
        setClaimingInvoice(target)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices, searchParams])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="مدفوعاتي" description="فواتيرك وحالة السداد وطرق الدفع" />

      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}

      {!isLoading && invoices.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          لا توجد فواتير بعد.
        </p>
      )}

      <div className="flex flex-col gap-2">
        {invoices.map((inv) => (
          <Card key={inv.id}>
            <CardContent className="flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="font-medium">{inv.invoiceNumber}</p>
                <StatusBadge tone={PAYMENT_STATUS_TONE[inv.paymentStatus]} label={PAYMENT_STATUS_LABELS[inv.paymentStatus]} />
              </div>
              <div className="flex justify-between text-sm text-text-secondary">
                <span>الإجمالي {formatMoney(inv.total)}</span>
                <span>المدفوع {formatMoney(inv.paid)}</span>
              </div>
              {inv.outstanding > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-status-danger">المتبقي {formatMoney(inv.outstanding)}</span>
                  <Button size="sm" onClick={async () => {
                    const { data } = await supabase.from('invoices').select('club_id').eq('id', inv.id).single()
                    setClaimClubId(data?.club_id ?? null)
                    setClaimingInvoice(inv)
                  }}>
                    <Wallet className="me-1 size-4" /> دفع الآن
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>

      {claimingInvoice && claimClubId && (
        <ClaimPaymentDialog
          invoice={claimingInvoice}
          clubId={claimClubId}
          onClose={() => { setClaimingInvoice(null); setClaimClubId(null) }}
        />
      )}
    </div>
  )
}
