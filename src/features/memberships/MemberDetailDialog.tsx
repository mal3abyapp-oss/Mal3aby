import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { CLUB_MEMBERSHIP_STATUS_TONE } from '@/lib/domain/clubMembership'
import { MembershipCard } from './MembershipCard'

// Member detail dialog -- calls get_club_membership_detail, shows the
// full record + freeze history + renewal history, and gates every
// action button on its own permission key
// (currentMembership.permissionKeys.includes(...)), the exact pattern
// CashShiftPage.tsx's cash.liability.settle gate uses. Cancel mirrors
// that same file's inline confirm-panel UX (not a separate "type to
// confirm" text input -- no such pattern exists anywhere in this
// codebase; the closest, most-used sensitive-action confirm UX is an
// inline panel requiring an explicit reason + a second confirm click).

interface FreezeRow { id: string; start_date: string; end_date: string; freeze_days: number; reason: string | null; created_at: string }
interface RenewalRow { id: string; membership_number: string; status: string; start_date: string; end_date: string; price: number }

interface MembershipDetail {
  membership_subscription_id: string
  membership_number: string
  customer_id: string
  customer_name: string
  customer_photo_url: string | null
  plan_id: string
  plan_name_ar: string
  plan_name_en: string
  price: number
  duration_value: number
  duration_unit: string
  status: string
  effective_status: string
  start_date: string
  end_date: string
  effective_end_date: string
  branch_id: string
  branch_name: string
  invoice_id: string | null
  cancelled_at: string | null
  cancelled_by: string | null
  cancel_reason: string | null
  created_at: string
  freezes: FreezeRow[]
  renewal_history: RenewalRow[]
}

interface PlanAllowFlags { allow_freeze: boolean; allow_renewal: boolean }

async function fetchDetail(membershipId: string): Promise<MembershipDetail> {
  const { data, error } = await supabase.rpc('get_club_membership_detail', { p_membership_subscription_id: membershipId })
  if (error) throw error
  return data as unknown as MembershipDetail
}

async function fetchPlanFlags(planId: string): Promise<PlanAllowFlags | null> {
  const { data, error } = await supabase.from('club_membership_plans').select('allow_freeze, allow_renewal').eq('id', planId).maybeSingle()
  if (error) return null
  return data
}

