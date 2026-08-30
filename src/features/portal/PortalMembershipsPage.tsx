import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'
import { PageHeader } from '@/components/ui/page-header'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { usePortalClub } from '@/app/providers/PortalClubProvider'
import { CLUB_MEMBERSHIP_STATUS_TONE, daysRemaining, previewClubMembershipEndDate } from '@/lib/domain/clubMembership'
import { MembershipCard } from '@/features/memberships/MembershipCard'

// Customer Portal -- "My Memberships". Mirrors PortalAcademyPage.tsx's
// structure (PageHeader, loading/error/empty states, useQuery +
// supabase.rpc) and PortalBookingsPage.tsx's Upcoming/Past grouping
// convention (Current/Upcoming/Past sections). Fetches via
// get_my_portal_club_memberships() (no args -- auth.uid() resolved
// server-side). Purchase/renewal go through the dedicated self-service
// RPCs (purchase_club_membership_self_service /
// renew_club_membership_self_service) built specifically for an
// authenticated portal customer -- NOT the staff-gated sell_club_membership
// (which requires club_membership.create, a staff permission a genuine
// customer never holds) -- then hand off to /portal/payments, mirroring
// how booking/academy portal purchases already deep-link to payment
// completion rather than this page inventing its own checkout UI.

interface PortalMembership {
  membership_subscription_id: string
  club_id: string
  club_name: string | null
  club_name_ar: string | null
  membership_number: string
  plan_name_ar: string
  plan_name_en: string
  status: string
  effective_status: string
  start_date: string
  end_date: string
  effective_end_date: string
  branch_name: string
  allow_renewal: boolean
}

interface PublicPlan {
  plan_id: string
  name_ar: string
  name_en: string
  description: string | null
  price: number
  duration_value: number
  duration_unit: 'day' | 'month' | 'year'
  allow_renewal: boolean
  allow_freeze: boolean
  branch_scope: 'all_branches' | 'selected_branches'
  branch_ids: string[]
}

interface BranchRow { id: string; name: string }

async function fetchMyMemberships(): Promise<PortalMembership[]> {
  const { data, error } = await supabase.rpc('get_my_portal_club_memberships')
  if (error) throw error
  return (data ?? []) as unknown as PortalMembership[]
}

async function fetchPublicPlans(clubId: string): Promise<PublicPlan[]> {
  const { data, error } = await supabase.rpc('get_public_club_membership_plans', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []) as unknown as PublicPlan[]
}

