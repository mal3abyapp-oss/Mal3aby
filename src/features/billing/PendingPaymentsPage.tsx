import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { FormattedDate } from '@/components/ui/formatted-date'
import { FormattedCurrency } from '@/components/ui/formatted-currency'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { translateSupabaseError } from '@/lib/errors'
import { Image as ImageIcon, FileText } from 'lucide-react'

/**
 * PendingPaymentsPage -- directive Part XIII: "Club Owner: Payment
 * Proofs / Pending Payments" review queue. Approve/reject both go
 * through the real approve_payment_proof()/reject_payment_proof() RPCs
 * (never a direct payment_proofs UPDATE from this screen) -- the RPCs
 * are the single consistent path that also creates the real payment
 * via record_payment(), matching this codebase's existing pattern of
 * RPC-mediated money movement everywhere else (BillingPage, CashShiftPage).
 */

interface ProofRow {
  id: string
  bookingId: string | null
  invoiceId: string
  amount: number
  storagePath: string
  mimeType: string
  status: 'pending_review' | 'approved' | 'rejected'
  rejectionReason: string | null
  uploadedAt: string
  customerName: string | null
  bookingRef: string | null
  fieldName: string | null
  startAt: string | null
}

async function fetchProofs(clubId: string): Promise<ProofRow[]> {
  const { data, error } = await supabase
    .from('payment_proofs')
    .select(`
      id, booking_id, invoice_id, amount, storage_path, mime_type, status, rejection_reason, uploaded_at,
      bookings ( start_at, field_id, fields ( name ), customers ( full_name ) )
    `)
    .eq('club_id', clubId)
    .order('uploaded_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => {
    const booking = r.bookings as unknown as { start_at: string; fields: { name: string } | null; customers: { full_name: string } | null } | null
    return {
      id: r.id,
      bookingId: r.booking_id,
      invoiceId: r.invoice_id,
      amount: Number(r.amount),
      storagePath: r.storage_path,
      mimeType: r.mime_type,
      status: r.status as ProofRow['status'],
      rejectionReason: r.rejection_reason,
      uploadedAt: r.uploaded_at,
      customerName: booking?.customers?.full_name ?? null,
      bookingRef: r.booking_id ? `MB-${r.booking_id.slice(0, 8).toUpperCase()}` : null,
      fieldName: booking?.fields?.name ?? null,
      startAt: booking?.start_at ?? null,
    }
  })
}

