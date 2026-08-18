import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { MoneyDisplay } from '@/components/ui/money-display'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONE,
  type PaymentRow,
  fetchInvoicePaymentSummaries,
  type PaymentStatus,
} from '@/lib/domain/billing'
import { Trash2 } from 'lucide-react'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'

// Invoice list, invoice detail (view + print), payment collection form,
// refund flow. Print CSS via @media print rules scoped to #invoice-print.
interface InvoiceListRow {
  id: string
  invoiceNumber: string
  customerName: string
  status: string
  total: number
  paid: number
  outstanding: number
  paymentStatus: PaymentStatus
  source: string
  issuedAt: string | null
}

const SOURCE_KEYS = new Set(['booking', 'subscription'])

// Master Payment Directive task #81: was total - sum(payment_allocations)
// computed locally, missing refund netting -- the primary invoice list
// every club employee sees daily showed too-LOW an outstanding balance
// for any invoice paid then refunded. Now reads
// get_invoice_payment_summary(), the single source of truth (see
// AUTONOMOUS_DECISION_LOG.md D-015).
async function fetchInvoices(clubId: string) {
  const { data, error } = await supabase
    .from('invoices')
    .select('id, invoice_number, status, total, issued_at, customers(full_name), invoice_items(reference_type)')
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error

  const invoiceIds = (data ?? []).map((row) => row.id)
  const summaries = await fetchInvoicePaymentSummaries(invoiceIds)

  return (data ?? []).map<InvoiceListRow>((row) => {
    const summary = summaries.get(row.id)
    const total = Number(row.total)
    const items = (row.invoice_items as unknown as { reference_type: string }[] | null) ?? []
    return {
      id: row.id,
      invoiceNumber: row.invoice_number,
      customerName: (row.customers as unknown as { full_name: string } | null)?.full_name ?? '—',
      status: row.status,
      total,
      paid: summary?.paid ?? 0,
      outstanding: summary?.outstanding ?? total,
      paymentStatus: summary?.paymentStatus ?? 'unpaid',
      source: SOURCE_KEYS.has(items[0]?.reference_type ?? '') ? (items[0]!.reference_type as string) : 'other',
      issuedAt: row.issued_at,
    }
  })
}

// Master Payment Directive task #83 (staff side): a customer-claimed
// manual transfer sits here as 'pending' until staff reviews it.
// verify_manual_payment_claim() is the only path that ever calls the
// real record_payment() RPC -- this list never marks anything paid
// directly.
interface PendingClaimRow {
  id: string
  invoiceId: string
  invoiceNumber: string
  customerName: string
  claimedAmount: number
  reference: string | null
  proofNote: string | null
  claimedAt: string
  methodName: string | null
}

async function fetchPendingClaims(clubId: string): Promise<PendingClaimRow[]> {
  const { data, error } = await supabase
    .from('manual_payment_claims')
    .select('id, invoice_id, claimed_amount, reference, proof_note, claimed_at, invoices(invoice_number, customers(full_name)), payment_method_configs(name_ar)')
    .eq('club_id', clubId)
    .eq('status', 'pending')
    .order('claimed_at', { ascending: true })
  if (error) throw error
  return (data ?? []).map((c) => ({
    id: c.id,
    invoiceId: c.invoice_id,
    invoiceNumber: (c.invoices as unknown as { invoice_number: string } | null)?.invoice_number ?? '—',
    customerName: (c.invoices as unknown as { customers: { full_name: string } | null } | null)?.customers?.full_name ?? '—',
    claimedAmount: Number(c.claimed_amount),
    reference: c.reference,
    proofNote: c.proof_note,
    claimedAt: c.claimed_at,
    methodName: (c.payment_method_configs as unknown as { name_ar: string } | null)?.name_ar ?? null,
  }))
}

