import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'
import { useAuth } from '@/app/providers/AuthProvider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
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
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  type EnrollmentRow,
  type SubscriptionRow,
} from '@/lib/domain/academy'

// Enrollment Wizard (guardian -> player -> group -> subscription ->
// invoice -> payment, per USER_FLOWS.md) + freeze UI + a simple
// activation-policy dropdown in club settings-equivalent (kept here,
// scoped to academy, rather than a separate settings screen -- matches
// the "simple dropdown, not a rich policy UI" call in ADR-013).
async function fetchEnrollments(clubId: string) {
  const { data, error } = await supabase
    .from('enrollments')
    .select('id, player_id, group_id, status, enrolled_at, players(full_name), groups(name)')
    .eq('club_id', clubId)
    .order('enrolled_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []).map<EnrollmentRow>((e) => ({
    id: e.id,
    playerId: e.player_id,
    groupId: e.group_id,
    status: e.status,
    enrolledAt: e.enrolled_at,
    playerName: (e.players as unknown as { full_name: string } | null)?.full_name,
    groupName: (e.groups as unknown as { name: string } | null)?.name,
  }))
}

async function fetchSubscriptionForEnrollment(enrollmentId: string) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id')
    .eq('enrollment_id', enrollmentId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return {
    id: data.id,
    enrollmentId: data.enrollment_id,
    planType: data.plan_type,
    startDate: data.start_date,
    endDate: data.end_date,
    price: Number(data.price),
    discount: Number(data.discount),
    status: data.status,
    invoiceId: data.invoice_id,
  } as SubscriptionRow
}

async function fetchPlayers(clubId: string) {
  const { data, error } = await supabase.from('players').select('id, full_name').eq('club_id', clubId).eq('status', 'active').order('full_name')
  if (error) throw error
  return data ?? []
}

