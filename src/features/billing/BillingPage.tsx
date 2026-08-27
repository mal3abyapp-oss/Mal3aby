import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams, Link } from 'react-router-dom'
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
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_STATUS_LABELS,
  PAYMENT_STATUS_TONE,
  type PaymentRow,
  fetchInvoicePaymentSummaries,
  type PaymentStatus,
} from '@/lib/domain/billing'
import { Trash2, AlertTriangle } from 'lucide-react'
import { useOfficialReceipt, OfficialCollectionReceiptFields, translateReceiptError, type OfficialReceiptState } from '@/components/ui/official-collection-receipt-fields'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'

// Invoice list, invoice detail (view + print), payment collection form,
// refund flow. Print CSS via @media print rules scoped to #invoice-print.
interface InvoiceListRow {
  id: string
  invoiceNumber: string
  customerId: string | null
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
// Phase G (G3): date + status are the two highest-value filters for a
// list that otherwise silently caps at the 50 most recent invoices --
// without them, an older or already-settled invoice becomes
// unreachable from this screen once enough newer ones accumulate.
async function fetchInvoices(clubId: string, startDate?: string, endDate?: string, status?: string) {
  let query = supabase
    .from('invoices')
    .select('id, invoice_number, status, total, issued_at, customer_id, customers(full_name), invoice_items(reference_type)')
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (startDate) query = query.gte('issued_at', `${startDate}T00:00:00`)
  if (endDate) query = query.lte('issued_at', `${endDate}T23:59:59`)
  if (status) query = query.eq('status', status)
  const { data, error } = await query
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
      customerId: row.customer_id,
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

// Government / Ministry Collection Compliance -- Phase B: the same
// field -> branch -> club resolution record_payment()'s own guard uses
// (it looks this up from the booking linked to the invoice, see that
// RPC's SQL) -- fetched once per selected invoice so the split-payment
// form's receipt fields apply the correct policy per line/method.
async function fetchInvoiceBookingScope(invoiceId: string) {
  const { data, error } = await supabase
    .from('bookings')
    .select('field_id, branch_id')
    .eq('invoice_id', invoiceId)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return data ?? null
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

  // Government / Ministry Collection Compliance -- Phase B: at most one
  // active official_collection_receipts row per payment_id (record_payment's
  // own guard rejects reusing an already-linked receipt), so a single
  // lookup by payment_id is unambiguous.
  const paymentIds = rawPayments.map((p) => p.id)
  const receiptsByPaymentId = new Map<string, { serial: string; status: string }>()
  if (paymentIds.length > 0) {
    const { data: receipts } = await supabase
      .from('official_collection_receipts')
      .select('payment_id, receipt_serial, status')
      .in('payment_id', paymentIds)
    for (const r of receipts ?? []) {
      if (r.payment_id) receiptsByPaymentId.set(r.payment_id, { serial: r.receipt_serial, status: r.status })
    }
  }

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
    officialReceiptSerial: receiptsByPaymentId.get(p.id)?.serial ?? null,
    officialReceiptStatus: receiptsByPaymentId.get(p.id)?.status ?? null,
  }))
}

const DEFAULT_INVOICE_STATUS_KEY = 'billing.invoiceStatusLabels.draft'
const INVOICE_STATUS_LABEL_KEYS: Record<string, string> = {
  draft: DEFAULT_INVOICE_STATUS_KEY,
  issued: 'billing.invoiceStatusLabels.issued',
  void: 'billing.invoiceStatusLabels.void',
}

// Government / Ministry Collection Compliance -- Phase B: a split-
// payment line's method can differ line to line, so each line needs
// its own independent policy check (a cash line might require a
// receipt while a card line on the same invoice doesn't). React hooks
// can't be called inside splitLines.map() directly, so this owns one
// useOfficialReceipt() call per line and reports its live state up to
// the parent via onStateChange -- the parent never re-implements any
// receipt logic itself, only reads each line's current isValid/
// getPayload() at submit time.
function SplitLineReceipt({
  clubId,
  branchId,
  fieldId,
  method,
  onStateChange,
}: {
  clubId: string | null | undefined
  branchId?: string | null
  fieldId?: string | null
  method: string
  onStateChange: (state: OfficialReceiptState) => void
}) {
  const state = useOfficialReceipt({ clubId, branchId, fieldId, method })
  // Reported in an effect, not during render -- calling a parent's
  // setState synchronously while this child renders is a React
  // anti-pattern even when the parent bails out on an unchanged value.
  useEffect(() => {
    onStateChange(state)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.required, state.isValid, state.getPayload])
  if (!state.required) return null
  return <OfficialCollectionReceiptFields state={state} />
}