async function fetchInvoiceDetail(invoiceId: string) {
  const { data, error } = await supabase
    .from('invoices')
    .select('*, customers(full_name, mobile_display), invoice_items(*)')
    .eq('id', invoiceId)
    .single()
  if (error) throw error
  return data
}

async function fetchInvoicePayments(invoiceId: string) {
  const { data, error } = await supabase
    .from('payment_allocations')
    .select('amount, payments(id, amount, method, received_at, reference, received_by)')
    .eq('invoice_id', invoiceId)
  if (error) throw error

  const rawPayments = (data ?? [])
    .map((row) => row.payments as unknown as { id: string; amount: number; method: string; received_at: string; reference: string | null; received_by: string | null } | null)
    .filter((p): p is NonNullable<typeof p> => !!p)

  // Gate 13 #57 (employee financial attribution audit): payments.received_by
  // was always correctly populated server-side (record_payment() hardcodes
  // auth.uid(), never a client-supplied value), but nothing in the UI ever
  // surfaced WHO collected a payment. profiles_select_same_club_staff RLS
  // already allows reading a fellow club staff member's profile, so this is
  // a pure display gap, not a data or security one.
  const collectorIds = [...new Set(rawPayments.map((p) => p.received_by).filter((id): id is string => !!id))]
  const namesById = new Map<string, string>()
  if (collectorIds.length > 0) {
    const { data: collectors } = await supabase.from('profiles').select('user_id, full_name').in('user_id', collectorIds)
    for (const c of collectors ?? []) if (c.full_name) namesById.set(c.user_id, c.full_name)
  }

  return rawPayments.map<PaymentRow>((p) => ({
    id: p.id,
    amount: Number(p.amount),
    method: p.method,
    receivedAt: p.received_at,
    reference: p.reference,
    receivedByName: p.received_by ? (namesById.get(p.received_by) ?? null) : null,
  }))
}

const DEFAULT_INVOICE_STATUS_KEY = 'billing.invoiceStatusLabels.draft'
const INVOICE_STATUS_LABEL_KEYS: Record<string, string> = {
  draft: DEFAULT_INVOICE_STATUS_KEY,
  issued: 'billing.invoiceStatusLabels.issued',
  void: 'billing.invoiceStatusLabels.void',
}