export function PendingPaymentsPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [previewProof, setPreviewProof] = useState<ProofRow | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [rejectingProof, setRejectingProof] = useState<ProofRow | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [actionError, setActionError] = useState<string | null>(null)
  // Production audit finding H-3: approval fired approveMutation
  // directly on click with zero confirmation, while rejection (right
  // next to it, same screen) was already correctly gated behind this
  // exact Dialog. Approval is financially material -- it creates a
  // real payment record via record_payment() inside
  // approve_payment_proof() (see approveMutation's own comment above)
  // -- so it gets a full confirm dialog matching BillingPage's
  // refund/void dialog style, not the lighter reveal-then-confirm used
  // for the moderate-risk staff/role actions elsewhere in this pass.
  const [approvingProof, setApprovingProof] = useState<ProofRow | null>(null)

  const { data: proofs = [], isLoading } = useQuery({
    queryKey: ['payment-proofs', currentClubId],
    queryFn: () => fetchProofs(currentClubId!),
    enabled: !!currentClubId,
  })

  const pending = proofs.filter((p) => p.status === 'pending_review')
  const decided = proofs.filter((p) => p.status !== 'pending_review')

  const approveMutation = useMutation({
    mutationFn: async (proofId: string) => {
      // Design/UX audit fix (2026-08-19): previously hardcoded
      // p_payment_method: 'bank_transfer' on every approval regardless of
      // the method the customer actually used -- corrupted real financial
      // records. approve_payment_proof() now resolves the real method
      // itself from the proof's own linked payment_method_config_id when
      // no explicit override is passed, so this call correctly leaves it
      // unset rather than forcing a specific value.
      const { error } = await supabase.rpc('approve_payment_proof', { p_proof_id: proofId })
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      setApprovingProof(null)
      void queryClient.invalidateQueries({ queryKey: ['payment-proofs', currentClubId] })
    },
    onError: (err) => setActionError(translateSupabaseError(err, t('billing.pendingPayments.approveError'))),
  })

  const rejectMutation = useMutation({
    mutationFn: async ({ proofId, reason }: { proofId: string; reason: string }) => {
      const { error } = await supabase.rpc('reject_payment_proof', { p_proof_id: proofId, p_reason: reason })
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      setRejectingProof(null)
      setRejectReason('')
      void queryClient.invalidateQueries({ queryKey: ['payment-proofs', currentClubId] })
    },
    onError: (err) => setActionError(translateSupabaseError(err, t('billing.pendingPayments.rejectError'))),
  })

  async function openPreview(proof: ProofRow) {
    const { data, error } = await supabase.storage.from('payment-proofs').createSignedUrl(proof.storagePath, 300)
    if (error || !data) return
    setPreviewProof(proof)
    setPreviewUrl(data.signedUrl)
  }

  return (
    <div>
      <PageHeader title={t('billing.pendingPayments.title')} description={t('billing.pendingPayments.description')} />

      {actionError && <p role="alert" className="mb-3 text-sm text-status-danger">{actionError}</p>}

      {isLoading ? (
        <p className="text-sm text-text-secondary">{t('billing.pendingPayments.loading')}</p>
      ) : pending.length === 0 ? (
        <p className="text-sm text-text-secondary">{t('billing.pendingPayments.empty')}</p>
      ) : (
        <div className="mb-6 flex flex-col gap-2">
          {pending.map((p) => (
            <Card key={p.id}>
              <CardContent className="flex flex-col gap-2 p-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="font-medium">{p.customerName ?? '—'} {p.bookingRef && <span className="text-text-secondary">— {p.bookingRef}</span>}</p>
                  <p className="text-sm text-text-secondary">
                    {p.fieldName && <>{p.fieldName} · </>}
                    {p.startAt && <FormattedDate value={p.startAt} timeZone="Africa/Cairo" options={{ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }} />}
                  </p>
                  <p className="mt-1 font-semibold"><FormattedCurrency value={p.amount} /></p>
                  <p className="text-xs text-text-secondary"><FormattedDate value={p.uploadedAt} timeZone="Africa/Cairo" options={{ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }} /></p>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => navigate(`/app/finance/payments?invoice=${p.invoiceId}`)}>
                    {t('billing.pendingPayments.viewInvoice', { defaultValue: 'View invoice' })}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => openPreview(p)}>
                    {p.mimeType === 'application/pdf' ? <FileText className="me-1 size-4" /> : <ImageIcon className="me-1 size-4" />}
                    {t('billing.pendingPayments.viewReceipt')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setRejectingProof(p); setActionError(null) }}>
                    {t('billing.pendingPayments.reject')}
                  </Button>
                  <Button size="sm" onClick={() => { setActionError(null); setApprovingProof(p) }}>
                    {t('billing.pendingPayments.approve')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {decided.length > 0 && (
        <>
          <p className="mb-2 text-sm font-medium text-text-secondary">{t('billing.pendingPayments.reviewedHeading')}</p>
          <div className="flex flex-col gap-2">
            {decided.slice(0, 20).map((p) => (
              <div key={p.id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                <span>{p.customerName ?? '—'} — <FormattedCurrency value={p.amount} /></span>
                <StatusBadge
                  tone={p.status === 'approved' ? 'success' : 'danger'}
                  label={p.status === 'approved' ? t('billing.pendingPayments.approved') : t('billing.pendingPayments.rejected')}
                />
              </div>
            ))}
          </div>
        </>
      )}

      <Dialog open={!!previewProof} onOpenChange={(open) => { if (!open) { setPreviewProof(null); setPreviewUrl(null) } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('billing.pendingPayments.receiptTitle')}</DialogTitle></DialogHeader>
          {previewUrl && previewProof && (
            previewProof.mimeType === 'application/pdf' ? (
              <a href={previewUrl} target="_blank" rel="noreferrer" className="text-accent-foreground underline">
                {t('billing.pendingPayments.openPdf')}
              </a>
            ) : (
              <img src={previewUrl} alt={t('billing.pendingPayments.receiptTitle')} className="max-h-[70vh] w-full rounded-md object-contain" />
            )
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!approvingProof} onOpenChange={(open) => { if (!open) setApprovingProof(null) }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('billing.pendingPayments.approveDialogTitle')}</DialogTitle></DialogHeader>
          {approvingProof && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-secondary">{t('billing.pendingPayments.approveDialogHint')}</p>
              <div className="rounded-md border border-border p-3 text-sm">
                <p className="font-medium">{approvingProof.customerName ?? '—'} {approvingProof.bookingRef && <span className="text-text-secondary">— {approvingProof.bookingRef}</span>}</p>
                <p className="mt-1 font-semibold tabular-nums"><FormattedCurrency value={approvingProof.amount} /></p>
              </div>
              <Button
                data-testid="approve-payment-confirm"
                disabled={approveMutation.isPending}
                onClick={() => approveMutation.mutate(approvingProof.id)}
              >
                {approveMutation.isPending ? t('billing.pendingPayments.approving') : t('billing.pendingPayments.confirmApprove')}
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!rejectingProof} onOpenChange={(open) => { if (!open) { setRejectingProof(null); setRejectReason('') } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('billing.pendingPayments.rejectDialogTitle')}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <Input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder={t('billing.pendingPayments.rejectReasonPlaceholder')} />
            <Button
              disabled={!rejectReason.trim() || rejectMutation.isPending}
              onClick={() => rejectingProof && rejectMutation.mutate({ proofId: rejectingProof.id, reason: rejectReason.trim() })}
            >
              {t('billing.pendingPayments.confirmReject')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