export function BillingPage() {
  const { currentClubId, memberships, setCurrentClubId } = useAuth()
  const { t } = useTranslation()
  const { locale } = useDirection()
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  // Master IA/UX audit (Club Side Booking 360 phase): BookingDetailSheet
  // showed the outstanding balance read-only with no way to reach the
  // actual invoice on BillingPage -- same minimal ?param= deep-link
  // pattern already used for Reports' customer search cross-link
  // (CustomersPage's ?q=), not new infrastructure.
  //
  // Reports + Invoices + Universal Entity Drill-Down audit: this state
  // was previously initialized ONCE from the URL (useState(() => ...))
  // and never written back -- opening an invoice via the table's own
  // row click (setSelectedInvoiceId directly) never updated the URL,
  // so refresh/new-tab/copy-link on an invoice opened that way lost
  // it entirely, and navigating between two different ?invoice=
  // deep-links while already mounted on this page silently did
  // nothing (stale initial state). selectedInvoiceId is now derived
  // directly from the URL (the single source of truth) and every
  // "open"/"close" action goes through setSearchParams, so every
  // entry point -- row click, deep link, or a link from another
  // screen -- behaves identically and is always refresh-safe.
  const selectedInvoiceId = searchParams.get('invoice')
  const setSelectedInvoiceId = (invoiceId: string | null) => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (invoiceId) next.set('invoice', invoiceId)
        else next.delete('invoice')
        return next
      },
      { replace: !invoiceId },
    )
  }
  const [printSize, setPrintSize] = useState<'a4' | '80mm'>('a4')
  const [refundPaymentId, setRefundPaymentId] = useState<string | null>(null)
  const [refundAmount, setRefundAmount] = useState('')
  const [refundReason, setRefundReason] = useState('')
  const [voidReason, setVoidReason] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  // Phase G (G3/G7): default filters are date + status, the two
  // highest-value narrowing fields for a capped-at-50 invoice list --
  // everything else (method/employee/branch/field/government receipt)
  // stays reachable through the dedicated reports instead of
  // overloading this screen with every possible field per G7's own
  // "date + 1-2 highest-value filters" guidance.
  const [invoiceStartDate, setInvoiceStartDate] = useState('')
  const [invoiceEndDate, setInvoiceEndDate] = useState('')
  const [invoiceStatusFilter, setInvoiceStatusFilter] = useState('')

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['invoices', currentClubId, invoiceStartDate, invoiceEndDate, invoiceStatusFilter],
    queryFn: () => fetchInvoices(currentClubId!, invoiceStartDate || undefined, invoiceEndDate || undefined, invoiceStatusFilter || undefined),
    enabled: !!currentClubId,
  })

  const { data: pendingClaims = [] } = useQuery({
    queryKey: ['pending-payment-claims', currentClubId],
    queryFn: () => fetchPendingClaims(currentClubId!),
    enabled: !!currentClubId,
  })

  // Government / Ministry Collection Compliance -- Phase B.
  const { data: invoiceBookingScope } = useQuery({
    queryKey: ['invoice-booking-scope', selectedInvoiceId],
    queryFn: () => fetchInvoiceBookingScope(selectedInvoiceId!),
    enabled: !!selectedInvoiceId,
  })
  // key -> live receipt state for that split line, reported by each
  // SplitLineReceipt instance. Kept in a ref (not the map itself in
  // state) so BillingPage doesn't re-render on every receipt-field
  // keystroke inside a SplitLineReceipt -- but the submit button's
  // disabled check DOES need to react when required/isValid actually
  // changes (e.g. the serial field going from empty to filled), so
  // onStateChange also bumps a tiny counter to force exactly the
  // re-renders that matter, not one per character.
  const splitLineReceiptsRef = useRef(new Map<string, OfficialReceiptState>())
  const [, forceReceiptGateRecheck] = useState(0)

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

  // Reports + Invoices + Universal Entity Drill-Down audit: this
  // query's isLoading/isError were previously discarded -- the Dialog
  // was `open={!!selectedInvoiceId}` with `{detail && (...)}` for its
  // whole body, so a deep link to an invoid id that's genuinely
  // missing, or that RLS correctly filters out because it belongs to
  // a different club (.single() throws "no rows" either way), opened
  // a Dialog with an empty header and no content at all -- silent
  // failure, not the ErrorState this codebase uses everywhere else.
  const {
    data: detail,
    isLoading: isDetailLoading,
    isError: isDetailError,
    error: detailError,
    refetch: refetchDetail,
  } = useQuery({
    queryKey: ['invoice-detail', selectedInvoiceId],
    queryFn: () => fetchInvoiceDetail(selectedInvoiceId!),
    enabled: !!selectedInvoiceId,
    retry: false,
  })

  // Multi-club UX fix (see the render branch below for the full
  // rationale): a resolved `detail` whose club_id differs from the
  // currently-active club means this is a real OTHER membership the
  // account holds, not a foreign tenant (a true foreign club never
  // reaches this point -- RLS already zeroes those out into
  // isDetailError above). Resolve the display name from `memberships`
  // (already loaded, no extra query) rather than re-fetching it.
  const wrongClubMembership =
    detail && detail.club_id && detail.club_id !== currentClubId
      ? memberships.find((m) => m.clubId === detail.club_id)
      : undefined
  const wrongClubName = wrongClubMembership ? (locale === 'en' ? wrongClubMembership.clubName : wrongClubMembership.clubNameAr) : undefined

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
  const { data: verifyQrResult } = useQuery({
    queryKey: ['invoice-verify-qr', selectedInvoiceId],
    queryFn: async () => {
      const { data: token, error } = await supabase.rpc('ensure_invoice_qr', { p_invoice_id: selectedInvoiceId! })
      if (error) throw error
      const url = `${window.location.origin}/verify/${token}`
      return { token: token as string, dataUrl: await QRCode.toDataURL(url, { width: 120, margin: 1 }) }
    },
    enabled: !!selectedInvoiceId && detail?.status === 'issued',
    staleTime: Infinity,
  })
  const verifyQrDataUrl = verifyQrResult?.dataUrl
  const verifyQrToken = verifyQrResult?.token

  // PRINTING & DOCUMENT OUTPUT (2026-08-27), Sections 11-16: the mandatory
  // booking QR on a printed Field Booking invoice. Reuses the exact same
  // canonical RPC VerifyInvoicePage.tsx already uses successfully
  // (get_booking_qr_for_invoice_token) -- fed the SAME invoice verification
  // token minted above (a valid possession-proof for this invoice), never a
  // second parallel minting path. Server re-validates booking eligibility
  // (cancelled/checked-in/not-eligible) on every fetch -- this UI never
  // assumes eligibility client-side. Only shown for a Field Booking invoice
  // (invoiceBookingScope present); never for Academy/Membership/Shop
  // invoices, matching the directive's own scope ("mandatory QR requirement
  // applies specifically to the individual booking invoice/confirmation").
  const { data: bookingQr } = useQuery({
    queryKey: ['invoice-booking-qr', selectedInvoiceId, verifyQrToken],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_booking_qr_for_invoice_token', { p_invoice_token: verifyQrToken as string })
      if (error) throw error
      const row = data?.[0]
      if (row?.status !== 'active' || !row.raw_token) return { status: row?.status ?? 'invalid_invoice_token', dataUrl: null, bookingRef: row?.booking_ref ?? null }
      const dataUrl = await QRCode.toDataURL(row.raw_token, { width: 160, margin: 1 })
      return { status: 'active' as const, dataUrl, bookingRef: row.booking_ref as string | null }
    },
    enabled: !!selectedInvoiceId && !!invoiceBookingScope && !!verifyQrToken,
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
    splitLineReceiptsRef.current.clear()
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
      // Government / Ministry Collection Compliance -- Phase B: the
      // client-side isValid gate on the submit button (below) is a
      // convenience, not the enforcement boundary -- record_payment()
      // itself raises per-line if that line's method requires a receipt
      // and none/an invalid one was attached, even if this check were
      // somehow bypassed.
      for (const line of validLines) {
        const lineReceipt = splitLineReceiptsRef.current.get(line.key)
        if (lineReceipt?.required && !lineReceipt.isValid) {
          throw new Error(t('governmentCompliance.receiptRequiredError'))
        }
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
        const lineReceipt = splitLineReceiptsRef.current.get(line.key)
        const receiptPayload = lineReceipt?.getPayload()
        if (receiptPayload) {
          const { p_receipt_notes, ...rest } = receiptPayload
          const { error } = await supabase.rpc('record_payment_with_official_receipt', {
            p_invoice_id: selectedInvoiceId,
            p_amount: Number(line.amount),
            p_method: line.method,
            ...rest,
            p_notes: p_receipt_notes,
            p_idempotency_key: line.key,
          })
          if (error) throw error
          continue
        }
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
      splitLineReceiptsRef.current.clear()
      setFormError(null)
      invalidateDetail()
    },
    onError: (error) => {
      const message = error instanceof Error && !('code' in error) ? error.message : translateSupabaseError(error, t('billing.recordPayment.genericError'))
      setFormError(translateReceiptError(message, t, message))
    },
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
    {
      key: 'customer', header: t('billing.table.customer'), render: (r) => r.customerId ? (
        <Link to={`/app/customers/${r.customerId}`} className="text-accent-foreground hover:underline" onClick={(e) => e.stopPropagation()}>{r.customerName}</Link>
      ) : r.customerName,
    },
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
                  <p className="font-medium">
                    {c.customerName} —{' '}
                    <button
                      className="text-accent-foreground hover:underline"
                      onClick={() => setSelectedInvoiceId(c.invoiceId)}
                    >
                      <bdi>{c.invoiceNumber}</bdi>
                    </button>
                  </p>
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

      {/* Phase G (G3): date + status, the two highest-value filters for
          this capped-at-50 list. */}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-secondary">{t('billing.filters.startDate')}</label>
          <Input type="date" value={invoiceStartDate} onChange={(e) => setInvoiceStartDate(e.target.value)} className="w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-secondary">{t('billing.filters.endDate')}</label>
          <Input type="date" value={invoiceEndDate} onChange={(e) => setInvoiceEndDate(e.target.value)} className="w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-text-secondary">{t('billing.filters.status')}</label>
          <Select value={invoiceStatusFilter || 'all'} onValueChange={(v) => setInvoiceStatusFilter(v === 'all' ? '' : v)}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('billing.filters.allStatuses')}</SelectItem>
              <SelectItem value="issued">{t('billing.invoiceStatusLabels.issued')}</SelectItem>
              <SelectItem value="void">{t('billing.invoiceStatusLabels.void')}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {(invoiceStartDate || invoiceEndDate || invoiceStatusFilter) && (
          <Button variant="ghost" size="sm" onClick={() => { setInvoiceStartDate(''); setInvoiceEndDate(''); setInvoiceStatusFilter('') }}>
            {t('billing.filters.clear')}
          </Button>
        )}
      </div>

      {/* PERSONA COUNCIL AUDIT (2026-08-25) -- Club Owner persona
          finding: fetchInvoices() has always had a hard .limit(50) (see
          Phase G's own comment above), and this list had no indication
          when that cap was actually reached -- a club with more than 50
          invoices matching the current filters silently showed only the
          most recent 50 with no way to tell "this is everything" from
          "this is truncated". invoices.length === 50 is the honest
          signal available without a real pagination system (a bigger
          change than this narrow fix warrants) -- when it fires, points
          the owner at the date/status filters already on this page
          (Phase G's own mitigation) as the way to narrow down further. */}
      {invoices.length === 50 && (
        <p className="mb-2 text-xs text-text-secondary">{t('billing.table.showingCappedResults')}</p>
      )}
      <DataTable columns={columns} rows={invoices} rowKey={(r) => r.id} isLoading={isLoading} emptyTitle={t('billing.table.emptyTitle')} />

      <Dialog open={!!selectedInvoiceId} onOpenChange={(open) => !open && setSelectedInvoiceId(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {detail ? <>{t('billing.detail.invoicePrefix')} <bdi>{detail.invoice_number}</bdi></> : t('billing.detail.invoicePrefix')}
            </DialogTitle>
          </DialogHeader>
          {isDetailLoading && (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {isDetailError && (
            <ErrorState message={translateSupabaseError(detailError, t('billing.detail.notFound'))} onRetry={() => void refetchDetail()} />
          )}
          {/* Multi-club UX fix: RLS resolves this invoice by id alone (no
              active-club filter -- see fetchInvoiceDetail above), so a
              deep link to an invoice belonging to a DIFFERENT club this
              account also has membership in used to render successfully,
              but with every other club-scoped element on the page (nav,
              switcher, sibling queries keyed on currentClubId) still
              showing the WRONG club's context around it -- a real,
              silent cross-club data-framing bug, not merely "RLS allows
              it so it's fine". A genuinely foreign club (no membership at
              all) can never reach this branch: RLS already returns zero
              rows for it, which is the isDetailError branch above, not
              this one -- so this never weakens the frozen Security
              Baseline's tenant isolation, it only fixes the UI framing
              for an invoice the account legitimately has access to under
              a different membership. */}
          {detail && wrongClubName && (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
              <AlertTriangle className="size-10 text-status-danger" aria-hidden="true" />
              <p className="font-medium text-text-primary">{t('billing.detail.wrongClub', { clubName: wrongClubName })}</p>
              <Button variant="outline" size="sm" onClick={() => setCurrentClubId(detail.club_id as string)}>
                {t('billing.detail.switchClub')}
              </Button>
            </div>
          )}
          {detail && !wrongClubName && (
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
                        label={t(`secureBooking.paymentStatusLabels.${paymentSummary.paymentStatus}`, { defaultValue: PAYMENT_STATUS_LABELS[paymentSummary.paymentStatus] })}
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
                {/* Mandatory booking QR (PRINTING closure, Section 11) --
                    only for a Field Booking invoice, only once the server
                    confirms 'active' (booking not cancelled/checked-in/
                    ineligible). Human-readable booking reference is always
                    shown alongside it, per Section 16 -- the QR is never
                    the sole way to identify the booking. */}
                {invoiceBookingScope && bookingQr && bookingQr.status === 'active' && bookingQr.dataUrl && (
                  <div className="mb-3 flex items-center gap-3 border-t border-border pt-3">
                    <img src={bookingQr.dataUrl} alt={t('billing.detail.bookingQrAlt')} className="size-28" />
                    <div>
                      <p className="text-xs font-medium">{t('billing.detail.bookingQrLabel')}</p>
                      {bookingQr.bookingRef && (
                        <p className="text-xs text-text-secondary">
                          {t('billing.detail.bookingRef')}: <bdi className="tabular-nums">{bookingQr.bookingRef}</bdi>
                        </p>
                      )}
                    </div>
                  </div>
                )}
                {invoiceBookingScope && bookingQr && bookingQr.status !== 'active' && (
                  <p className="mb-3 text-xs text-status-warning print:hidden">
                    {t('billing.detail.bookingQrUnavailable', { defaultValue: 'Booking QR unavailable for this booking\'s current status.' })}
                  </p>
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
                          <MoneyDisplay amount={p.amount} size="sm" /> — {t(`common.paymentMethodLabels.${p.method}`, { defaultValue: PAYMENT_METHOD_LABELS[p.method] ?? p.method })}
                          {p.receivedByName && (
                            <span className="text-text-secondary"> — {t('billing.detail.collectedBy', { name: p.receivedByName })}</span>
                          )}
                          {/* Government / Ministry Collection Compliance
                              -- Phase B: shown only when this specific
                              payment actually has a linked receipt, no
                              placeholder clutter on the (common) case
                              where none applies. */}
                          {p.officialReceiptSerial && (
                            <span className="block text-xs text-text-secondary">
                              {t('governmentCompliance.title')}: <bdi className="tabular-nums">{p.officialReceiptSerial}</bdi>
                              {p.officialReceiptStatus === 'reversed' && (
                                <span className="text-status-danger"> ({t('billing.detail.refund')})</span>
                              )}
                            </span>
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
                              <SelectItem key={key} value={key}>{t(`common.paymentMethodLabels.${key}`, { defaultValue: label })}</SelectItem>
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
                    {/* Government / Ministry Collection Compliance --
                        Phase B: one independent policy check per line,
                        since a split payment can legitimately mix a
                        receipt-required method with one that isn't. */}
                    {splitLines.map((line) => (
                      <SplitLineReceipt
                        key={line.key}
                        clubId={currentClubId}
                        branchId={invoiceBookingScope?.branch_id}
                        fieldId={invoiceBookingScope?.field_id}
                        method={line.method}
                        onStateChange={(state) => {
                          const prev = splitLineReceiptsRef.current.get(line.key)
                          splitLineReceiptsRef.current.set(line.key, state)
                          if (!prev || prev.required !== state.required || prev.isValid !== state.isValid) {
                            forceReceiptGateRecheck((n) => n + 1)
                          }
                        }}
                      />
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
                    disabled={
                      splitTotal <= 0
                      || recordPaymentMutation.isPending
                      || splitTotal - outstandingForSelected > 0.01
                      || splitLines.some((l) => {
                        if (!(Number(l.amount) > 0)) return false
                        const r = splitLineReceiptsRef.current.get(l.key)
                        return !!r?.required && !r.isValid
                      })
                    }
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
                  <p>{t('billing.refund.receiptOriginalMethod', { method: t(`common.paymentMethodLabels.${refundReceipt.method}`, { defaultValue: PAYMENT_METHOD_LABELS[refundReceipt.method] ?? refundReceipt.method }) })}</p>
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
