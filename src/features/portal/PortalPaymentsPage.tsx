import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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
import { useDirection } from '@/app/providers/DirectionProvider'
import { usePortalClub } from '@/app/providers/PortalClubProvider'
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

// Multi-Club E2E audit (2026-08-24): scoped per-club so a customer
// linked to more than one club doesn't see every club's invoices
// interleaved.
//
// PORTAL CROSS-PERSONA AUTHORIZATION VULNERABILITY FIX (HIGH, 2026-08-25):
// the original `.eq('club_id', clubId)` filter alone was NOT sufficient
// -- invoices_select_club_staff RLS is ALSO club_id-scoped, so a staff
// member's Portal session received every customer's invoices in that
// club. Proven live via a real authenticated REST call (5 real
// unrelated invoices, real amounts, returned to a Portal session with no
// linked customer at all). Now filters by `customer_id`, sourced
// exclusively from get_my_portal_customers() -- see the same rationale
// on PortalBookingsPage.fetchMyBookings.
async function fetchMyInvoices(customerId: string): Promise<InvoiceRow[]> {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, invoice_number, total, status, issued_at')
    .eq('customer_id', customerId)
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
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { locale } = useDirection()
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
      if (!methodId) throw new Error(t('portal.paymentsPage.claimDialog.selectMethodError'))
      const amountNum = Number(amount)
      if (Number.isNaN(amountNum) || amountNum <= 0) throw new Error(t('portal.paymentsPage.claimDialog.invalidAmountError'))
      if (selectedMethod?.referenceRequired && !reference.trim()) throw new Error(t('portal.paymentsPage.claimDialog.referenceRequiredError'))
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
    onError: (err) => setError(err instanceof Error ? err.message : translateSupabaseError(err, t('portal.paymentsPage.claimDialog.genericError'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('portal.paymentsPage.claimDialog.titlePrefix')} <bdi>{invoice.invoiceNumber}</bdi></DialogTitle></DialogHeader>
        {submitted ? (
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-status-success">{t('portal.paymentsPage.claimDialog.submittedMessage')}</p>
            <p className="text-text-secondary">{t('portal.paymentsPage.claimDialog.submittedHint')}</p>
            <Button onClick={onClose}>{t('portal.paymentsPage.claimDialog.close')}</Button>
          </div>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            {error && <p className="text-status-danger">{error}</p>}
            <p className="text-text-secondary">{t('portal.paymentsPage.claimDialog.outstandingAmount', { amount: formatMoney(invoice.outstanding, 'EGP', locale) })}</p>
            <div className="flex flex-col gap-1">
              <label className="font-medium">{t('portal.paymentsPage.claimDialog.methodLabel')}</label>
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
                {methods.length === 0 && <p className="text-text-secondary">{t('portal.paymentsPage.claimDialog.noMethodsAvailable')}</p>}
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="font-medium">{t('portal.paymentsPage.claimDialog.amountTransferredLabel')}</label>
              <Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="font-medium">
                {t('portal.paymentsPage.claimDialog.referenceLabel')} {selectedMethod?.referenceRequired ? '' : t('portal.paymentsPage.claimDialog.optionalSuffix')}
              </label>
              <Input value={reference} onChange={(e) => setReference(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <label className="font-medium">{t('portal.paymentsPage.claimDialog.proofNoteLabel')}</label>
              <Input value={proofNote} onChange={(e) => setProofNote(e.target.value)} placeholder={t('portal.paymentsPage.claimDialog.proofNotePlaceholder')} />
            </div>
            <Button onClick={() => claimMutation.mutate()} disabled={claimMutation.isPending || !methodId}>
              {t('portal.paymentsPage.claimDialog.submit')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function PortalPaymentsPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const [claimingInvoice, setClaimingInvoice] = useState<InvoiceRow | null>(null)
  const [claimClubId, setClaimClubId] = useState<string | null>(null)
  // IA restructuring (Phase 10): auto-open the claim dialog when arriving
  // via PortalBookingsPage's "الفاتورة والدفع" cross-link (?invoiceId=)
  // and that invoice still has an outstanding balance -- otherwise the
  // customer lands on the full list and has to find the same invoice
  // again by eye, defeating the point of a direct link.
  const [searchParams] = useSearchParams()
  // Master IA/UX audit (Customer Portal phase): confirmed a real gap --
  // an ?invoiceId= that doesn't match any of this customer's own
  // invoices (wrong id, or genuinely someone else's) silently fell
  // through with zero feedback. A match with zero outstanding is NOT
  // an error case (the invoice is just already paid -- the claim
  // dialog correctly has nothing to do), so only the not-found case
  // gets a message.
  const [invoiceNotFound, setInvoiceNotFound] = useState(false)
  // Multi-Club E2E audit (2026-08-24): same deep-link-to-a-different-club
  // disambiguation as PortalQrPage's wrongClubBookingId -- an
  // ?invoiceId= can legitimately belong to another linked club now that
  // this query is club-scoped.
  const [wrongClubInvoiceId, setWrongClubInvoiceId] = useState<string | null>(null)
  const { activeCustomerId, isLoading: clubLoading, customerMemberships, setActiveClubId } = usePortalClub()

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['portal', 'my-invoices', activeCustomerId],
    queryFn: () => fetchMyInvoices(activeCustomerId!),
    enabled: !!activeCustomerId,
  })

  useEffect(() => {
    if (isLoading) return
    const invoiceId = searchParams.get('invoiceId')
    if (!invoiceId || claimingInvoice) return
    const target = invoices.find((i) => i.id === invoiceId)
    if (target && target.outstanding > 0) {
      setWrongClubInvoiceId(null)
      void supabase.from('invoices').select('club_id').eq('id', invoiceId).single().then(({ data }) => {
        setClaimClubId(data?.club_id ?? null)
        setClaimingInvoice(target)
      })
    } else if (!target && customerMemberships.length > 1) {
      void supabase.from('invoices').select('club_id').eq('id', invoiceId).maybeSingle().then(({ data }) => {
        if (data?.club_id && customerMemberships.some((m) => m.clubId === data.club_id)) {
          setWrongClubInvoiceId(invoiceId)
        } else {
          setInvoiceNotFound(true)
        }
      })
    } else if (!target) {
      setInvoiceNotFound(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoices, isLoading, searchParams])

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t('portal.paymentsPage.title')} description={t('portal.paymentsPage.description')} />

      {(isLoading || clubLoading) && <p className="text-sm text-text-secondary">{t('portal.paymentsPage.loading')}</p>}

      {!isLoading && invoiceNotFound && (
        <p role="alert" className="rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-sm text-status-warning">
          {t('portal.paymentsPage.invoiceNotFound')}
        </p>
      )}

      {!isLoading && wrongClubInvoiceId && (
        <div role="alert" className="flex flex-col gap-2 rounded-lg border border-status-warning/30 bg-status-warning/5 p-3 text-sm text-status-warning">
          <p>{t('portal.paymentsPage.wrongClubInvoice')}</p>
          <button
            type="button"
            className="self-start font-medium underline"
            onClick={async () => {
              const { data } = await supabase.from('invoices').select('club_id').eq('id', wrongClubInvoiceId).maybeSingle()
              if (data?.club_id) setActiveClubId(data.club_id)
              setWrongClubInvoiceId(null)
            }}
          >
            {t('portal.paymentsPage.switchClubAction')}
          </button>
        </div>
      )}

      {!isLoading && invoices.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          {t('portal.paymentsPage.emptyTitle')}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {invoices.map((inv) => (
          <Card key={inv.id}>
            <CardContent className="flex flex-col gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="font-medium"><bdi>{inv.invoiceNumber}</bdi></p>
                <StatusBadge
                  tone={PAYMENT_STATUS_TONE[inv.paymentStatus]}
                  label={t(`secureBooking.paymentStatusLabels.${inv.paymentStatus}`, { defaultValue: PAYMENT_STATUS_LABELS[inv.paymentStatus] })}
                />
              </div>
              <div className="flex justify-between text-sm text-text-secondary">
                <span>{t('portal.paymentsPage.total', { amount: formatMoney(inv.total, 'EGP', locale) })}</span>
                <span>{t('portal.paymentsPage.paid', { amount: formatMoney(inv.paid, 'EGP', locale) })}</span>
              </div>
              {inv.outstanding > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-status-danger">{t('portal.paymentsPage.outstanding', { amount: formatMoney(inv.outstanding, 'EGP', locale) })}</span>
                  <Button size="sm" onClick={async () => {
                    const { data } = await supabase.from('invoices').select('club_id').eq('id', inv.id).single()
                    setClaimClubId(data?.club_id ?? null)
                    setClaimingInvoice(inv)
                  }}>
                    <Wallet className="me-1 size-4" /> {t('portal.paymentsPage.payNow')}
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