async function fetchBranches(clubId: string): Promise<BranchRow[]> {
  const { data, error } = await supabase.from('branches').select('id, name').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

export function PortalMembershipsPage() {
  const { t, i18n } = useTranslation()
  const { activeClubId, isLoading: clubLoading } = usePortalClub()
  const queryClient = useQueryClient()
  const [cardMembership, setCardMembership] = useState<PortalMembership | null>(null)
  const [browsePlansOpen, setBrowsePlansOpen] = useState(false)
  const [renewError, setRenewError] = useState<string | null>(null)

  const { data: allMemberships = [], isLoading, error } = useQuery({
    queryKey: ['portal', 'my-club-memberships'],
    queryFn: fetchMyMemberships,
    enabled: !clubLoading,
  })
  const memberships = allMemberships.filter((m) => m.club_id === activeClubId)

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ['portal', 'my-club-memberships'] })
  }

  const renewMutation = useMutation({
    mutationFn: async (membershipId: string) => {
      const { data, error: rpcError } = await supabase.rpc('renew_club_membership_self_service', {
        p_membership_subscription_id: membershipId,
        p_idempotency_key: crypto.randomUUID(),
      })
      if (rpcError) throw rpcError
      return data?.[0]
    },
    onSuccess: (row) => {
      setRenewError(null)
      invalidate()
      if (row?.invoice_id) window.location.assign(`/portal/payments?invoiceId=${row.invoice_id}`)
    },
    onError: (err) => setRenewError(translateSupabaseError(err, t('clubMemberships.detail.errors.renewError'))),
  })

  const current = memberships.filter((m) => m.effective_status === 'active' || m.effective_status === 'frozen')
  const upcoming = memberships.filter((m) => m.effective_status === 'scheduled' || m.effective_status === 'pending_payment')
  const past = memberships.filter((m) => m.effective_status === 'expired' || m.effective_status === 'cancelled')

  const planName = (m: PortalMembership) => i18n.language === 'en' ? m.plan_name_en : m.plan_name_ar
  const clubName = (m: PortalMembership) => i18n.language === 'en' ? (m.club_name ?? m.club_name_ar) : (m.club_name_ar ?? m.club_name)

  function renderCard(m: PortalMembership) {
    const remaining = daysRemaining(m.effective_end_date)
    const canRenew = m.allow_renewal && ['active', 'scheduled', 'expired'].includes(m.effective_status)
    return (
      <div key={m.membership_subscription_id} className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="font-medium">{clubName(m)}</p>
            <p className="text-xs text-text-secondary">{planName(m)}</p>
            <p className="text-xs tabular-nums text-text-secondary"><bdi>{m.membership_number}</bdi></p>
          </div>
          <StatusBadge
            tone={CLUB_MEMBERSHIP_STATUS_TONE[m.effective_status] ?? 'neutral'}
            label={t(`clubMemberships.statusLabels.${m.effective_status}`, { defaultValue: m.effective_status })}
          />
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs text-text-secondary">
          <p>{t('clubMemberships.startDate')}: <span className="tabular-nums">{m.start_date}</span></p>
          <p>{t('clubMemberships.expiryDate')}: <span className="tabular-nums">{m.effective_end_date}</span></p>
          {m.branch_name && <p>{m.branch_name}</p>}
          {remaining != null && m.effective_status === 'active' && (
            <p>{t('clubMemberships.daysRemaining', { count: remaining })}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2 border-t border-border pt-2">
          <Button size="sm" variant="outline" onClick={() => setCardMembership(m)}>{t('clubMemberships.detail.viewCard')}</Button>
          {canRenew && (
            <Button size="sm" disabled={renewMutation.isPending} onClick={() => renewMutation.mutate(m.membership_subscription_id)}>
              {renewMutation.isPending ? t('clubMemberships.portal.purchasing') : t('common.renew')}
            </Button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={t('clubMemberships.portal.title')}
        description={t('clubMemberships.portal.description')}
        actions={<Button size="sm" onClick={() => setBrowsePlansOpen(true)}>{t('clubMemberships.portal.buyMembership')}</Button>}
      />

      {(isLoading || clubLoading) && <p className="text-sm text-text-secondary">{t('portal.academyPage.loading')}</p>}
      {error && <p className="text-sm text-status-danger">{t('portal.academyPage.loadError')}</p>}
      {renewError && <p role="alert" className="text-sm text-status-danger">{renewError}</p>}

      {!isLoading && !clubLoading && memberships.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          <p>{t('clubMemberships.portal.emptyTitle')}</p>
          <Button size="sm" onClick={() => setBrowsePlansOpen(true)}>{t('clubMemberships.portal.buyMembership')}</Button>
        </div>
      )}

      {current.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-text-secondary">{t('clubMemberships.portal.current')}</h2>
          {current.map(renderCard)}
        </div>
      )}

      {upcoming.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-text-secondary">{t('clubMemberships.portal.upcoming')}</h2>
          {upcoming.map(renderCard)}
        </div>
      )}

      {past.length > 0 && (
        <div className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-text-secondary">{t('clubMemberships.portal.past')}</h2>
          {past.map(renderCard)}
        </div>
      )}

      {cardMembership && (
        <Dialog open onOpenChange={(open) => !open && setCardMembership(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>{t('clubMemberships.detail.viewCard')}</DialogTitle></DialogHeader>
            {/* Portal customers don't have their own customer_id surfaced
                on this RPC row -- ensure_customer_membership_qr resolves
                the caller's own linked customer server-side via
                club_membership.view OR customers.user_id = auth.uid(), so
                passing the membership's own club_id here is enough; the
                card component itself resolves the QR token from
                auth context, not from a client-supplied customer id. */}
            <PortalMembershipCardResolver membership={cardMembership} />
          </DialogContent>
        </Dialog>
      )}

      {browsePlansOpen && activeClubId && (
        <BrowsePlansDialog
          clubId={activeClubId}
          onClose={() => setBrowsePlansOpen(false)}
          onPurchased={() => { setBrowsePlansOpen(false); invalidate() }}
        />
      )}
    </div>
  )
}

interface PortalCustomerNameRow { customer_id: string; club_id: string; full_name: string }

async function fetchMyCustomerNames(): Promise<PortalCustomerNameRow[]> {
  const { data, error } = await supabase.rpc('get_my_portal_customers')
  if (error) throw error
  return (data ?? []) as unknown as PortalCustomerNameRow[]
}

// The portal RPC (get_my_portal_club_memberships) does not return the
// customer_id or full_name needed by MembershipCard/
// ensure_customer_membership_qr -- resolve both here via
// get_my_portal_customers (already the established, security-hardened
// "which customer records do I own" source, see PortalClubProvider.tsx's
// own header comment) rather than widening the read RPC's return shape.
// PortalClubProvider's own PortalCustomerMembership type only keeps
// customerId/clubId/clubName (no full_name), so this is fetched directly
// rather than misusing the club name as a stand-in for the customer's
// own name on their card.
function PortalMembershipCardResolver({ membership }: { membership: PortalMembership }) {
  const { t, i18n } = useTranslation()
  const { data: customers = [] } = useQuery({
    queryKey: ['portal-my-customer-names'],
    queryFn: fetchMyCustomerNames,
  })
  const customer = customers.find((c) => c.club_id === membership.club_id)

  if (!customer) {
    return <p className="text-sm text-status-danger">{t('clubMemberships.qrError')}</p>
  }

  return (
    <MembershipCard
      data={{
        clubId: membership.club_id,
        customerId: customer.customer_id,
        customerName: customer.full_name,
        customerPhotoUrl: null,
        membershipNumber: membership.membership_number,
        planName: i18n.language === 'en' ? membership.plan_name_en : membership.plan_name_ar,
        effectiveStatus: membership.effective_status,
        effectiveEndDate: membership.effective_end_date,
      }}
    />
  )
}

function BrowsePlansDialog({ clubId, onClose, onPurchased }: { clubId: string; onClose: () => void; onPurchased: () => void }) {
  const { t, i18n } = useTranslation()
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [branchId, setBranchId] = useState('')
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [error, setError] = useState<string | null>(null)

  const { data: plans = [], isLoading } = useQuery({
    queryKey: ['portal-public-membership-plans', clubId],
    queryFn: () => fetchPublicPlans(clubId),
    enabled: !!clubId,
  })
  const { data: branches = [] } = useQuery({
    queryKey: ['portal-branches-for-membership-purchase', clubId],
    queryFn: () => fetchBranches(clubId),
    enabled: !!clubId,
  })

  const plan = plans.find((p) => p.plan_id === selectedPlanId) ?? null
  const allowedBranches = plan?.branch_scope === 'selected_branches'
    ? branches.filter((b) => plan.branch_ids.includes(b.id))
    : branches
  const endDatePreview = plan ? previewClubMembershipEndDate(startDate, plan.duration_value, plan.duration_unit) : null

  const purchaseMutation = useMutation({
    mutationFn: async () => {
      if (!plan) throw new Error(t('clubMemberships.portal.purchasePlanRequired'))
      const resolvedBranchId = plan.branch_scope === 'selected_branches' ? branchId : (branchId || allowedBranches[0]?.id)
      if (!resolvedBranchId) throw new Error(t('clubMemberships.portal.purchaseBranchRequired'))
      const { data, error: rpcError } = await supabase.rpc('purchase_club_membership_self_service', {
        p_club_id: clubId,
        p_plan_id: plan.plan_id,
        p_branch_id: resolvedBranchId,
        p_start_date: startDate,
        p_idempotency_key: crypto.randomUUID(),
      })
      if (rpcError) throw rpcError
      return data?.[0]
    },
    onSuccess: (row) => {
      onPurchased()
      if (row?.invoice_id) window.location.assign(`/portal/payments?invoiceId=${row.invoice_id}`)
    },
    onError: (err) => setError(translateSupabaseError(err, t('clubMemberships.portal.purchaseError'))),
  })

  const needsBranchChoice = plan?.branch_scope === 'selected_branches'
  const canSubmit = !!plan && !!startDate && (!needsBranchChoice || !!branchId)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('clubMemberships.portal.buyMembership')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          {isLoading && <p className="text-sm text-text-secondary">{t('common.loading')}</p>}
          {!isLoading && plans.length === 0 && <p className="text-sm text-text-secondary">{t('clubMemberships.portal.noPlansAvailable')}</p>}

          {plans.length > 0 && (
            <>
              <Select value={selectedPlanId} onValueChange={(v) => { setSelectedPlanId(v); setBranchId(''); setError(null) }}>
                <SelectTrigger><SelectValue placeholder={t('clubMemberships.membershipPlan')} /></SelectTrigger>
                <SelectContent>
                  {plans.map((p) => (
                    <SelectItem key={p.plan_id} value={p.plan_id}>
                      {i18n.language === 'en' ? p.name_en : p.name_ar} — {p.price.toFixed(0)} {t('common.currency')}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              {plan?.description && <p className="text-sm text-text-secondary">{plan.description}</p>}

              {needsBranchChoice && (
                <Select value={branchId} onValueChange={setBranchId}>
                  <SelectTrigger><SelectValue placeholder={t('clubMemberships.branch')} /></SelectTrigger>
                  <SelectContent>
                    {allowedBranches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}

              <div className="flex gap-2">
                <div className="flex flex-1 flex-col gap-1">
                  <label className="text-xs text-text-secondary">{t('clubMemberships.startDate')}</label>
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </div>
                <div className="flex flex-1 flex-col gap-1">
                  <label className="text-xs text-text-secondary">{t('clubMemberships.expiryDate')}</label>
                  <Input disabled value={endDatePreview ?? '—'} />
                </div>
              </div>

              {plan && (
                <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm font-semibold">
                  <span>{t('academy.enrollments.total')}</span>
                  <span className="tabular-nums">{plan.price.toFixed(0)} {t('common.currency')}</span>
                </div>
              )}

              {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}

              <Button disabled={!canSubmit || purchaseMutation.isPending} onClick={() => purchaseMutation.mutate()}>
                {purchaseMutation.isPending ? t('clubMemberships.portal.purchasing') : t('clubMemberships.portal.purchaseSubmit')}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