export function MemberDetailDialog({
  membershipId, onClose, onChanged,
}: {
  membershipId: string
  onClose: () => void
  onChanged: () => void
}) {
  const { t, i18n } = useTranslation()
  const navigate = useNavigate()
  const { currentMembership } = useAuth()
  const queryClient = useQueryClient()
  const perms = currentMembership?.permissionKeys ?? []
  const canRenew = perms.includes('club_membership.renew')
  const canFreeze = perms.includes('club_membership.freeze')
  const canCancel = perms.includes('club_membership.cancel')

  const [renewOpen, setRenewOpen] = useState(false)
  const [freezeOpen, setFreezeOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelError, setCancelError] = useState<string | null>(null)
  const [cardOpen, setCardOpen] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const { data: detail, isLoading } = useQuery({
    queryKey: ['club-membership-detail', membershipId],
    queryFn: () => fetchDetail(membershipId),
  })

  const { data: planFlags } = useQuery({
    queryKey: ['club-membership-plan-flags', detail?.plan_id],
    queryFn: () => fetchPlanFlags(detail!.plan_id),
    enabled: !!detail?.plan_id,
  })

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['club-membership-detail', membershipId] })
    onChanged()
  }

  const resumeMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('resume_club_membership', { p_membership_subscription_id: membershipId })
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (err) => setActionError(translateSupabaseError(err, t('clubMemberships.detail.errors.resumeError'))),
  })

  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!cancelReason.trim()) throw new Error(t('clubMemberships.detail.errors.reasonRequired'))
      const { error } = await supabase.rpc('cancel_club_membership', { p_membership_subscription_id: membershipId, p_reason: cancelReason.trim() })
      if (error) throw error
    },
    onSuccess: () => {
      setCancelOpen(false)
      setCancelReason('')
      setCancelError(null)
      invalidate()
    },
    onError: (err) => setCancelError(translateSupabaseError(err, t('clubMemberships.detail.errors.cancelError'))),
  })

  if (isLoading || !detail) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent><p className="text-sm text-text-secondary">{t('common.loading')}</p></DialogContent>
      </Dialog>
    )
  }

  const planName = i18n.language === 'en' ? detail.plan_name_en : detail.plan_name_ar
  const isFrozen = detail.effective_status === 'frozen'
  const canRenewThis = ['active', 'scheduled', 'expired'].includes(detail.effective_status)
  const isCancelled = detail.status === 'cancelled'

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>{detail.customer_name}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
              <div>
                <p className="font-medium">{planName}</p>
                <p className="text-xs tabular-nums text-text-secondary"><bdi>{detail.membership_number}</bdi></p>
              </div>
              <StatusBadge
                tone={CLUB_MEMBERSHIP_STATUS_TONE[detail.effective_status] ?? 'neutral'}
                label={t(`clubMemberships.statusLabels.${detail.effective_status}`, { defaultValue: detail.effective_status })}
              />
            </div>

            <div className="grid grid-cols-2 gap-3 text-sm">
              <div><p className="text-text-secondary">{t('clubMemberships.startDate')}</p><p className="tabular-nums">{detail.start_date}</p></div>
              <div><p className="text-text-secondary">{t('clubMemberships.expiryDate')}</p><p className="tabular-nums">{detail.effective_end_date}</p></div>
              <div><p className="text-text-secondary">{t('clubMemberships.branch')}</p><p>{detail.branch_name}</p></div>
              <div><p className="text-text-secondary">{t('clubMemberships.detail.price')}</p><p className="tabular-nums">{detail.price.toFixed(0)} {t('common.currency')}</p></div>
            </div>

            {isCancelled && detail.cancel_reason && (
              <div className="rounded-md border border-status-danger/30 bg-status-danger/5 p-3 text-sm">
                <p className="font-medium text-status-danger">{t('clubMemberships.detail.cancelledNotice')}</p>
                <p className="text-text-secondary">{detail.cancel_reason}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t border-border pt-3">
              {canRenew && canRenewThis && (
                <Button size="sm" onClick={() => setRenewOpen(true)}>{t('common.renew')}</Button>
              )}
              {canFreeze && detail.effective_status === 'active' && (
                planFlags?.allow_freeze ? (
                  <Button size="sm" variant="outline" onClick={() => setFreezeOpen(true)}>{t('clubMemberships.detail.freezeAction')}</Button>
                ) : (
                  <span title={t('clubMemberships.detail.freezeNotAllowedTooltip')}>
                    <Button size="sm" variant="outline" disabled>{t('clubMemberships.detail.freezeAction')}</Button>
                  </span>
                )
              )}
              {canFreeze && isFrozen && (
                <Button size="sm" variant="outline" disabled={resumeMutation.isPending} onClick={() => resumeMutation.mutate()}>
                  {resumeMutation.isPending ? t('common.saving', { defaultValue: 'Saving...' }) : t('clubMemberships.detail.resumeAction')}
                </Button>
              )}
              {canCancel && !isCancelled && (
                <Button size="sm" variant="outline" className="border-status-danger/40 text-status-danger hover:bg-status-danger/10" onClick={() => setCancelOpen(true)}>
                  {t('clubMemberships.detail.cancelAction')}
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => setCardOpen(true)}>{t('clubMemberships.detail.viewCard')}</Button>
              {detail.invoice_id && (
                <Button size="sm" variant="ghost" onClick={() => navigate(`/app/finance/payments?invoice=${detail.invoice_id}`)}>
                  {t('common.viewInvoice')}
                </Button>
              )}
            </div>

            {actionError && <p role="alert" className="text-sm text-status-danger">{actionError}</p>}

            {/* Cancel -- sensitive action, mirrors CashShiftPage.tsx's
                cash.liability.settle inline confirm-panel UX: reason input
                + explicit second confirm click, never a bare single-click
                destructive button. */}
            {cancelOpen && (
              <div className="flex flex-col gap-2 rounded-lg border border-status-danger/40 bg-status-danger/5 p-3">
                <label className="text-sm font-medium text-status-danger">{t('clubMemberships.detail.cancelReasonLabel')}</label>
                <Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder={t('clubMemberships.detail.cancelReasonPlaceholder')} />
                {cancelError && <p role="alert" className="text-xs text-status-danger">{cancelError}</p>}
                <div className="flex gap-2">
                  <Button size="sm" variant="destructive" disabled={!cancelReason.trim() || cancelMutation.isPending} onClick={() => cancelMutation.mutate()}>
                    {cancelMutation.isPending ? t('common.saving', { defaultValue: 'Saving...' }) : t('clubMemberships.detail.confirmCancel')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setCancelOpen(false); setCancelReason(''); setCancelError(null) }}>
                    {t('common.cancel')}
                  </Button>
                </div>
              </div>
            )}

            <div>
              <p className="mb-2 text-sm font-medium text-text-secondary">{t('clubMemberships.detail.freezeHistory')}</p>
              <DataTable
                columns={[
                  { key: 'range', header: t('clubMemberships.detail.freezeRange'), render: (f: FreezeRow) => <span className="tabular-nums">{f.start_date} — {f.end_date}</span> },
                  { key: 'days', header: t('clubMemberships.detail.freezeDays'), render: (f: FreezeRow) => <span className="tabular-nums">{f.freeze_days}</span> },
                  { key: 'reason', header: t('clubMemberships.detail.freezeReason'), render: (f: FreezeRow) => f.reason ?? '—' },
                ] as DataTableColumn<FreezeRow>[]}
                rows={detail.freezes}
                rowKey={(f) => f.id}
                emptyTitle={t('clubMemberships.detail.noFreezes')}
              />
            </div>

            <div>
              <p className="mb-2 text-sm font-medium text-text-secondary">{t('clubMemberships.detail.renewalHistory')}</p>
              <DataTable
                columns={[
                  { key: 'number', header: t('clubMemberships.membershipNumber'), render: (r: RenewalRow) => <span className="tabular-nums"><bdi>{r.membership_number}</bdi></span> },
                  { key: 'range', header: t('clubMemberships.detail.freezeRange'), render: (r: RenewalRow) => <span className="tabular-nums">{r.start_date} — {r.end_date}</span> },
                  { key: 'status', header: t('common.status', { defaultValue: 'Status' }), render: (r: RenewalRow) => <StatusBadge tone={CLUB_MEMBERSHIP_STATUS_TONE[r.status] ?? 'neutral'} label={t(`clubMemberships.statusLabels.${r.status}`, { defaultValue: r.status })} /> },
                  { key: 'price', header: t('clubMemberships.detail.price'), render: (r: RenewalRow) => <span className="tabular-nums">{r.price.toFixed(0)} {t('common.currency')}</span> },
                ] as DataTableColumn<RenewalRow>[]}
                rows={detail.renewal_history}
                rowKey={(r) => r.id}
                emptyTitle={t('clubMemberships.detail.noRenewalHistory')}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {renewOpen && (
        <RenewMembershipDialog
          membershipId={membershipId}
          currentPlanId={detail.plan_id}
          onClose={() => setRenewOpen(false)}
          onRenewed={() => { setRenewOpen(false); invalidate() }}
        />
      )}

      {freezeOpen && (
        <FreezeMembershipDialog
          membershipId={membershipId}
          onClose={() => setFreezeOpen(false)}
          onFrozen={() => { setFreezeOpen(false); invalidate() }}
        />
      )}

      {cardOpen && (
        <Dialog open onOpenChange={(open) => !open && setCardOpen(false)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{t('clubMemberships.detail.viewCard')}</DialogTitle></DialogHeader>
            <MembershipCard
              data={{
                clubId: currentMembership?.clubId ?? '',
                customerId: detail.customer_id,
                customerName: detail.customer_name,
                customerPhotoUrl: detail.customer_photo_url,
                membershipNumber: detail.membership_number,
                planName,
                effectiveStatus: detail.effective_status,
                effectiveEndDate: detail.effective_end_date,
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}

function RenewMembershipDialog({
  membershipId, currentPlanId, onClose, onRenewed,
}: {
  membershipId: string
  currentPlanId: string
  onClose: () => void
  onRenewed: () => void
}) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const navigate = useNavigate()
  const [startDate, setStartDate] = useState('')
  const [discount, setDiscount] = useState('0')
  const [error, setError] = useState<string | null>(null)

  const { data: plans = [] } = useQuery({
    queryKey: ['club-membership-plans-for-renew', currentClubId],
    queryFn: async () => {
      const { data, error: rpcError } = await supabase.rpc('list_club_membership_plans', { p_club_id: currentClubId!, p_include_archived: false })
      if (rpcError) throw rpcError
      return (data ?? []) as unknown as { plan_id: string; name_ar: string; name_en: string; is_active: boolean; allow_renewal: boolean }[]
    },
    enabled: !!currentClubId,
  })

  const currentPlan = plans.find((p) => p.plan_id === currentPlanId)

  const renewMutation = useMutation({
    mutationFn: async () => {
      const { data, error: rpcError } = await supabase.rpc('renew_club_membership', {
        p_membership_subscription_id: membershipId,
        p_start_date: startDate || undefined,
        p_discount: Number(discount || 0),
        p_idempotency_key: crypto.randomUUID(),
      })
      if (rpcError) throw rpcError
      return data?.[0]
    },
    onSuccess: (row) => {
      onRenewed()
      if (row?.invoice_id) navigate(`/app/finance/payments?invoice=${row.invoice_id}`)
    },
    onError: (err) => setError(translateSupabaseError(err, t('clubMemberships.detail.errors.renewError'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('common.renew')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          {currentPlan && !currentPlan.allow_renewal && (
            <p className="text-sm text-status-danger">{t('clubMemberships.detail.errors.renewalNotAllowed')}</p>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('clubMemberships.sell.renewalStartHint')}</label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('academy.enrollments.discount')}</label>
            <Input type="number" min={0} value={discount} onChange={(e) => setDiscount(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <Button disabled={renewMutation.isPending} onClick={() => renewMutation.mutate()}>
            {renewMutation.isPending ? t('academy.enrollments.enrolling') : t('clubMemberships.sell.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function FreezeMembershipDialog({
  membershipId, onClose, onFrozen,
}: {
  membershipId: string
  onClose: () => void
  onFrozen: () => void
}) {
  const { t } = useTranslation()
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [endDate, setEndDate] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const freezeMutation = useMutation({
    mutationFn: async () => {
      const { error: rpcError } = await supabase.rpc('freeze_club_membership', {
        p_membership_subscription_id: membershipId,
        p_start_date: startDate,
        p_end_date: endDate,
        p_reason: reason.trim() || undefined,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: onFrozen,
    onError: (err) => setError(translateSupabaseError(err, t('clubMemberships.detail.errors.freezeError'))),
  })

  const canSubmit = !!startDate && !!endDate && endDate > startDate

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('clubMemberships.detail.freezeAction')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('clubMemberships.startDate')}</label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('clubMemberships.expiryDate')}</label>
              <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-text-secondary">{t('clubMemberships.detail.freezeReason')}</label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <Button disabled={!canSubmit || freezeMutation.isPending} onClick={() => freezeMutation.mutate()}>
            {freezeMutation.isPending ? t('common.saving', { defaultValue: 'Saving...' }) : t('clubMemberships.detail.freezeAction')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