async function fetchGroups(clubId: string) {
  const { data, error } = await supabase.from('groups').select('id, name, capacity, status, subscription_price').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

async function fetchGuardiansForPlayer(playerId: string) {
  const { data, error } = await supabase.from('guardian_links').select('customer_id, is_primary, customers(full_name)').eq('player_id', playerId)
  if (error) throw error
  return (data ?? []).map((g) => ({
    id: g.customer_id,
    name: (g.customers as unknown as { full_name: string } | null)?.full_name ?? g.customer_id,
    isPrimary: g.is_primary,
  }))
}

export function EnrollmentSection() {
  const { t } = useTranslation()
  const { currentClubId, currentMembership } = useAuth()

  const SUBSCRIPTION_PLAN_LABELS: Record<string, string> = {
    monthly: t('academy.subscriptionPlanLabels.monthly'),
    quarterly: t('academy.subscriptionPlanLabels.quarterly'),
    season: t('academy.subscriptionPlanLabels.season'),
    package: t('academy.subscriptionPlanLabels.package'),
  }

  const SUBSCRIPTION_STATUS_LABELS: Record<string, string> = {
    pending: t('academy.subscriptionStatusLabels.pending'),
    active: t('academy.subscriptionStatusLabels.active'),
    frozen: t('academy.subscriptionStatusLabels.frozen'),
    expired: t('academy.subscriptionStatusLabels.expired'),
    cancelled: t('academy.subscriptionStatusLabels.cancelled'),
    // Phase E (E5): DUE is a display-only derivation (an active
    // subscription within 7 days of end_date) computed client-side from
    // the same rule get_academy_subscription_display_status() uses --
    // never a real stored status, since it's a moving target that
    // changes without any write happening.
    due: t('academy.subscriptionStatusLabels.due'),
  }
  const queryClient = useQueryClient()

  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardPlayerId, setWizardPlayerId] = useState('')
  const [wizardGroupId, setWizardGroupId] = useState('')
  const [wizardGuardianId, setWizardGuardianId] = useState('')
  const [wizardPlanType, setWizardPlanType] = useState('monthly')
  const [wizardStart, setWizardStart] = useState('')
  const [wizardEnd, setWizardEnd] = useState('')
  const [wizardPrice, setWizardPrice] = useState('')
  const [wizardDiscount, setWizardDiscount] = useState('0')
  const [wizardError, setWizardError] = useState<string | null>(null)
  // Directive Sections 19-24: the enrollment wizard previously created a
  // pending invoice and left collecting payment entirely to a separate
  // trip to Billing, with no link back to the invoice it just created --
  // real friction found by audit. Not duplicating the payment form here
  // (that would re-create the exact per-surface drift problem Phase B
  // fixed for government receipts); instead this deep-links straight to
  // the new invoice on Billing's existing collect-payment flow.
  const [justEnrolledInvoiceId, setJustEnrolledInvoiceId] = useState<string | null>(null)

  // Phase A dropdown audit: onSuccess already cleared the wizard fields
  // after a successful submit, but closing the dialog via Cancel (or the
  // sheet's own dismiss) left every field -- including all four Selects
  // -- holding the previous, unrelated selection. Reopening the wizard
  // then silently pre-filled a new enrollment with a stale player/group/
  // guardian/plan choice. Resetting on `wizardOpen` becoming false covers
  // both the cancel path and the submit path uniformly.
  useEffect(() => {
    if (!wizardOpen) {
      setWizardPlayerId('')
      setWizardGroupId('')
      setWizardGuardianId('')
      setWizardPlanType('monthly')
      setWizardStart('')
      setWizardEnd('')
      setWizardPrice('')
      setWizardDiscount('0')
      setWizardError(null)
    }
  }, [wizardOpen])

  const [selectedEnrollment, setSelectedEnrollment] = useState<EnrollmentRow | null>(null)
  const [freezeStart, setFreezeStart] = useState('')
  const [freezeEnd, setFreezeEnd] = useState('')
  const [freezeReason, setFreezeReason] = useState('')

  const { data: enrollments = [], isLoading } = useQuery({
    queryKey: ['enrollments', currentClubId],
    queryFn: () => fetchEnrollments(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: players = [] } = useQuery({ queryKey: ['players-for-enrollment', currentClubId], queryFn: () => fetchPlayers(currentClubId!), enabled: !!currentClubId })
  const { data: groups = [] } = useQuery({ queryKey: ['groups-for-enrollment', currentClubId], queryFn: () => fetchGroups(currentClubId!), enabled: !!currentClubId })

  // Locked pricing rule: the employee selects the group, the system
  // resolves the approved price automatically -- never freely typed.
  // The price field itself stays read-only; only the (permission-gated)
  // discount remains editable.
  const selectedGroupForPrice = groups.find((g) => g.id === wizardGroupId)
  useEffect(() => {
    if (selectedGroupForPrice) {
      setWizardPrice(selectedGroupForPrice.subscription_price != null ? String(selectedGroupForPrice.subscription_price) : '')
    } else {
      setWizardPrice('')
    }
  }, [selectedGroupForPrice])

  const { data: guardians = [] } = useQuery({
    queryKey: ['guardians-for-player', wizardPlayerId],
    queryFn: () => fetchGuardiansForPlayer(wizardPlayerId),
    enabled: !!wizardPlayerId,
  })

  const { data: subscription } = useQuery({
    queryKey: ['subscription-for-enrollment', selectedEnrollment?.id],
    queryFn: () => fetchSubscriptionForEnrollment(selectedEnrollment!.id),
    enabled: !!selectedEnrollment,
  })

  const effectiveEndQuery = useQuery({
    queryKey: ['effective-end-date', subscription?.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_subscription_effective_end_date', { p_subscription_id: subscription!.id })
      if (error) throw error
      return data as string
    },
    enabled: !!subscription,
  })

  const enrollMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('create_enrollment_with_subscription', {
        p_player_id: wizardPlayerId,
        p_group_id: wizardGroupId,
        p_guardian_id: wizardGuardianId,
        p_plan_type: wizardPlanType,
        p_start_date: wizardStart,
        p_end_date: wizardEnd,
        p_price: Number(wizardPrice),
        p_discount: Number(wizardDiscount || 0),
      })
      if (error) throw error
      return data?.[0]?.invoice_id as string | undefined
    },
    onSuccess: (invoiceId) => {
      setWizardOpen(false)
      setJustEnrolledInvoiceId(invoiceId ?? null)
      setWizardPlayerId('')
      setWizardGroupId('')
      setWizardGuardianId('')
      setWizardPrice('')
      setWizardDiscount('0')
      setWizardError(null)
      void queryClient.invalidateQueries({ queryKey: ['enrollments', currentClubId] })
    },
    onError: (error) =>
      setWizardError(translateSupabaseError(error, t('academy.enrollments.enrollError'))),
  })

  const freezeMutation = useMutation({
    mutationFn: async () => {
      if (!subscription) throw new Error('no subscription')
      const { error } = await supabase.rpc('freeze_subscription', {
        p_subscription_id: subscription.id,
        p_start_date: freezeStart,
        p_end_date: freezeEnd,
        ...(freezeReason ? { p_reason: freezeReason } : {}),
        p_extends_expiry: true,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setFreezeStart('')
      setFreezeEnd('')
      setFreezeReason('')
      void queryClient.invalidateQueries({ queryKey: ['subscription-for-enrollment', selectedEnrollment?.id] })
      void queryClient.invalidateQueries({ queryKey: ['effective-end-date', subscription?.id] })
    },
  })

  const activateMutation = useMutation({
    mutationFn: async () => {
      if (!subscription) throw new Error('no subscription')
      const { error } = await supabase.rpc('activate_subscription_if_due', { p_subscription_id: subscription.id })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['subscription-for-enrollment', selectedEnrollment?.id] })
    },
  })

  // Phase E (E4): renewal creates a NEW subscription row for the same
  // enrollment -- never overwrites the expired/cancelled one, which
  // stays as history. Only reachable once the current subscription is
  // in a terminal status, matching renew_academy_subscription()'s own
  // server-side guard.
  const [renewStart, setRenewStart] = useState('')
  const [renewEnd, setRenewEnd] = useState('')
  const [renewError, setRenewError] = useState<string | null>(null)

  // Reset renewal fields whenever a different enrollment is selected (or
  // the dialog closes) so a stale date range/error from one player's
  // renewal can never leak into another's.
  useEffect(() => {
    setRenewStart('')
    setRenewEnd('')
    setRenewError(null)
  }, [selectedEnrollment])

  const renewMutation = useMutation({
    mutationFn: async () => {
      if (!selectedEnrollment) throw new Error('no enrollment selected')
      const group = groups.find((g) => g.id === selectedEnrollment.groupId)
      const price = group?.subscription_price
      if (price == null) throw new Error(t('academy.enrollments.noApprovedPrice'))
      const { error } = await supabase.rpc('renew_academy_subscription', {
        p_enrollment_id: selectedEnrollment.id,
        p_start_date: renewStart,
        p_end_date: renewEnd,
        p_price: price,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setRenewStart('')
      setRenewEnd('')
      setRenewError(null)
      void queryClient.invalidateQueries({ queryKey: ['subscription-for-enrollment', selectedEnrollment?.id] })
    },
    onError: (error) => setRenewError(translateSupabaseError(error, t('academy.enrollments.renewError'))),
  })

  const columns: DataTableColumn<EnrollmentRow>[] = [
    {
      key: 'player',
      header: t('academy.enrollments.player'),
      render: (e) => (
        <button className="text-accent-foreground hover:underline" onClick={() => setSelectedEnrollment(e)}>
          {e.playerName ?? '—'}
        </button>
      ),
    },
    { key: 'group', header: t('academy.enrollments.group'), render: (e) => e.groupName ?? '—' },
    { key: 'status', header: t('academy.enrollments.status'), render: (e) => <StatusBadge tone={e.status === 'active' ? 'success' : 'neutral'} label={e.status === 'active' ? t('academy.enrollments.statusActive') : t('academy.enrollments.statusWithdrawn')} /> },
  ]

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">{t('academy.enrollments.manageSubtitle')}</p>
        <Dialog open={wizardOpen} onOpenChange={setWizardOpen}>
          <DialogTrigger asChild>
            <Button size="sm">{t('academy.enrollments.newEnrollment')}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{t('academy.enrollments.wizardTitle')}</DialogTitle></DialogHeader>
            <div className="flex flex-col gap-3">
              <Select value={wizardPlayerId} onValueChange={(v) => { setWizardPlayerId(v); setWizardGuardianId('') }}>
                <SelectTrigger><SelectValue placeholder={t('academy.enrollments.player')} /></SelectTrigger>
                <SelectContent>{players.map((p) => <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>)}</SelectContent>
              </Select>
              {guardians.length > 0 && (
                <Select value={wizardGuardianId} onValueChange={setWizardGuardianId}>
                  <SelectTrigger><SelectValue placeholder={t('academy.enrollments.guardianForBilling')} /></SelectTrigger>
                  <SelectContent>{guardians.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}{g.isPrimary ? ` ${t('academy.players.primary')}` : ''}</SelectItem>)}</SelectContent>
                </Select>
              )}
              <Select value={wizardGroupId} onValueChange={setWizardGroupId}>
                <SelectTrigger><SelectValue placeholder={t('academy.enrollments.group')} /></SelectTrigger>
                <SelectContent>{groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}</SelectContent>
              </Select>
              {/* Phase E simplification: every subscription in production
                  has always been 'monthly' (0 rows ever used quarterly/
                  season/package) -- the plan-type choice was UI
                  complexity the data never actually used. Removed the
                  Select; wizardPlanType stays fixed at 'monthly' and the
                  end date is now auto-computed one month out instead of
                  asking staff to pick both ends of a period whose length
                  is no longer a real choice. */}
              <div className="flex gap-2">
                <label className="sr-only" htmlFor="wizard-start">{t('academy.enrollments.startDate')}</label>
                <Input
                  id="wizard-start"
                  required
                  type="date"
                  value={wizardStart}
                  onChange={(e) => {
                    setWizardStart(e.target.value)
                    if (e.target.value) {
                      const d = new Date(e.target.value)
                      d.setMonth(d.getMonth() + 1)
                      setWizardEnd(d.toISOString().slice(0, 10))
                    }
                  }}
                />
                <label className="sr-only" htmlFor="wizard-end">{t('academy.enrollments.endDate')}</label>
                <Input id="wizard-end" required type="date" value={wizardEnd} onChange={(e) => setWizardEnd(e.target.value)} />
              </div>

              {/* Locked pricing rule: price is resolved from the group's
                  approved subscription_price, never freely typed. Only
                  the discount stays editable. */}
              {wizardGroupId && (
                <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
                  {selectedGroupForPrice?.subscription_price != null ? (
                    <div className="flex flex-col gap-1">
                      <div className="flex justify-between">
                        <span className="text-text-secondary">{t('academy.enrollments.approvedSubscriptionPrice')}</span>
                        <span className="font-medium tabular-nums">{Number(wizardPrice).toFixed(0)} {t('common.currency')}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-text-secondary">{t('academy.enrollments.discount')}</span>
                        <Input
                          type="number"
                          min={0}
                          max={Number(wizardPrice)}
                          value={wizardDiscount}
                          onChange={(e) => setWizardDiscount(e.target.value)}
                          className="h-7 w-24 text-end"
                        />
                      </div>
                      <div className="mt-1 flex justify-between border-t border-accent/20 pt-1 font-semibold">
                        <span>{t('academy.enrollments.total')}</span>
                        <span className="tabular-nums">{Math.max(Number(wizardPrice) - Number(wizardDiscount || 0), 0).toFixed(0)} {t('common.currency')}</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-status-danger">
                      {t('academy.enrollments.noApprovedPrice')}
                    </p>
                  )}
                </div>
              )}
              {wizardError && <p role="alert" className="text-sm text-status-danger">{wizardError}</p>}
              <Button
                disabled={!wizardPlayerId || !wizardGuardianId || !wizardGroupId || !wizardStart || !wizardEnd || selectedGroupForPrice?.subscription_price == null || enrollMutation.isPending}
                onClick={() => enrollMutation.mutate()}
              >
                {enrollMutation.isPending ? t('academy.enrollments.enrolling') : t('academy.enrollments.enrollAndCreateSubscription')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {justEnrolledInvoiceId && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-status-warning/40 bg-status-warning/5 p-3 text-sm">
          <span>{t('academy.enrollments.enrolledPendingPayment')}</span>
          <div className="flex items-center gap-2">
            <Button asChild size="sm">
              <Link to={`/app/billing?invoice=${justEnrolledInvoiceId}`} onClick={() => setJustEnrolledInvoiceId(null)}>
                {t('academy.enrollments.collectPaymentNow')}
              </Link>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setJustEnrolledInvoiceId(null)}>
              {t('academy.enrollments.dismiss')}
            </Button>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={enrollments}
        rowKey={(e) => e.id}
        isLoading={isLoading}
        emptyTitle={t('academy.enrollments.emptyTitle')}
        emptyDescription={t('academy.enrollments.emptyDescription')}
      />

      <Dialog open={!!selectedEnrollment} onOpenChange={(open) => !open && setSelectedEnrollment(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>{t('academy.enrollments.subscriptionOf', { name: selectedEnrollment?.playerName })}</DialogTitle></DialogHeader>
          {subscription ? (
            <div className="flex flex-col gap-3 text-sm">
              <p>{t('academy.enrollments.plan', { plan: SUBSCRIPTION_PLAN_LABELS[subscription.planType] ?? subscription.planType })}</p>
              <p>{t('academy.enrollments.dateRange', { start: subscription.startDate, end: subscription.endDate })}</p>
              {effectiveEndQuery.data && effectiveEndQuery.data !== subscription.endDate && (
                <p className="text-status-warning">{t('academy.enrollments.effectiveEndDate', { date: effectiveEndQuery.data })}</p>
              )}
              <MoneyDisplay amount={subscription.price - subscription.discount} size="lg" />
              {(() => {
                // Phase E (E5): mirrors get_academy_subscription_display_status()'s
                // rule client-side -- an active/pending subscription
                // within 7 days of end_date reads as DUE, past end_date
                // reads as EXPIRED, even before the daily cron sweep has
                // actually transitioned the stored status. Never
                // overrides a terminal status (frozen/expired/cancelled
                // display exactly as stored).
                const today = new Date().toISOString().slice(0, 10)
                const displayStatus = ['expired', 'cancelled', 'frozen'].includes(subscription.status)
                  ? subscription.status
                  : subscription.endDate < today
                    ? 'expired'
                    : subscription.endDate <= new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
                      ? 'due'
                      : subscription.status
                return (
                  <StatusBadge
                    tone={displayStatus === 'active' ? 'success' : displayStatus === 'due' || displayStatus === 'frozen' ? 'warning' : displayStatus === 'expired' ? 'danger' : 'neutral'}
                    label={SUBSCRIPTION_STATUS_LABELS[displayStatus] ?? displayStatus}
                  />
                )
              })()}

              {subscription.status === 'pending' && currentMembership?.roleKey && ['club_manager', 'academy_manager'].includes(currentMembership.roleKey) && (
                <Button size="sm" variant="outline" disabled={activateMutation.isPending} onClick={() => activateMutation.mutate()}>
                  {t('academy.enrollments.manualActivation')}
                </Button>
              )}

              {(subscription.status === 'active' || subscription.status === 'frozen') && (
                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <p className="font-medium">{t('academy.enrollments.freezeSubscription')}</p>
                  <div className="flex gap-2">
                    <Input type="date" value={freezeStart} onChange={(e) => setFreezeStart(e.target.value)} />
                    <Input type="date" value={freezeEnd} onChange={(e) => setFreezeEnd(e.target.value)} />
                  </div>
                  <Input placeholder={t('academy.enrollments.reason')} value={freezeReason} onChange={(e) => setFreezeReason(e.target.value)} />
                  <Button size="sm" disabled={!freezeStart || !freezeEnd || freezeMutation.isPending} onClick={() => freezeMutation.mutate()}>
                    {t('academy.enrollments.freeze')}
                  </Button>
                </div>
              )}

              {/* Phase E (E4): renewal only reachable once the current
                  subscription has reached a terminal status -- matches
                  renew_academy_subscription()'s own server-side guard,
                  so the button is never shown in a state the server
                  would reject anyway. */}
              {(subscription.status === 'expired' || subscription.status === 'cancelled') && (
                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <p className="font-medium">{t('academy.enrollments.renewSubscription')}</p>
                  <div className="flex gap-2">
                    <Input
                      type="date"
                      value={renewStart}
                      onChange={(e) => {
                        setRenewStart(e.target.value)
                        if (e.target.value) {
                          const d = new Date(e.target.value)
                          d.setMonth(d.getMonth() + 1)
                          setRenewEnd(d.toISOString().slice(0, 10))
                        }
                      }}
                    />
                    <Input type="date" value={renewEnd} onChange={(e) => setRenewEnd(e.target.value)} />
                  </div>
                  {renewError && <p className="text-status-danger text-xs">{renewError}</p>}
                  <Button size="sm" disabled={!renewStart || !renewEnd || renewMutation.isPending} onClick={() => renewMutation.mutate()}>
                    {renewMutation.isPending ? t('academy.enrollments.renewing') : t('academy.enrollments.renew')}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-text-secondary">{t('academy.enrollments.noSubscription')}</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Simple activation-policy dropdown -- club_owner-scoped setting, kept
// minimal per ADR-013 ("a simple dropdown ... is sufficient").
export function ActivationPolicySetting() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()

  const ACTIVATION_POLICY_LABELS: Record<string, string> = {
    manual: t('academy.activationPolicyLabels.manual'),
    first_payment: t('academy.activationPolicyLabels.first_payment'),
    full_payment: t('academy.activationPolicyLabels.full_payment'),
  }

  const { data: policy } = useQuery({
    queryKey: ['activation-policy', currentClubId],
    queryFn: async () => {
      const { data, error } = await supabase.from('clubs').select('subscription_activation_policy').eq('id', currentClubId!).single()
      if (error) throw error
      return data.subscription_activation_policy
    },
    enabled: !!currentClubId,
  })

  const updateMutation = useMutation({
    mutationFn: async (value: string) => {
      const { error } = await supabase.from('clubs').update({ subscription_activation_policy: value }).eq('id', currentClubId!)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['activation-policy', currentClubId] }),
  })

  return (
    <div className="flex items-center gap-3">
      <label className="text-sm font-medium text-text-secondary">{t('academy.enrollments.activationPolicy')}</label>
      <Select value={policy ?? 'first_payment'} onValueChange={(v) => updateMutation.mutate(v)}>
        <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
        <SelectContent>
          {Object.entries(ACTIVATION_POLICY_LABELS).map(([key, label]) => (
            <SelectItem key={key} value={key}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