export function BillingPage() {
  const { currentClubId } = useAuth()
  const { t } = useTranslation()
  const { locale } = useDirection()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  // Master IA/UX audit (Club Side Booking 360 phase): BookingDetailSheet
  // showed the outstanding balance read-only with no way to reach the
  // actual invoice on BillingPage -- same minimal ?param= deep-link
  // pattern already used for Reports' customer search cross-link
  // (CustomersPage's ?q=), not new infrastructure.
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<string | null>(() => searchParams.get('invoice'))
  const [printSize, setPrintSize] = useState<'a4' | '80mm'>('a4')
  const [refundPaymentId, setRefundPaymentId] = useState<string | null>(null)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const [voidReason, setVoidReason] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['invoices', currentClubId],
    queryFn: () => fetchInvoices(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: pendingClaims = [] } = useQuery({
    queryKey: ['pending-payment-claims', currentClubId],
    queryFn: () => fetchPendingClaims(currentClubId!),
    enabled: !!currentClubId,
  })

  const reviewClaimMutation = useMutation({
    mutationFn: async ({ claimId, approve }: { claimId: string; approve: boolean }) => {
      const { error } = await supabase.rpc('verify_manual_payment_claim', { p_claim_id: claimId, p_approve: approve })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['pending-payment-claims', currentClubId] })
      void queryClient.invalidateQueries({ queryKey: ['invoices', currentClubId] })
      invalidateDetail()
    },
    onError: (error) => setFormError(translateSupabaseError(error, t('billing.reviewClaim.genericError'))),
  })

  const { data: detail } = useQuery({
    queryKey: ['invoice-detail', selectedInvoiceId],
    queryFn: () => fetchInvoiceDetail(selectedInvoiceId!),
    enabled: !!selectedInvoiceId,
  })

  const { data: payments = [] } = useQuery({
    queryKey: ['invoice-payments', selectedInvoiceId],
    queryFn: () => fetchInvoicePayments(selectedInvoiceId!),
    enabled: !!selectedInvoiceId,
  })

  // task #84: the payment form previously gave staff no visibility into
  // how much was actually left owing on this invoice -- they had to do
  // the total-minus-paid math themselves, error-prone the moment an
  // invoice already had a partial payment or a refund on it. Reuses the
  // exact same single-source-of-truth RPC every other screen in this app
  // uses (task #81) rather than re-deriving the number here.
  const { data: paymentSummary } = useQuery({
    queryKey: ['invoice-payment-summary', selectedInvoiceId],
    queryFn: async () => {
      const map = await fetchInvoicePaymentSummaries([selectedInvoiceId!])
      return map.get(selectedInvoiceId!) ?? null
    },
    enabled: !!selectedInvoiceId,
  })

  // task #86: secure invoice QR + public verification page
  // (/verify/:token, no login required -- see VerifyInvoicePage.tsx).
  // ensure_invoice_qr() only requires an issued (non-draft) invoice --
  // generated once per dialog open and reused, not regenerated on every
  // render (the RPC itself is idempotent-safe to call repeatedly, but
  // there's no reason to mint a fresh token + revoke the previous one
  // every time this query re-runs).
  const { data: verifyQrDataUrl } = useQuery({
    queryKey: ['invoice-verify-qr', selectedInvoiceId],
    queryFn: async () => {
      const { data: token, error } = await supabase.rpc('ensure_invoice_qr', { p_invoice_id: selectedInvoiceId! })
      if (error) throw error
      const url = `${window.location.origin}/verify/${token}`
      return QRCode.toDataURL(url, { width: 120, margin: 1 })
    },
    enabled: !!selectedInvoiceId && detail?.status === 'issued',
    staleTime: Infinity,
  })

  function invalidateDetail() {
    void queryClient.invalidateQueries({ queryKey: ['invoice-detail', selectedInvoiceId] })
    void queryClient.invalidateQueries({ queryKey: ['invoice-payments', selectedInvoiceId] })
    void queryClient.invalidateQueries({ queryKey: ['invoice-payment-summary', selectedInvoiceId] })
    void queryClient.invalidateQueries({ queryKey: ['invoices', currentClubId] })
  }

  // task #84 (split payments): a single checkout moment can legitimately
  // involve more than one payment method (e.g. the customer pays part
  // cash, part card). The data model already supports this correctly --
  // each method becomes its own real payments row via its own
  // record_payment() call, exactly like two payments recorded minutes
  // apart already worked -- this is a UI change (a list of method+amount
  // lines submitted together, client-side sum validated against the
  // outstanding balance before any call is made), not a schema or RPC
  // change. Each line is recorded with its own record_payment() call in
  // sequence; if a later line fails (e.g. a race against another
  // recorded payment shrinking the true outstanding balance), the
  // earlier lines already succeeded and are NOT rolled back -- this
  // matches record_payment()'s own per-call transactional guarantee
  // (it's a single top-level RPC call, not part of a larger client-side
  // transaction) and is the same behavior as recording those same
  // payments one at a time in separate submissions.
  interface SplitLine {
    key: string
    amount: string
    method: string
  }
  const [splitLines, setSplitLines] = useState<SplitLine[]>([{ key: crypto.randomUUID(), amount: '', method: 'cash' }])
  const splitTotal = splitLines.reduce((sum, l) => sum + (Number(l.amount) || 0), 0)
  const outstandingForSelected = paymentSummary?.outstanding ?? null

  function resetSplitForm() {
    setSplitLines([{ key: crypto.randomUUID(), amount: '', method: 'cash' }])
  }

  useEffect(() => {
    resetSplitForm()
    setFormError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedInvoiceId])

  const recordPaymentMutation = useMutation({
    mutationFn: async () => {
      if (!selectedInvoiceId) throw new Error('no invoice selected')
      const validLines = splitLines.filter((l) => Number(l.amount) > 0)
      if (validLines.length === 0) throw new Error(t('billing.recordPayment.enterAtLeastOneAmount'))
      if (outstandingForSelected !== null && splitTotal - outstandingForSelected > 0.01) {
        throw new Error(t('billing.recordPayment.amountExceedsOutstanding', { total: splitTotal.toFixed(2), outstanding: outstandingForSelected.toFixed(2) }))
      }
      // Sequential, not parallel -- each record_payment() call re-checks
      // the outstanding balance server-side against the latest state, so
      // running them one after another (not Promise.all) means the
      // second line's own server-side check sees the first line's
      // allocation already applied, which is the correct behavior for
      // "two lines that together must not exceed the outstanding
      // balance" rather than two calls racing against the same stale
      // outstanding figure.
      // Security P0 fix (MAL3ABY_PRODUCTION_READINESS.md C3): each
      // split line's own `key` (already a stable per-line UUID, see
      // splitLines state above) doubles as its idempotency key -- a
      // retry of this same mutation (e.g. after line 1 succeeds and
      // line 2's network call times out) resends the SAME key for
      // line 1, which record_payment() now recognizes as the same
      // attempt and returns the existing payment rather than
      // recording it twice, while line 2 still gets its own fresh key.
      for (const line of validLines) {
        const { error } = await supabase.rpc('record_payment', {
          p_invoice_id: selectedInvoiceId,
          p_amount: Number(line.amount),
          p_method: line.method,
          p_idempotency_key: line.key,
        })
        if (error) throw error
      }
    },
    onSuccess: () => {
      resetSplitForm()
      setFormError(null)
      invalidateDetail()
    },
    onError: (error) => setFormError(error instanceof Error && !('code' in error) ? error.message : translateSupabaseError(error, t('billing.recordPayment.genericError'))),
  })

  // task #85: create_refund() succeeds server-side but the UI never
  // offered any printable proof of a refund happening -- a customer
  // asking "where's my refund receipt" had nothing to hand them. Capture
  // enough of the just-completed refund (amount/reason/method/invoice
  // number, all already in scope at the moment of success) to render a
  // receipt using the exact same #invoice-print A4/80mm print CSS
  // already built for invoices (Phase 7) -- reused, not a second print
  // stylesheet.
  interface RefundReceiptData {
    refundAmount: number
    reason: string
    method: string
    invoiceNumber: string
    customerName: string
    refundedAt: string
  }
  const [refundReceipt, setRefundReceipt] = useState<RefundReceiptData | null>(null)

  const refundMutation = useMutation({
    mutationFn: async () => {
      if (!refundPaymentId) throw new Error('no payment selected')
      const paymentBeingRefunded = payments.find((p) => p.id === refundPaymentId)
      const { error } = await supabase.rpc('create_refund', {
        p_payment_id: refundPaymentId,
        p_amount: Number(refundAmount),
        p_reason: refundReason,
      })
      if (error) throw error
      return paymentBeingRefunded
    },
    onSuccess: (paymentBeingRefunded) => {
      setRefundReceipt({
        refundAmount: Number(refundAmount),
        reason: refundReason,
        method: paymentBeingRefunded?.method ?? '—',
        invoiceNumber: detail?.invoice_number ?? '—',
        customerName: (detail?.customers as unknown as { full_name: string })?.full_name ?? '—',
        refundedAt: new Date().toISOString(),
      })
      setRefundPaymentId(null)
      setRefundAmount('')
      setRefundReason('')
      invalidateDetail()
    },
    onError: (error) => setFormError(translateSupabaseError(error, t('billing.refund.genericError'))),
  })

  // V1 Implementation Gap Audit (2026-08-16): void_invoice had a working,
  // permission-gated RPC but no UI anywhere. Only offered in this UI when
  // the invoice has zero payments allocated (see the "لا توجد مدفوعات
  // بعد" guard below) -- the RPC itself doesn't block voiding a
  // partially/fully-paid invoice, so this UI is deliberately more
  // conservative than the server strictly requires, to avoid stranding
  // an already-allocated payment against a voided invoice.
  const voidMutation = useMutation({
    mutationFn: async () => {
      if (!selectedInvoiceId) throw new Error('no invoice selected')
      const { error } = await supabase.rpc('void_invoice', { p_invoice_id: selectedInvoiceId, p_reason: voidReason })
      if (error) throw error
    },
    onSuccess: () => {
      setVoidReason('')
      setFormError(null)
      invalidateDetail()
    },
    onError: (error) => setFormError(translateSupabaseError(error, t('billing.voidInvoice.genericError'))),
  })

  const columns: DataTableColumn<InvoiceListRow>[] = [
    {
      key: 'number',
      header: t('billing.table.invoiceNumber'),
      render: (r) => (
        <button className="text-accent-foreground hover:underline" onClick={() => setSelectedInvoiceId(r.id)}>
          <bdi>{r.invoiceNumber}</bdi>
        </button>
      ),
    },
    { key: 'customer', header: t('billing.table.customer'), render: (r) => r.customerName },
    { key: 'source', header: t('billing.table.source'), render: (r) => t(`billing.sourceLabels.${r.source}`) },
    { key: 'date', header: t('billing.table.date'), render: (r) => (r.issuedAt ? new Date(r.issuedAt).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') : '—') },
    { key: 'total', header: t('billing.table.total'), render: (r) => <MoneyDisplay amount={r.total} size="sm" /> },
    { key: 'paid', header: t('billing.table.paid'), render: (r) => <MoneyDisplay amount={r.paid} size="sm" tone={r.paid > 0 ? 'success' : 'default'} /> },
    { key: 'outstanding', header: t('billing.table.outstanding'), render: (r) => (r.outstanding > 0 ? <MoneyDisplay amount={r.outstanding} size="sm" tone="danger" /> : <span className="text-status-success text-sm">—</span>) },
    {
      key: 'status',
      header: t('billing.table.status'),
      render: (r) => (
        <StatusBadge
          tone={r.status === 'issued' ? 'success' : r.status === 'void' ? 'neutral' : 'warning'}
          label={t(INVOICE_STATUS_LABEL_KEYS[r.status] ?? DEFAULT_INVOICE_STATUS_KEY)}
        />
      ),
    },
  ]

  const totalOutstanding = invoices.reduce((sum, r) => sum + r.outstanding, 0)
  const totalCollectedToday = invoices
    .filter((r) => r.issuedAt && new Date(r.issuedAt).toDateString() === new Date().toDateString())
    .reduce((sum, r) => sum + r.paid, 0)
  const partialCount = invoices.filter((r) => r.paid > 0 && r.outstanding > 0).length
  const owingCustomersCount = new Set(invoices.filter((r) => r.outstanding > 0).map((r) => r.customerName)).size

  return (
    <div>
      <PageHeader title={t('billing.page.title')} description={t('billing.page.description')} />

      {pendingClaims.length > 0 && (
        <div className="mb-4 rounded-lg border border-status-warning/40 bg-status-warning/5 p-4">
          <p className="mb-2 font-medium">{t('billing.pendingClaims.heading', { count: pendingClaims.length })}</p>
          <div className="flex flex-col gap-2">
            {pendingClaims.map((c) => (
              <div key={c.id} className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3 text-sm md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-medium">{c.customerName} — <bdi>{c.invoiceNumber}</bdi></p>
                  <p className="text-xs text-text-secondary">
                    {c.methodName ?? '—'} — <MoneyDisplay amount={c.claimedAmount} size="sm" />
                    {c.reference && ` — ${t('billing.pendingClaims.reference', { reference: c.reference })}`}
                    {c.proofNote && ` — ${c.proofNote}`}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => reviewClaimMutation.mutate({ claimId: c.id, approve: true })} disabled={reviewClaimMutation.isPending}>
                    {t('billing.pendingClaims.confirm')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => reviewClaimMutation.mutate({ claimId: c.id, approve: false })} disabled={reviewClaimMutation.isPending}>
                    {t('billing.pendingClaims.reject')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-text-secondary">{t('billing.stats.totalOutstanding')}</p>
          <MoneyDisplay amount={totalOutstanding} size="lg" tone={totalOutstanding > 0 ? 'danger' : 'default'} />
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-text-secondary">{t('billing.stats.collectedToday')}</p>
          <MoneyDisplay amount={totalCollectedToday} size="lg" tone="success" />
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-text-secondary">{t('billing.stats.partiallyPaidInvoices')}</p>
          <p className="text-2xl font-bold tabular-nums">{partialCount}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-text-secondary">{t('billing.stats.customersWithDues')}</p>
          <p className="text-2xl font-bold tabular-nums text-status-danger">{owingCustomersCount}</p>
        </div>
      </div>

      <DataTable columns={columns} rows={invoices} rowKey={(r) => r.id} isLoading={isLoading} emptyTitle={t('billing.table.emptyTitle')} />

      <Dialog open={!!selectedInvoiceId} onOpenChange={(open) => !open && setSelectedInvoiceId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('billing.detail.invoicePrefix')} <bdi>{detail?.invoice_number}</bdi></DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="flex flex-col gap-4">
              <div
                data-print-size={printSize}
                className={`print-target rounded-md border border-border p-4 text-sm print:border-0 ${refundReceipt ? '' : 'visible-for-print'}`}
              >
                <div className="mb-3 flex justify-between">
                  <div>
                    <p className="font-bold">{t('billing.detail.invoicePrefix')} <bdi>{detail.invoice_number}</bdi></p>
                    <p className="text-text-secondary">
                      {(detail.customers as unknown as { full_name: string })?.full_name}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1 print:hidden">
                    <StatusBadge
                      tone={detail.status === 'issued' ? 'success' : 'neutral'}
                      label={t(INVOICE_STATUS_LABEL_KEYS[detail.status] ?? DEFAULT_INVOICE_STATUS_KEY)}
                    />
                    {paymentSummary && (
                      <StatusBadge
                        tone={PAYMENT_STATUS_TONE[paymentSummary.paymentStatus]}
                        label={PAYMENT_STATUS_LABELS[paymentSummary.paymentStatus]}
                      />
                    )}
                  </div>
                </div>
                {verifyQrDataUrl && (
                  <div className="mb-3 flex items-center gap-2">
                    <img src={verifyQrDataUrl} alt={t('billing.detail.verifyQrAlt')} className="size-20" />
                    <p className="text-xs text-text-secondary">
                      {t('billing.detail.verifyQrHint')}
                    </p>
                  </div>
                )}
                <table className="w-full text-start">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="p-1 text-start">{t('billing.detail.itemHeader')}</th>
                      <th className="p-1 text-start">{t('billing.detail.quantityHeader')}</th>
                      <th className="p-1 text-start">{t('billing.detail.priceHeader')}</th>
                      <th className="p-1 text-start">{t('billing.detail.totalHeader')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(detail.invoice_items as unknown as Array<{ id: string; description: string; quantity: number; unit_price: number; line_total: number }>)?.map((item) => (
                      <tr key={item.id} className="border-b border-border">
                        <td className="p-1">{item.description}</td>
                        <td className="p-1">{item.quantity}</td>
                        <td className="p-1">{item.unit_price}</td>
                        <td className="p-1">{item.line_total}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="mt-3 flex flex-col items-end gap-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-text-secondary">{t('billing.detail.total')}</span>
                    <MoneyDisplay amount={Number(detail.total)} size="lg" />
                  </div>
                  {paymentSummary && paymentSummary.paid > 0 && (
                    <div className="flex items-center gap-2 print:hidden">
                      <span className="text-xs text-text-secondary">{t('billing.detail.paid')}</span>
                      <MoneyDisplay amount={paymentSummary.paid} size="sm" tone="success" />
                    </div>
                  )}
                  {paymentSummary && paymentSummary.outstanding > 0 && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-text-secondary">{t('billing.detail.outstanding')}</span>
                      <MoneyDisplay amount={paymentSummary.outstanding} size="lg" tone="danger" />
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 print:hidden">
                <Select value={printSize} onValueChange={(v) => setPrintSize(v as 'a4' | '80mm')}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="a4">A4</SelectItem>
                    <SelectItem value="80mm">{t('billing.detail.receiptSize80mm')}</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" className="w-fit" onClick={() => window.print()}>
                  {t('billing.detail.print')}
                </Button>
              </div>

              <div className="print:hidden">
                <p className="mb-2 font-medium">{t('billing.detail.paymentsHeading')}</p>
                {payments.length === 0 ? (
                  <p className="text-sm text-text-secondary">{t('billing.detail.noPayments')}</p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {payments.map((p) => (
                      <li key={p.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                        <span>
                          <MoneyDisplay amount={p.amount} size="sm" /> — {PAYMENT_METHOD_LABELS[p.method] ?? p.method}
                          {p.receivedByName && (
                            <span className="text-text-secondary"> — {t('billing.detail.collectedBy', { name: p.receivedByName })}</span>
                          )}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setRefundPaymentId(p.id)}
                        >
                          {t('billing.detail.refund')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {detail.status === 'issued' && outstandingForSelected !== null && outstandingForSelected > 0 && (
                <div className="flex flex-col gap-2 border-t border-border pt-3 print:hidden">
                  <div className="flex items-center justify-between">
                    <p className="font-medium">{t('billing.recordPayment.heading')}</p>
                    <p className="text-xs text-text-secondary">
                      {t('billing.recordPayment.outstandingPrefix')} <span className="font-medium text-status-danger">{outstandingForSelected.toFixed(2)}</span>
                    </p>
                  </div>
                  <p className="text-xs text-text-secondary">
                    {t('billing.recordPayment.splitHint')}
                  </p>
                  <div className="flex flex-col gap-2">
                    {splitLines.map((line, idx) => (
                      <div key={line.key} className="flex gap-2">
                        <Input
                          type="number"
                          placeholder={t('billing.recordPayment.amountPlaceholder')}
                          value={line.amount}
                          onChange={(e) =>
                            setSplitLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, amount: e.target.value } : l)))
                          }
                        />
                        <Select
                          value={line.method}
                          onValueChange={(v) => setSplitLines((prev) => prev.map((l) => (l.key === line.key ? { ...l, method: v } : l)))}
                        >
                          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            {Object.entries(PAYMENT_METHOD_LABELS).map(([key, label]) => (
                              <SelectItem key={key} value={key}>{label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        {splitLines.length > 1 && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setSplitLines((prev) => prev.filter((l) => l.key !== line.key))}
                            aria-label={t('billing.recordPayment.deleteLine')}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        )}
                        {idx === splitLines.length - 1 && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSplitLines((prev) => [...prev, { key: crypto.randomUUID(), amount: '', method: 'cash' }])}
                          >
                            {t('billing.recordPayment.addMethod')}
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  {splitLines.length > 1 && splitTotal > 0 && (
                    <p className="text-xs text-text-secondary">
                      {t('billing.recordPayment.totalPaymentsPrefix')} <span className="font-medium">{splitTotal.toFixed(2)}</span>
                      {splitTotal - outstandingForSelected > 0.01 && (
                        <span className="text-status-danger"> {t('billing.recordPayment.exceedsOutstanding')}</span>
                      )}
                    </p>
                  )}
                  <Button
                    className="w-fit"
                    disabled={splitTotal <= 0 || recordPaymentMutation.isPending || splitTotal - outstandingForSelected > 0.01}
                    onClick={() => recordPaymentMutation.mutate()}
                  >
                    {recordPaymentMutation.isPending ? t('billing.recordPayment.submitting') : t('billing.recordPayment.submit')}
                  </Button>
                </div>
              )}

              {detail.status === 'issued' && payments.length === 0 && (
                <div className="flex flex-col gap-2 border-t border-border pt-3 print:hidden">
                  <p className="font-medium">{t('billing.voidInvoice.heading')}</p>
                  <p className="text-xs text-text-secondary">{t('billing.voidInvoice.hint')}</p>
                  <Input placeholder={t('billing.voidInvoice.reasonPlaceholder')} value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-fit"
                    disabled={!voidReason.trim() || voidMutation.isPending}
                    onClick={() => voidMutation.mutate()}
                  >
                    {voidMutation.isPending ? t('billing.voidInvoice.submitting') : t('billing.voidInvoice.submit')}
                  </Button>
                </div>
              )}

              {formError && (
                <p role="alert" className="text-sm text-status-danger">{formError}</p>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!refundPaymentId} onOpenChange={(open) => !open && setRefundPaymentId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('billing.refund.dialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input type="number" placeholder={t('billing.refund.amountPlaceholder')} value={refundAmount} onChange={(e) => setRefundAmount(e.target.value)} />
            <Input placeholder={t('billing.refund.reasonPlaceholder')} value={refundReason} onChange={(e) => setRefundReason(e.target.value)} />
            <Button disabled={!refundAmount || !refundReason.trim() || refundMutation.isPending} onClick={() => refundMutation.mutate()}>
              {t('billing.refund.submit')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!refundReceipt} onOpenChange={(open) => !open && setRefundReceipt(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('billing.refund.receiptTitle')}</DialogTitle>
          </DialogHeader>
          {refundReceipt && (
            <div className="flex flex-col gap-3">
              <div data-print-size={printSize} className="print-target visible-for-print rounded-md border border-border p-4 text-sm print:border-0">
                <p className="mb-2 font-bold">{t('billing.refund.receiptTitle')}</p>
                <div className="flex flex-col gap-1">
                  <p>{t('billing.refund.receiptInvoicePrefix')} <bdi>{refundReceipt.invoiceNumber}</bdi></p>
                  <p>{t('billing.refund.receiptCustomer', { name: refundReceipt.customerName })}</p>
                  <p>{t('billing.refund.receiptOriginalMethod', { method: PAYMENT_METHOD_LABELS[refundReceipt.method] ?? refundReceipt.method })}</p>
                  <p>{t('billing.refund.receiptReason', { reason: refundReceipt.reason })}</p>
                  <p>{t('billing.refund.receiptDate', { date: new Date(refundReceipt.refundedAt).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG') })}</p>
                </div>
                <div className="mt-3 flex justify-end">
                  <MoneyDisplay amount={refundReceipt.refundAmount} size="lg" tone="danger" />
                </div>
              </div>
              <div className="flex items-center gap-2 print:hidden">
                <Select value={printSize} onValueChange={(v) => setPrintSize(v as 'a4' | '80mm')}>
                  <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="a4">A4</SelectItem>
                    <SelectItem value="80mm">{t('billing.detail.receiptSize80mm')}</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" className="w-fit" onClick={() => window.print()}>
                  {t('billing.detail.print')}
                </Button>
                <Button variant="ghost" size="sm" className="w-fit" onClick={() => setRefundReceipt(null)}>
                  {t('common.close')}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
