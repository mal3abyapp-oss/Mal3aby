import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LIFECYCLE_STATUS_LABELS, SUBSCRIPTION_KIND_LABELS, ACCESS_TONE, ACCESS_LABEL } from './labels'
import { actionLabel, entityLabel } from '@/lib/domain/audit'
import { useDirection } from '@/app/providers/DirectionProvider'
import { ErrorState } from '@/components/ui/error-state'

// Per-club detail: Overview / Current Subscription / History / Payment
// History / Access Status / Audit, plus the Actions panel wired to every
// Phase 3b/3c RPC. This is the single highest-surface-area screen in the
// Platform Owner console.

const REQUEST_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  pending: 'warning',
  reviewed: 'neutral',
  approved: 'success',
  dismissed: 'danger',
}

// See labels.ts: subscription_kind/lifecycle_status were rendered as
// raw enum values in three places on this page (owner-level review
// finding, P2) -- fixed via the shared label maps there.

async function fetchClub(clubId: string) {
  const { data, error } = await supabase.from('clubs').select('*').eq('id', clubId).single()
  if (error) throw error
  return data
}

async function fetchSubscriptions(clubId: string) {
  const { data, error } = await supabase
    .from('platform_subscriptions')
    .select('*')
    .eq('club_id', clubId)
    .order('start_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

async function fetchInvoices(clubId: string) {
  const { data, error } = await supabase
    .from('platform_invoices')
    .select('*, platform_payments(*)')
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

async function fetchClubAudit(clubId: string) {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('*')
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return data ?? []
}

async function fetchPlans() {
  const { data, error } = await supabase.from('platform_plans').select('*').eq('status', 'active').order('display_order')
  if (error) throw error
  return data ?? []
}

async function fetchEntitlements(clubId: string) {
  const { data, error } = await supabase.from('commercial_entitlements').select('*').eq('club_id', clubId).maybeSingle()
  if (error) throw error
  return data
}

async function fetchUsage(clubId: string) {
  const { data, error } = await supabase.from('commercial_entitlements_usage').select('*').eq('club_id', clubId).maybeSingle()
  if (error) throw error
  return data
}

async function fetchUpgradeRequests(clubId: string) {
  const { data, error } = await supabase
    .from('commercial_upgrade_requests')
    .select('*')
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export function PlatformClubDetailPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { clubId } = useParams<{ clubId: string }>()
  const queryClient = useQueryClient()
  const [reasonDialogAction, setReasonDialogAction] = useState<null | 'cancel' | 'reverse' | 'suspend' | 'changePlan'>(null)
  const [reasonTarget, setReasonTarget] = useState<string | null>(null)
  const [reasonText, setReasonText] = useState('')
  // Phase D directive (D2): "Extend grace" used to be a literal 14-day
  // hardcode with no input at all. Real input + preview of the resulting
  // date, plus a reason (consistent with every other subscription-
  // affecting action on this page).
  const [graceDaysInput, setGraceDaysInput] = useState('14')
  const [graceReasonText, setGraceReasonText] = useState('')
  const [showGraceDialog, setShowGraceDialog] = useState(false)
  const [showPaymentDialog, setShowPaymentDialog] = useState(false)
  const [paymentInvoiceId, setPaymentInvoiceId] = useState<string | null>(null)
  const [paymentMethod, setPaymentMethod] = useState('bank_transfer')
  const [paymentReference, setPaymentReference] = useState('')
  // Phase A directive (A2): create_platform_subscription now enforces a
  // real per-owner trial-abuse guard (checked against
  // automatic_trial_entitlements, not just the per-club uniqueness that
  // existed before). When it rejects, the platform owner can still force
  // an override, but only with a typed reason -- never silently, and
  // always audit-logged as a distinct "override" action server-side.
  const [trialBlockedReason, setTrialBlockedReason] = useState<string | null>(null)
  const [trialOverrideReason, setTrialOverrideReason] = useState('')
  const [selectedPlanId, setSelectedPlanId] = useState<string>('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [editingLimits, setEditingLimits] = useState(false)
  const [branchLimitInput, setBranchLimitInput] = useState('')
  const [fieldLimitInput, setFieldLimitInput] = useState('')
  const [academyLimitInput, setAcademyLimitInput] = useState('')
  // PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 3 (P1): a reason,
  // matching every other commercial-change dialog on this page, now
  // that limit changes are audited (see set_commercial_entitlements()).
  const [limitReasonInput, setLimitReasonInput] = useState('')

  const { data: club, isError: clubError } = useQuery({ queryKey: ['platform-club', clubId], queryFn: () => fetchClub(clubId!), enabled: !!clubId })
  // Phase C directive (Club 360): the audit's core test -- "if a club
  // owner calls support right now, can the platform owner understand
  // that club's full state within under a minute?" -- was a confirmed
  // NO: this page showed subscription/payment/audit data but zero owner
  // contact, facilities, or booking/customer volume. One batched RPC
  // (not per-section queries, consistent with the Phase A N+1 fix)
  // covers all of it in a single round trip.
  const { data: club360, isError: club360Error } = useQuery({
    queryKey: ['platform-club-360', clubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_platform_club_360', { p_club_id: clubId! })
      if (error) throw error
      return data?.[0] ?? null
    },
    enabled: !!clubId,
  })
  // Phase E directive (C8/E4): fills the WhatsApp health placeholder
  // card added in Phase C. Reuses the same batched, platform-wide RPC
  // Overview uses (no new N+1 surface) and filters to this one club --
  // cheap at current scale, and keeps a single source of truth for
  // WhatsApp health logic instead of a second per-club RPC.
  const { data: whatsappHealthRow } = useQuery({
    queryKey: ['platform-whatsapp-health', clubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_platform_whatsapp_health')
      if (error) throw error
      return (data ?? []).find((w) => w.club_id === clubId) ?? null
    },
    enabled: !!clubId,
  })
  // Cross-phase directive (U2): staff visibility beyond club_owner
  // (managers, coaches, scanners, etc.) had no platform-level summary --
  // a platform owner had to open each club's own Staff page to see it.
  // Counts only, no permission editing -- full staff management stays
  // exactly where it already is.
  // Government / Ministry Collection Compliance directive, section 46:
  // Club 360 shows affiliation status, effective policy, receipt
  // counts, and collected total -- no receipt images (section 45).
  const { data: govCompliance } = useQuery({
    queryKey: ['platform-club-gov-compliance', clubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_platform_government_compliance_summary')
      if (error) throw error
      return (data ?? []).find((row) => row.club_id === clubId) ?? null
    },
    enabled: !!clubId,
  })
  const { data: staffSummary = [] } = useQuery({
    queryKey: ['platform-club-staff-summary', clubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_platform_club_staff_summary', { p_club_id: clubId! })
      if (error) throw error
      return data ?? []
    },
    enabled: !!clubId,
  })
  const { data: access, isError: accessError } = useQuery({
    queryKey: ['platform-club-access', clubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_club_platform_access', { p_club_id: clubId! })
      if (error) throw error
      return data
    },
    enabled: !!clubId,
  })
  const { data: subscriptions = [], isError: subscriptionsError } = useQuery({
    queryKey: ['platform-club-subs', clubId],
    queryFn: () => fetchSubscriptions(clubId!),
    enabled: !!clubId,
  })
  const { data: invoices = [], isError: invoicesError } = useQuery({
    queryKey: ['platform-club-invoices', clubId],
    queryFn: () => fetchInvoices(clubId!),
    enabled: !!clubId,
  })
  const { data: auditRows = [] } = useQuery({
    queryKey: ['platform-club-audit', clubId],
    queryFn: () => fetchClubAudit(clubId!),
    enabled: !!clubId,
  })
  const { data: plans = [] } = useQuery({ queryKey: ['platform-plans-active'], queryFn: fetchPlans })
  const { data: entitlements, isError: entitlementsError } = useQuery({
    queryKey: ['platform-club-entitlements', clubId],
    queryFn: () => fetchEntitlements(clubId!),
    enabled: !!clubId,
  })
  const { data: usage, isError: usageError } = useQuery({
    queryKey: ['platform-club-usage', clubId],
    queryFn: () => fetchUsage(clubId!),
    enabled: !!clubId,
  })
  const { data: upgradeRequests = [] } = useQuery({
    queryKey: ['platform-club-upgrade-requests', clubId],
    queryFn: () => fetchUpgradeRequests(clubId!),
    enabled: !!clubId,
  })

  // PERSONA COUNCIL AUDIT (2026-08-25) -- Platform Owner persona
  // finding: this page runs ~14 independent reads feeding a real,
  // action-dense screen (suspend/reactivate/renew/change-plan/adjust-
  // limits) -- none of them surfaced a read failure to the UI, only
  // mutations did (see actionError below). A transient failure on any
  // of the reads that inform those decisions (identity, operational
  // summary, subscription access, invoices, entitlements/usage) could
  // silently show stale or blank data with no indication anything was
  // wrong, right before a Platform Owner makes a real decision from it.
  // One aggregated banner covering the reads that most directly inform
  // an action here, rather than instrumenting all 14 individually --
  // the lower-stakes reads (audit log, active plans list) keep their
  // existing silent-empty fallback, unchanged.
  const hasReadError = clubError || club360Error || accessError || subscriptionsError || invoicesError || entitlementsError || usageError

  const currentSub = subscriptions.find((s) => s.lifecycle_status !== 'cancelled')
  const pendingRequests = upgradeRequests.filter((r) => r.status === 'pending')

  const limitTypeLabel: Record<string, string> = {
    branch_limit: t('platform.clubDetailPage.limitTypeLabels.branch_limit'),
    field_limit: t('platform.clubDetailPage.limitTypeLabels.field_limit'),
    academy_limit: t('platform.clubDetailPage.limitTypeLabels.academy_limit'),
  }
  const requestStatusLabel: Record<string, string> = {
    pending: t('platform.clubDetailPage.requestStatusLabels.pending'),
    reviewed: t('platform.clubDetailPage.requestStatusLabels.reviewed'),
    approved: t('platform.clubDetailPage.requestStatusLabels.approved'),
    dismissed: t('platform.clubDetailPage.requestStatusLabels.dismissed'),
  }

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ['platform-club-access', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-subs', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-invoices', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-audit', clubId] })
  }

  function invalidateEntitlements() {
    void queryClient.invalidateQueries({ queryKey: ['platform-club-entitlements', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-usage', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-upgrade-requests', clubId] })
  }

  const startTrialMutation = useMutation({
    mutationFn: async (override?: { reason: string }) => {
      const { error } = await supabase.rpc('create_platform_subscription', {
        p_club_id: clubId!,
        p_subscription_kind: 'trial',
        p_trial_origin: 'manual',
        p_force_override: !!override,
        p_override_reason: override?.reason,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setTrialBlockedReason(null)
      setTrialOverrideReason('')
      invalidateAll()
    },
    onError: (err: unknown) => {
      // "trial not eligible" is a real, expected rejection (A2 guard) --
      // surface it distinctly so the platform owner can choose to
      // override with a reason, instead of a generic failure message.
      const message = err instanceof Error ? err.message : ''
      if (message.includes('trial not eligible')) {
        setTrialBlockedReason(message)
      } else {
        setActionError(t('platform.clubDetailPage.errors.startTrial'))
      }
    },
  })

  const activateMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPlanId) throw new Error('no plan selected')
      const { error } = await supabase.rpc('create_platform_subscription', {
        p_club_id: clubId!,
        p_subscription_kind: 'paid',
        p_plan_id: selectedPlanId,
      })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateAll()
      setSelectedPlanId('')
    },
    onError: () => setActionError(t('platform.clubDetailPage.errors.activate')),
  })

  const renewMutation = useMutation({
    mutationFn: async () => {
      if (!currentSub) throw new Error('no current subscription')
      const { error } = await supabase.rpc('renew_platform_subscription', {
        p_previous_subscription_id: currentSub.id,
      })
      if (error) throw error
    },
    onSuccess: invalidateAll,
    onError: () => setActionError(t('platform.clubDetailPage.errors.renew')),
  })

  // Phase D directive (D1): p_reason used to be a hardcoded literal
  // ('plan change via platform console') -- no actual operator input.
  // The RPC itself already accepted a real reason string; this now
  // collects one via the existing reason-dialog pattern.
  const changePlanMutation = useMutation({
    mutationFn: async (reason: string) => {
      if (!currentSub || !selectedPlanId) throw new Error('missing input')
      const { error } = await supabase.rpc('change_platform_plan', {
        p_current_subscription_id: currentSub.id,
        p_new_plan_id: selectedPlanId,
        p_reason: reason,
      })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateAll()
      setReasonDialogAction(null)
      setReasonText('')
      setSelectedPlanId('')
    },
    onError: () => setActionError(t('platform.clubDetailPage.errors.changePlan')),
  })

  // Phase D directive (D2): was a literal 14 with no input field and no
  // reason -- extend_grace_period() itself now requires a reason (see
  // migration 20260819120000). p_grace_period_days SETS the snapshot
  // (not additive), so the dialog shows the resulting end-of-grace date
  // computed from the current subscription's end_at, not just a day count.
  const extendGraceMutation = useMutation({
    mutationFn: async ({ days, reason }: { days: number; reason: string }) => {
      if (!currentSub) throw new Error('no current subscription')
      const { error } = await supabase.rpc('extend_grace_period', {
        p_subscription_id: currentSub.id,
        p_grace_period_days: days,
        p_reason: reason,
      })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateAll()
      setShowGraceDialog(false)
      setGraceReasonText('')
    },
    onError: () => setActionError(t('platform.clubDetailPage.errors.extendGrace')),
  })

  const suspendMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await supabase.rpc('platform_suspend_club', { p_club_id: clubId!, p_reason: reason })
      if (error) throw error
    },
    onSuccess: () => {
      setReasonDialogAction(null)
      setReasonText('')
      void queryClient.invalidateQueries({ queryKey: ['platform-club', clubId] })
    },
    onError: () => setActionError(t('platform.clubDetailPage.errors.suspend')),
  })

  const reactivateMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('platform_reactivate_club', { p_club_id: clubId! })
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-club', clubId] }),
    onError: () => setActionError(t('platform.clubDetailPage.errors.reactivate')),
  })

  const cancelMutation = useMutation({
    mutationFn: async (reason: string) => {
      if (!currentSub) throw new Error('no current subscription')
      const { error } = await supabase.rpc('cancel_platform_subscription', {
        p_subscription_id: currentSub.id,
        p_reason: reason,
      })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateAll()
      setReasonDialogAction(null)
      setReasonText('')
    },
    onError: () => setActionError(t('platform.clubDetailPage.errors.cancel')),
  })

  // Phase D directive (D4/D5): p_method was hardcoded to 'bank_transfer'
  // regardless of how the club actually paid -- record_platform_payment
  // already accepted 'bank_transfer' | 'cash' | 'other', only the caller
  // never let the operator choose. Now collected via a dialog with a
  // real method Select plus an optional reference/note field.
  const recordPaymentMutation = useMutation({
    mutationFn: async ({ invoiceId, method, reference }: { invoiceId: string; method: string; reference: string }) => {
      const invoice = invoices.find((i) => i.id === invoiceId)
      if (!invoice) throw new Error('invoice not found')
      const { error } = await supabase.rpc('record_platform_payment', {
        p_invoice_id: invoiceId,
        p_amount: invoice.amount,
        p_method: method,
        p_reference: reference.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateAll()
      setShowPaymentDialog(false)
      setPaymentMethod('bank_transfer')
      setPaymentReference('')
    },
    onError: () => setActionError(t('platform.clubDetailPage.errors.recordPayment')),
  })

  const reverseMutation = useMutation({
    mutationFn: async ({ paymentId, reason }: { paymentId: string; reason: string }) => {
      const { error } = await supabase.rpc('reverse_platform_payment', { p_payment_id: paymentId, p_reason: reason })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateAll()
      setReasonDialogAction(null)
      setReasonText('')
    },
    onError: () => setActionError(t('platform.clubDetailPage.errors.reversePayment')),
  })

  // PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 3 (P1): the audit's
  // one confirmed unaudited commercial-write path -- this used to be a
  // direct client-side .upsert() with zero audit trail, the single
  // exception to every other commercial RPC on this page. Now routed
  // through set_commercial_entitlements(), which captures a before/
  // after snapshot (including current usage and any over-limit
  // condition the change creates) and writes a real audit_log entry,
  // same discipline as every sibling mutation here. An empty input
  // still clears the limit back to unlimited (null), matching the
  // column's own semantics -- unchanged from before.
  const saveLimitsMutation = useMutation({
    mutationFn: async () => {
      const toLimit = (v: string) => (v.trim() === '' ? null : Number(v))
      const { error } = await supabase.rpc('set_commercial_entitlements', {
        p_club_id: clubId!,
        p_branch_limit: toLimit(branchLimitInput),
        p_field_limit: toLimit(fieldLimitInput),
        p_academy_limit: toLimit(academyLimitInput),
        p_reason: limitReasonInput.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateEntitlements()
      setEditingLimits(false)
      setLimitReasonInput('')
    },
    onError: () => setActionError(t('platform.clubDetailPage.errors.saveLimits')),
  })

  // Directive Section 15/42/§9 of the audit: never silently create an
  // over-limit state -- warn before saving, but never block the save
  // (an operator setting an intentionally tight limit is a legitimate
  // action; existing over-limit branches/fields/programs are always
  // preserved, never deleted, per the RPC's own design).
  const overLimitWarnings = (['branch_limit', 'field_limit', 'academy_limit'] as const)
    .map((key) => {
      const input = key === 'branch_limit' ? branchLimitInput : key === 'field_limit' ? fieldLimitInput : academyLimitInput
      if (input.trim() === '') return null
      const newLimit = Number(input)
      const usedKey = key === 'branch_limit' ? 'branches_used' : key === 'field_limit' ? 'fields_used' : 'academy_used'
      const used = usage?.[usedKey] ?? 0
      if (Number.isFinite(newLimit) && used > newLimit) {
        return t('platform.clubDetailPage.limitsCard.overLimitWarning', { label: limitTypeLabel[key], used, limit: newLimit })
      }
      return null
    })
    .filter((w): w is string => w !== null)

  // PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 5 (P2): the audit's
  // confirmed gap -- no per-club payment kill switch existed
  // independent of full club suspension. Never touches gateway
  // credentials/connections; only gates NEW checkout attempts via
  // start_gateway_checkout()'s own server-side check.
  const setPaymentsEnabledMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const { error } = await supabase.rpc('set_club_payments_enabled', {
        p_club_id: clubId!,
        p_enabled: enabled,
        p_reason: enabled ? 'Re-enabled from Club Detail' : 'Disabled from Club Detail',
      })
      if (error) throw error
    },
    onSuccess: invalidateEntitlements,
    onError: () => setActionError(t('platform.clubDetailPage.errors.setPaymentsEnabled')),
  })

  const resolveUpgradeRequestMutation = useMutation({
    mutationFn: async ({ requestId, status }: { requestId: string; status: 'approved' | 'dismissed' }) => {
      const { data: userData } = await supabase.auth.getUser()
      const { error } = await supabase
        .from('commercial_upgrade_requests')
        .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: userData.user?.id })
        .eq('id', requestId)
      if (error) throw error
    },
    onSuccess: invalidateEntitlements,
    onError: () => setActionError(t('platform.clubDetailPage.errors.updateRequestStatus')),
  })

  const invoiceColumns: DataTableColumn<(typeof invoices)[number]>[] = [
    { key: 'number', header: t('platform.clubDetailPage.invoiceColumns.number'), render: (i) => <bdi>{i.invoice_number}</bdi> },
    { key: 'amount', header: t('platform.clubDetailPage.invoiceColumns.amount'), render: (i) => <MoneyDisplay amount={Number(i.amount)} size="sm" /> },
    { key: 'due', header: t('platform.clubDetailPage.invoiceColumns.due'), render: (i) => new Date(i.due_date).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
    {
      key: 'status',
      header: t('platform.clubDetailPage.invoiceColumns.status'),
      render: (i) => (
        <StatusBadge
          tone={i.status === 'paid' ? 'success' : i.status === 'void' ? 'neutral' : 'warning'}
          label={
            i.status === 'paid'
              ? t('platform.clubDetailPage.invoiceStatusLabels.paid')
              : i.status === 'void'
                ? t('platform.clubDetailPage.invoiceStatusLabels.void')
                : t('platform.clubDetailPage.invoiceStatusLabels.pending')
          }
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (i) => {
        const payments = (i.platform_payments ?? []) as Array<{ id: string; reversed_at: string | null }>
        const activePayment = payments.find((p) => !p.reversed_at)
        if (i.status === 'pending') {
          return (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setPaymentInvoiceId(i.id)
                setPaymentMethod('bank_transfer')
                setPaymentReference('')
                setShowPaymentDialog(true)
              }}
            >
              {t('platform.clubDetailPage.recordPayment')}
            </Button>
          )
        }
        if (i.status === 'paid' && activePayment) {
          return (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setReasonDialogAction('reverse')
                setReasonTarget(activePayment.id)
              }}
            >
              {t('platform.clubDetailPage.reversePayment')}
            </Button>
          )
        }
        return null
      },
    },
  ]

  return (
    <div>
      <PageHeader
        title={club?.name_ar ?? t('platform.clubDetailPage.loadingTitle')}
        description={club?.club_code ? <bdi>{club.club_code}</bdi> : undefined}
        actions={
          club && (
            <StatusBadge
              tone={club.status === 'active' ? 'success' : 'danger'}
              label={club.status === 'active' ? t('platform.clubDetailPage.clubStatusActive') : t('platform.clubDetailPage.clubStatusSuspended')}
            />
          )
        }
      />

      {hasReadError && (
        <ErrorState
          message={t('platform.clubDetailPage.loadError', { defaultValue: 'Some of this club\'s data failed to load. Numbers or status shown below may be stale or missing -- refresh before making a decision.' })}
          className="mb-3"
        />
      )}

      {actionError && (
        <p role="alert" className="mb-3 text-sm text-status-danger">
          {actionError}
        </p>
      )}

      {/* Phase C directive (C1/C2/C6/C7): Club Identity + Owner Contact +
          a facilities/booking/customer summary -- the specific data the
          audit found completely absent from this page despite fetching
          (but never rendering) most of the club row already. Summary
          only, deliberately -- not a platform booking-operations system. */}
      <div className="mb-4 grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('platform.clubDetailPage.identityCard.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 text-sm">
            {/* FINAL PRODUCT COMPLETENESS ROUND (2026-08-25) -- Platform
                Owner persona: club.flagged_duplicate/flagged_duplicate_
                reason were already fetched via this page's own
                select('*') and never rendered -- surfacing the exact
                reason here alongside the suspend action already in this
                page's Actions panel is the real accept/reject mechanism
                for a signup the Overview exception card flagged. */}
            {club?.flagged_duplicate && (
              <p className="rounded-md bg-status-warning/10 px-2 py-1.5 text-status-warning">
                {club.flagged_duplicate_reason ?? t('platform.clubDetailPage.identityCard.flaggedDuplicate')}
              </p>
            )}
            <div className="flex justify-between"><span className="text-text-secondary">{t('platform.clubDetailPage.identityCard.createdAt')}</span><bdi>{club ? new Date(club.created_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') : '—'}</bdi></div>
            <div className="flex justify-between">
              <span className="text-text-secondary">{t('platform.clubDetailPage.identityCard.phone')}</span>
              {club?.primary_phone ? (
                <a href={`tel:${club.primary_phone}`} className="text-accent-foreground hover:underline"><bdi>{club.primary_phone}</bdi></a>
              ) : (
                <span>—</span>
              )}
            </div>
            <div className="flex justify-between"><span className="text-text-secondary">{t('platform.clubDetailPage.identityCard.email')}</span><span>{club?.contact_email ?? '—'}</span></div>
            {club?.public_slug && (
              <div className="flex justify-between">
                <span className="text-text-secondary">{t('platform.clubDetailPage.identityCard.publicBooking')}</span>
                <a href={`/c/${club.public_slug}`} target="_blank" rel="noreferrer" className="text-accent-foreground hover:underline">
                  /c/{club.public_slug}
                </a>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('platform.clubDetailPage.ownerCard.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1.5 text-sm">
            {club360?.owner_name ? (
              <>
                <p className="font-medium text-text-primary">{club360.owner_name}</p>
                {club360.owner_email && (
                  <div className="flex items-center gap-2">
                    <a href={`mailto:${club360.owner_email}`} className="text-accent-foreground hover:underline">{club360.owner_email}</a>
                    <button
                      type="button"
                      className="text-xs text-text-secondary hover:text-text-primary"
                      onClick={() => void navigator.clipboard?.writeText(club360.owner_email!)}
                      title={t('platform.clubDetailPage.ownerCard.copy')}
                    >
                      {t('platform.clubDetailPage.ownerCard.copy')}
                    </button>
                  </div>
                )}
                {club360.owner_phone && (
                  <div className="flex items-center gap-2">
                    <a href={`tel:${club360.owner_phone}`} className="text-accent-foreground hover:underline"><bdi>{club360.owner_phone}</bdi></a>
                    <button
                      type="button"
                      className="text-xs text-text-secondary hover:text-text-primary"
                      onClick={() => void navigator.clipboard?.writeText(club360.owner_phone!)}
                      title={t('platform.clubDetailPage.ownerCard.copy')}
                    >
                      {t('platform.clubDetailPage.ownerCard.copy')}
                    </button>
                  </div>
                )}
                <Link
                  to="/platform/owners"
                  className="mt-1 text-xs text-accent-foreground hover:underline"
                >
                  {t('platform.clubDetailPage.ownerCard.openOwners')}
                </Link>
              </>
            ) : (
              <p className="text-text-secondary">{t('platform.clubDetailPage.ownerCard.noOwner')}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('platform.clubDetailPage.summaryCard.title')}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-2 text-sm tabular-nums">
            <div><span className="text-text-secondary">{t('platform.clubDetailPage.summaryCard.branches')}</span> <span className="font-medium">{club360?.branch_count ?? '—'}</span></div>
            <div><span className="text-text-secondary">{t('platform.clubDetailPage.summaryCard.fields')}</span> <span className="font-medium">{club360?.field_count ?? '—'}</span></div>
            <div><span className="text-text-secondary">{t('platform.clubDetailPage.summaryCard.customers')}</span> <span className="font-medium">{club360?.customer_count ?? '—'}</span></div>
            <div><span className="text-text-secondary">{t('platform.clubDetailPage.summaryCard.bookingsToday')}</span> <span className="font-medium">{club360?.bookings_today ?? '—'}</span></div>
            <div><span className="text-text-secondary">{t('platform.clubDetailPage.summaryCard.bookingsMonth')}</span> <span className="font-medium">{club360?.bookings_this_month ?? '—'}</span></div>
            <div><span className="text-text-secondary">{t('platform.clubDetailPage.summaryCard.bookingsPending')}</span> <span className="font-medium">{club360?.bookings_pending ?? '—'}</span></div>
            {staffSummary.length > 0 && (
              <div className="col-span-2 border-t border-border pt-2">
                <span className="text-text-secondary">{t('platform.clubDetailPage.summaryCard.staff')}</span>{' '}
                <span className="font-medium">
                  {staffSummary.map((s) => `${s.role_name} (${s.member_count})`).join(' · ')}
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Phase E directive (C8/E4): operational health only -- connection
          state, masked phone (last 4 digits), failure/queue counts.
          Never message content, per the directive's explicit privacy
          requirement (respect tenant privacy -- no customer conversation
          content). */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">{t('platform.clubDetailPage.whatsappCard.title')}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div>
            <p className="text-text-secondary">{t('platform.clubDetailPage.whatsappCard.status')}</p>
            <StatusBadge
              tone={whatsappHealthRow?.connection_status === 'connected' ? 'success' : whatsappHealthRow?.connection_status === 'not_connected' ? 'neutral' : 'danger'}
              label={t(`platform.clubDetailPage.whatsappCard.statusLabels.${whatsappHealthRow?.connection_status ?? 'not_connected'}`, { defaultValue: whatsappHealthRow?.connection_status ?? '—' })}
            />
          </div>
          <div>
            <p className="text-text-secondary">{t('platform.clubDetailPage.whatsappCard.number')}</p>
            <bdi>{whatsappHealthRow?.connected_phone_masked ?? '—'}</bdi>
          </div>
          <div>
            <p className="text-text-secondary">{t('platform.clubDetailPage.whatsappCard.failures7d')}</p>
            <p className="font-medium tabular-nums">{whatsappHealthRow?.failed_count_7d ?? 0}</p>
          </div>
          <div>
            <p className="text-text-secondary">{t('platform.clubDetailPage.whatsappCard.pending')}</p>
            <p className="font-medium tabular-nums">{whatsappHealthRow?.pending_count ?? 0}</p>
          </div>
        </CardContent>
      </Card>

      {/* Government / Ministry Collection Compliance directive, section
          46: affiliation status, effective policy, receipt counts,
          collected total. No receipt images shown (section 45). Only
          rendered when the club is actually affiliated -- an ordinary
          commercial club's Club 360 stays unchanged. */}
      {govCompliance?.enabled && (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">{t('platform.clubDetailPage.govComplianceCard.title')}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
            <div>
              <p className="text-text-secondary">{t('platform.clubDetailPage.govComplianceCard.authorityType')}</p>
              <p className="font-medium">
                {govCompliance.authority_type ? t(`governmentCompliance.authorityTypes.${govCompliance.authority_type}`) : '—'}
              </p>
            </div>
            <div>
              <p className="text-text-secondary">{t('platform.clubDetailPage.govComplianceCard.receiptRequired')}</p>
              <p className="font-medium">{govCompliance.official_receipt_required ? t('governmentCompliance.yes') : t('governmentCompliance.no')}</p>
            </div>
            <div>
              <p className="text-text-secondary">{t('platform.clubDetailPage.govComplianceCard.receiptCounts')}</p>
              <p className="font-medium tabular-nums">
                {govCompliance.active_receipt_count} / {govCompliance.reversed_receipt_count}
              </p>
            </div>
            <div>
              <p className="text-text-secondary">{t('platform.clubDetailPage.govComplianceCard.totalCollected')}</p>
              <MoneyDisplay amount={Number(govCompliance.total_collected)} size="sm" />
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mb-4 grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('platform.clubDetailPage.subscriptionStatusCard.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <StatusBadge
              tone={ACCESS_TONE[access ?? 'blocked'] ?? 'danger'}
              label={t(`platform.ownersPage.accessLabels.${access ?? 'blocked'}`, {
                defaultValue: ACCESS_LABEL[access ?? 'blocked'] ?? t('platform.clubDetailPage.clubStatusSuspended'),
              })}
            />
            {currentSub && (
              <>
                <p>
                  {t('platform.clubDetailPage.subscriptionStatusCard.type', {
                    type: t(`platform.ownersPage.subscriptionKindLabels.${currentSub.subscription_kind}`, {
                      defaultValue: SUBSCRIPTION_KIND_LABELS[currentSub.subscription_kind] ?? currentSub.subscription_kind,
                    }),
                  })}
                </p>
                <p>
                  {t('platform.clubDetailPage.subscriptionStatusCard.endsAtPrefix')} <bdi>{new Date(currentSub.end_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi>
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">{t('platform.clubDetailPage.actionsCard.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {!currentSub && (
              <>
                <div className="flex flex-col gap-2">
                  <Button size="sm" onClick={() => startTrialMutation.mutate(undefined)} disabled={startTrialMutation.isPending}>
                    {t('platform.clubDetailPage.actionsCard.startTrial')}
                  </Button>
                  {/* Phase A directive (A2): create_platform_subscription
                      now enforces a real per-owner trial-eligibility check.
                      If it rejects, show why and require a typed reason to
                      override -- never a silent bypass. */}
                  {trialBlockedReason && (
                    <div className="flex max-w-sm flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
                      <p className="text-xs text-text-secondary">{trialBlockedReason}</p>
                      <Input
                        placeholder={t('platform.clubDetailPage.actionsCard.trialOverrideReasonPlaceholder')}
                        value={trialOverrideReason}
                        onChange={(e) => setTrialOverrideReason(e.target.value)}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!trialOverrideReason.trim() || startTrialMutation.isPending}
                        onClick={() => startTrialMutation.mutate({ reason: trialOverrideReason.trim() })}
                      >
                        {t('platform.clubDetailPage.actionsCard.forceTrialOverride')}
                      </Button>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
                    <SelectTrigger className="w-40"><SelectValue placeholder={t('platform.clubDetailPage.actionsCard.choosePlanPlaceholder')} /></SelectTrigger>
                    <SelectContent>
                      {plans.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name_ar}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" onClick={() => activateMutation.mutate()} disabled={activateMutation.isPending}>
                    {t('platform.clubDetailPage.actionsCard.activate')}
                  </Button>
                </div>
              </>
            )}
            {currentSub && (
              <>
                <Button size="sm" variant="outline" onClick={() => renewMutation.mutate()} disabled={renewMutation.isPending}>
                  {t('platform.clubDetailPage.actionsCard.renew')}
                </Button>
                <div className="flex items-center gap-2">
                  <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
                    <SelectTrigger className="w-40"><SelectValue placeholder={t('platform.clubDetailPage.actionsCard.newPlanPlaceholder')} /></SelectTrigger>
                    <SelectContent>
                      {plans.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name_ar}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!selectedPlanId || changePlanMutation.isPending}
                    onClick={() => {
                      setReasonDialogAction('changePlan')
                      setReasonTarget(currentSub.id)
                    }}
                  >
                    {t('platform.clubDetailPage.actionsCard.changePlan')}
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setGraceDaysInput(String(currentSub.grace_period_days_snapshot ?? 0))
                    setGraceReasonText('')
                    setShowGraceDialog(true)
                  }}
                >
                  {t('platform.clubDetailPage.actionsCard.extendGrace')}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setReasonDialogAction('cancel')
                    setReasonTarget(currentSub.id)
                  }}
                >
                  {t('platform.clubDetailPage.actionsCard.cancelSubscription')}
                </Button>
              </>
            )}
            {club?.status === 'active' ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setReasonDialogAction('suspend')
                  setReasonTarget(clubId ?? null)
                }}
                disabled={suspendMutation.isPending}
              >
                {t('platform.clubDetailPage.actionsCard.suspendClub')}
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => reactivateMutation.mutate()} disabled={reactivateMutation.isPending}>
                {t('platform.clubDetailPage.actionsCard.reactivateClub')}
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">{t('platform.clubDetailPage.limitsCard.title')}</CardTitle>
          {!editingLimits && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setBranchLimitInput(entitlements?.branch_limit?.toString() ?? '')
                setFieldLimitInput(entitlements?.field_limit?.toString() ?? '')
                setAcademyLimitInput(entitlements?.academy_limit?.toString() ?? '')
                setEditingLimits(true)
              }}
            >
              {t('platform.clubDetailPage.limitsCard.editLimits')}
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {editingLimits ? (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-text-secondary">{t('platform.clubDetailPage.limitsCard.emptyFieldHint')}</p>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">{t('platform.clubDetailPage.limitsCard.branchLimitLabel')}</label>
                  <Input type="number" min="0" value={branchLimitInput} onChange={(e) => setBranchLimitInput(e.target.value)} placeholder={t('platform.clubDetailPage.limitsCard.unlimitedPlaceholder')} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">{t('platform.clubDetailPage.limitsCard.fieldLimitLabel')}</label>
                  <Input type="number" min="0" value={fieldLimitInput} onChange={(e) => setFieldLimitInput(e.target.value)} placeholder={t('platform.clubDetailPage.limitsCard.unlimitedPlaceholder')} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">{t('platform.clubDetailPage.limitsCard.academyLimitLabel')}</label>
                  <Input type="number" min="0" value={academyLimitInput} onChange={(e) => setAcademyLimitInput(e.target.value)} placeholder={t('platform.clubDetailPage.limitsCard.unlimitedPlaceholder')} />
                </div>
              </div>
              {overLimitWarnings.length > 0 && (
                <div className="flex flex-col gap-1 rounded-md border border-status-warning/40 bg-status-warning/10 p-3 text-sm text-status-warning" data-testid="limits-over-limit-warning">
                  {overLimitWarnings.map((w) => (
                    <p key={w}>{w}</p>
                  ))}
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('platform.clubDetailPage.limitsCard.reasonLabel')}</label>
                <Input value={limitReasonInput} onChange={(e) => setLimitReasonInput(e.target.value)} placeholder={t('platform.clubDetailPage.reasonDialog.reasonPlaceholder')} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => saveLimitsMutation.mutate()} disabled={saveLimitsMutation.isPending}>
                  {saveLimitsMutation.isPending ? t('platform.clubDetailPage.limitsCard.saving') : t('platform.clubDetailPage.limitsCard.saveLimits')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => { setEditingLimits(false); setLimitReasonInput('') }}>{t('platform.clubDetailPage.limitsCard.cancel')}</Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              {(['branch_limit', 'field_limit', 'academy_limit'] as const).map((key) => {
                const usedKey = key === 'branch_limit' ? 'branches_used' : key === 'field_limit' ? 'fields_used' : 'academy_used'
                const limit = usage?.[key] ?? null
                const used = usage?.[usedKey] ?? 0
                // PLATFORM OWNER AUTONOMOUS COMPLETION -- Phase D
                // (2026-08-29): live-triggered with a real fixture
                // (1 QA branch + branch_limit=0 set via this exact
                // UI) -- confirmed the persistent display card had no
                // visual indicator at all once an over-limit state was
                // actually saved (only the pre-save warning inside the
                // edit form existed). The RPC/trigger side already does
                // the right thing (preserves existing records, blocks
                // new ones) -- this was purely a "clear warning" gap
                // per the directive's own §14 wording.
                const isOverLimit = limit !== null && used > limit
                return (
                  <div
                    key={key}
                    className={cn(
                      'rounded-lg border p-3',
                      isOverLimit ? 'border-status-danger/40 bg-status-danger/5' : 'border-border'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">{limitTypeLabel[key]}</p>
                      {isOverLimit && (
                        <StatusBadge tone="danger" label={t('platform.clubDetailPage.limitsCard.overLimitBadge')} />
                      )}
                    </div>
                    <p className="text-sm text-text-secondary tabular-nums">{used} {limit === null ? t('platform.clubDetailPage.limitsCard.unlimited') : `/ ${limit}`}</p>
                    {isOverLimit && (
                      <p className="mt-1 text-xs text-status-danger">{t('platform.clubDetailPage.limitsCard.overLimitHint')}</p>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {pendingRequests.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3">
              <p className="text-sm font-medium text-status-warning">{t('platform.clubDetailPage.limitsCard.pendingRequestsHeading', { count: pendingRequests.length })}</p>
              {pendingRequests.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface p-2 text-sm">
                  <span>
                    {t('platform.clubDetailPage.limitsCard.requestSummary', {
                      label: limitTypeLabel[r.limit_type] ?? r.limit_type,
                      limit: r.current_limit ?? t('platform.clubDetailPage.limitsCard.requestUnlimited'),
                      usage: r.current_usage,
                    })}
                    {r.note && <span className="text-text-secondary"> — {r.note}</span>}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => resolveUpgradeRequestMutation.mutate({ requestId: r.id, status: 'approved' })}
                      disabled={resolveUpgradeRequestMutation.isPending}
                    >
                      {t('platform.clubDetailPage.limitsCard.approve')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resolveUpgradeRequestMutation.mutate({ requestId: r.id, status: 'dismissed' })}
                      disabled={resolveUpgradeRequestMutation.isPending}
                    >
                      {t('platform.clubDetailPage.limitsCard.reject')}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 5 (P2): payment
          kill switch. AUTONOMOUS COMPLETION -- Phase A: the
          provider-allowlist UI this comment used to say was deferred to
          "a future dedicated screen" is now built directly below, in
          the same card, as ProviderPolicyPanel -- the RPC
          (set_club_gateway_provider_policy) has been live since Phase
          5; this closes the confirmed UI gap. */}
      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">{t('platform.clubDetailPage.paymentsCard.title')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <StatusBadge
                tone={entitlements?.payments_platform_disabled ? 'danger' : 'success'}
                label={entitlements?.payments_platform_disabled ? t('platform.clubDetailPage.paymentsCard.disabled') : t('platform.clubDetailPage.paymentsCard.enabled')}
              />
              <p className="mt-1 text-xs text-text-secondary">{t('platform.clubDetailPage.paymentsCard.hint')}</p>
            </div>
            <Button
              size="sm"
              variant={entitlements?.payments_platform_disabled ? 'default' : 'destructive'}
              disabled={setPaymentsEnabledMutation.isPending}
              onClick={() => setPaymentsEnabledMutation.mutate(!!entitlements?.payments_platform_disabled)}
            >
              {entitlements?.payments_platform_disabled ? t('platform.clubDetailPage.paymentsCard.enable') : t('platform.clubDetailPage.paymentsCard.disable')}
            </Button>
          </div>
          {clubId && (
            <div className="border-t border-border pt-4">
              <p className="mb-2 text-sm font-medium">{t('platform.clubDetailPage.providerPolicy.title')}</p>
              <p className="mb-3 text-xs text-text-secondary">{t('platform.clubDetailPage.providerPolicy.hint')}</p>
              <ProviderPolicyPanel clubId={clubId} />
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="history">
        <TabsList>
          <TabsTrigger value="history">{t('platform.clubDetailPage.tabs.history')}</TabsTrigger>
          <TabsTrigger value="invoices">{t('platform.clubDetailPage.tabs.invoices')}</TabsTrigger>
          <TabsTrigger value="requests">{t('platform.clubDetailPage.tabs.requests')}</TabsTrigger>
          <TabsTrigger value="audit">{t('platform.clubDetailPage.tabs.audit')}</TabsTrigger>
          {/* COMMERCIAL MODULE ARCHITECTURE (2026-08-26) -- directive
              Section 76/123: Platform Owner needs a real UI to control
              per-club module entitlement (Fields/Academy/Shop), not just
              the RPC. A new tab here, not a separate route -- this
              screen is already the single "everything about this club"
              surface (this file's own header comment). */}
          <TabsTrigger value="modules">{t('platform.clubDetailPage.tabs.modules')}</TabsTrigger>
        </TabsList>
        <TabsContent value="history">
          <DataTable
            columns={[
              { key: 'kind', header: t('platform.clubDetailPage.historyColumns.kind'), render: (s: (typeof subscriptions)[number]) => t(`platform.ownersPage.subscriptionKindLabels.${s.subscription_kind}`, { defaultValue: SUBSCRIPTION_KIND_LABELS[s.subscription_kind] ?? s.subscription_kind }) },
              { key: 'plan', header: t('platform.clubDetailPage.historyColumns.plan'), render: (s: (typeof subscriptions)[number]) => s.plan_name_snapshot ?? '—' },
              { key: 'start', header: t('platform.clubDetailPage.historyColumns.start'), render: (s: (typeof subscriptions)[number]) => new Date(s.start_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
              { key: 'end', header: t('platform.clubDetailPage.historyColumns.end'), render: (s: (typeof subscriptions)[number]) => new Date(s.end_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
              { key: 'status', header: t('platform.clubDetailPage.historyColumns.status'), render: (s: (typeof subscriptions)[number]) => t(`platform.reportsPage.lifecycleStatusLabels.${s.lifecycle_status}`, { defaultValue: LIFECYCLE_STATUS_LABELS[s.lifecycle_status] ?? s.lifecycle_status }) },
            ]}
            rows={subscriptions}
            rowKey={(s) => s.id}
            emptyTitle={t('platform.clubDetailPage.historyEmptyTitle')}
          />
        </TabsContent>
        <TabsContent value="invoices">
          <DataTable columns={invoiceColumns} rows={invoices} rowKey={(i) => i.id} emptyTitle={t('platform.clubDetailPage.invoicesEmptyTitle')} />
        </TabsContent>
        <TabsContent value="requests">
          <DataTable
            columns={[
              { key: 'type', header: t('platform.clubDetailPage.requestsColumns.type'), render: (r: (typeof upgradeRequests)[number]) => limitTypeLabel[r.limit_type] ?? r.limit_type },
              { key: 'limit', header: t('platform.clubDetailPage.requestsColumns.limitAtRequest'), render: (r: (typeof upgradeRequests)[number]) => r.current_limit ?? t('platform.clubDetailPage.limitsCard.requestUnlimited') },
              { key: 'usage', header: t('platform.clubDetailPage.requestsColumns.usageAtRequest'), render: (r: (typeof upgradeRequests)[number]) => r.current_usage },
              { key: 'note', header: t('platform.clubDetailPage.requestsColumns.note'), render: (r: (typeof upgradeRequests)[number]) => r.note ?? '—' },
              { key: 'created', header: t('platform.clubDetailPage.requestsColumns.createdAt'), render: (r: (typeof upgradeRequests)[number]) => new Date(r.created_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
              {
                key: 'status',
                header: t('platform.clubDetailPage.requestsColumns.status'),
                render: (r: (typeof upgradeRequests)[number]) => (
                  <StatusBadge
                    tone={REQUEST_STATUS_TONE[r.status] ?? 'neutral'}
                    label={requestStatusLabel[r.status] ?? r.status}
                  />
                ),
              },
            ]}
            rows={upgradeRequests}
            rowKey={(r) => r.id}
            emptyTitle={t('platform.clubDetailPage.requestsEmptyTitle')}
          />
        </TabsContent>
        <TabsContent value="audit">
          <DataTable
            columns={[
              { key: 'action', header: t('platform.clubDetailPage.auditColumns.action'), render: (a: (typeof auditRows)[number]) => actionLabel(a.action, locale) },
              { key: 'entity', header: t('platform.clubDetailPage.auditColumns.entity'), render: (a: (typeof auditRows)[number]) => entityLabel(a.entity_type, locale) },
              { key: 'time', header: t('platform.clubDetailPage.auditColumns.time'), render: (a: (typeof auditRows)[number]) => new Date(a.created_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG') },
              { key: 'reason', header: t('platform.clubDetailPage.auditColumns.reason'), render: (a: (typeof auditRows)[number]) => a.reason ?? '—' },
            ]}
            rows={auditRows}
            rowKey={(a) => a.id}
            emptyTitle={t('platform.clubDetailPage.auditEmptyTitle')}
          />
        </TabsContent>
        <TabsContent value="modules">
          {clubId && <ModulesPanel clubId={clubId} subscriptionAccess={access ?? null} />}
        </TabsContent>
      </Tabs>

      <Dialog open={reasonDialogAction !== null} onOpenChange={(open) => !open && setReasonDialogAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reasonDialogAction === 'cancel'
                ? t('platform.clubDetailPage.reasonDialog.cancelTitle')
                : reasonDialogAction === 'suspend'
                  ? t('platform.clubDetailPage.reasonDialog.suspendTitle')
                  : reasonDialogAction === 'changePlan'
                    ? t('platform.clubDetailPage.reasonDialog.changePlanTitle')
                    : t('platform.clubDetailPage.reasonDialog.reverseTitle')}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {reasonDialogAction === 'suspend' && (
              <p className="text-sm text-status-danger">
                {t('platform.clubDetailPage.reasonDialog.suspendWarning')}
              </p>
            )}
            {reasonDialogAction === 'changePlan' && currentSub && (
              <p className="text-sm text-text-secondary">
                {t('platform.clubDetailPage.reasonDialog.changePlanSummary', {
                  from: currentSub.plan_name_snapshot ?? '—',
                  to: plans.find((p) => p.id === selectedPlanId)?.name_ar ?? '—',
                })}
              </p>
            )}
            <Input value={reasonText} onChange={(e) => setReasonText(e.target.value)} placeholder={t('platform.clubDetailPage.reasonDialog.reasonPlaceholder')} />
            <Button
              variant={reasonDialogAction === 'suspend' ? 'destructive' : 'default'}
              disabled={!reasonText.trim() || cancelMutation.isPending || reverseMutation.isPending || suspendMutation.isPending || changePlanMutation.isPending}
              onClick={() => {
                if (!reasonTarget) return
                if (reasonDialogAction === 'cancel') cancelMutation.mutate(reasonText)
                else if (reasonDialogAction === 'suspend') suspendMutation.mutate(reasonText)
                else if (reasonDialogAction === 'changePlan') changePlanMutation.mutate(reasonText)
                else reverseMutation.mutate({ paymentId: reasonTarget, reason: reasonText })
              }}
            >
              {reasonDialogAction === 'suspend' ? t('platform.clubDetailPage.reasonDialog.confirmSuspend') : t('platform.clubDetailPage.reasonDialog.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Phase D directive (D2): extend_grace_period sets the grace
          snapshot (not additive) and now requires a reason -- this
          dialog shows the resulting grace-end date computed from the
          current subscription so the operator sees the actual effect,
          not just a day count. */}
      <Dialog open={showGraceDialog} onOpenChange={setShowGraceDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('platform.clubDetailPage.graceDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('platform.clubDetailPage.graceDialog.daysLabel')}</label>
              <Input type="number" min="0" value={graceDaysInput} onChange={(e) => setGraceDaysInput(e.target.value)} />
            </div>
            {currentSub && graceDaysInput.trim() !== '' && !Number.isNaN(Number(graceDaysInput)) && (
              <p className="text-sm text-text-secondary">
                {t('platform.clubDetailPage.graceDialog.resultingDate', {
                  date: new Date(new Date(currentSub.end_at).getTime() + Number(graceDaysInput) * 86400000).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG'),
                })}
              </p>
            )}
            <Input value={graceReasonText} onChange={(e) => setGraceReasonText(e.target.value)} placeholder={t('platform.clubDetailPage.reasonDialog.reasonPlaceholder')} />
            <Button
              disabled={!graceReasonText.trim() || graceDaysInput.trim() === '' || Number.isNaN(Number(graceDaysInput)) || Number(graceDaysInput) < 0 || extendGraceMutation.isPending}
              onClick={() => extendGraceMutation.mutate({ days: Number(graceDaysInput), reason: graceReasonText.trim() })}
            >
              {t('platform.clubDetailPage.graceDialog.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Phase D directive (D4/D5): payment method used to be hardcoded
          to bank_transfer regardless of how the club actually paid --
          real method selection plus an optional reference/note field. */}
      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('platform.clubDetailPage.paymentDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('platform.clubDetailPage.paymentDialog.methodLabel')}</label>
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank_transfer">{t('platform.clubDetailPage.paymentDialog.methods.bank_transfer')}</SelectItem>
                  <SelectItem value="cash">{t('platform.clubDetailPage.paymentDialog.methods.cash')}</SelectItem>
                  <SelectItem value="other">{t('platform.clubDetailPage.paymentDialog.methods.other')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">{t('platform.clubDetailPage.paymentDialog.referenceLabel')}</label>
              <Input value={paymentReference} onChange={(e) => setPaymentReference(e.target.value)} placeholder={t('platform.clubDetailPage.paymentDialog.referencePlaceholder')} />
            </div>
            <Button
              disabled={!paymentInvoiceId || recordPaymentMutation.isPending}
              onClick={() => {
                if (!paymentInvoiceId) return
                recordPaymentMutation.mutate({ invoiceId: paymentInvoiceId, method: paymentMethod, reference: paymentReference })
              }}
            >
              {t('platform.clubDetailPage.paymentDialog.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// COMMERCIAL MODULE ARCHITECTURE (2026-08-26) -- Platform Owner's real
// module-entitlement UI (directive Section 76/2/123). Deliberately
// shows only "Entitled" (platform-controlled, what this panel writes)
// -- never a raw "Active" toggle here -- "Active" is the CLUB OWNER'S
// own decision (ShopSettingsPage/RequireShopModule), a genuinely
// separate concern per the two-level model
// (COMMERCIAL_DOMAIN_ARCHITECTURE.md Section 3). Showing Active
// read-only here (not editable) keeps that boundary honest instead of
// letting a platform admin silently flip a club's own operational
// on/off switch.
interface ModuleRow {
  moduleKey: string
  entitled: boolean
  active: boolean
  updatedAt: string | null
}

// PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 2: club_membership
// registered as a 4th real module (see migration
// 20260828210000_club_membership_module_registration.sql) -- the same
// Modules tab this constant already feeds now shows it automatically,
// no new tab/section needed (Club 360 UX guidance: extend, don't
// fragment).
const MODULE_LABELS: Record<string, string> = {
  fields: 'platform.clubDetailPage.modules.fields',
  academy: 'platform.clubDetailPage.modules.academy',
  shop: 'platform.clubDetailPage.modules.shop',
  club_membership: 'platform.clubDetailPage.modules.clubMembership',
}

async function fetchModules(clubId: string): Promise<ModuleRow[]> {
  const { data, error } = await supabase.rpc('get_club_modules', { p_club_id: clubId })
  if (error) throw error
  // SHOP MODULE UX HARDENING (2026-08-28) -- directive Section 11 asks
  // "when was entitlement changed if such audit data exists". It does:
  // club_modules.updated_at, already returned by this RPC but silently
  // dropped by this mapping before now.
  return (data ?? []).map((r) => ({ moduleKey: r.module_key, entitled: r.entitled, active: r.active, updatedAt: r.updated_at ?? null }))
}

// PLATFORM OWNER MODULE ACTIVATION CONTROL -- finite corrective phase
// (2026-08-29). Prior state: Platform Owner could only toggle
// ENTITLEMENT here -- OPERATIONAL ACTIVATION (`active`) required a
// Club Owner login or a support session, which is no longer the
// intended product behavior (a Platform Owner who re-entitles a module
// they just disabled could not themselves finish restoring it).
// set_club_module_active() now also accepts is_platform_owner() /
// platform.club.manage, symmetric with set_club_module_entitlement()'s
// existing authority -- see migration
// 20260829030000_platform_owner_module_activation_authority.sql.
//
// EFFECTIVE STATE is computed here, not stored -- it's a pure function
// of three already-loaded facts (entitled, active, and the club's own
// subscription access), matching this page's existing pattern of
// deriving display state rather than adding new persisted columns:
//   - not entitled            -> NOT_AVAILABLE (nothing else matters)
//   - entitled, subscription blocked -> BLOCKED_BY_SUBSCRIPTION (matches
//     club_write_allowed()'s own real gate -- a Platform-Owner-active
//     module is still unusable if the club's subscription itself blocks
//     writes, and hiding that behind a plain "Active" badge would be
//     misleading)
//   - entitled, not active    -> INACTIVE
//   - entitled, active, subscription not blocked -> ACTIVE
type ModuleEffectiveState = 'active' | 'inactive' | 'not_entitled' | 'blocked_by_subscription'

function computeEffectiveState(m: ModuleRow, subscriptionAccess: string | null): ModuleEffectiveState {
  if (!m.entitled) return 'not_entitled'
  if (subscriptionAccess === 'blocked') return 'blocked_by_subscription'
  if (!m.active) return 'inactive'
  return 'active'
}

const EFFECTIVE_STATE_TONE: Record<ModuleEffectiveState, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  inactive: 'warning',
  not_entitled: 'neutral',
  blocked_by_subscription: 'danger',
}

function ModulesPanel({ clubId, subscriptionAccess }: { clubId: string; subscriptionAccess: string | null }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [deactivateTarget, setDeactivateTarget] = useState<{ moduleKey: string; reason: string } | null>(null)

  const { data: modules = [], isLoading } = useQuery({
    queryKey: ['platform-club-modules', clubId],
    queryFn: () => fetchModules(clubId),
  })

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['platform-club-modules', clubId] })

  const entitlementMutation = useMutation({
    mutationFn: async ({ moduleKey, entitled }: { moduleKey: string; entitled: boolean }) => {
      const { error } = await supabase.rpc('set_club_module_entitlement', { p_club_id: clubId, p_module_key: moduleKey, p_entitled: entitled })
      if (error) throw error
    },
    onSuccess: invalidate,
  })

  const activationMutation = useMutation({
    mutationFn: async ({ moduleKey, active, reason }: { moduleKey: string; active: boolean; reason?: string }) => {
      const { error } = await supabase.rpc('set_club_module_active', {
        p_club_id: clubId,
        p_module_key: moduleKey,
        p_active: active,
        p_reason: reason?.trim() || (active ? t('platform.clubDetailPage.modulesActivateDefaultReason') : t('platform.clubDetailPage.modulesDeactivateDefaultReason')),
      })
      if (error) throw error
    },
    onSuccess: () => {
      invalidate()
      setDeactivateTarget(null)
    },
  })

  if (isLoading) return null

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-text-secondary">{t('platform.clubDetailPage.modulesHint')}</p>
      {modules.map((m) => {
        const effective = computeEffectiveState(m, subscriptionAccess)
        return (
          <div key={m.moduleKey} className="flex flex-col gap-3 rounded-md border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="font-medium">{t(MODULE_LABELS[m.moduleKey] ?? m.moduleKey)}</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <StatusBadge tone={m.entitled ? 'success' : 'neutral'} label={m.entitled ? t('platform.clubDetailPage.modulesEntitled') : t('platform.clubDetailPage.modulesNotEntitled')} />
                {m.entitled && (
                  <StatusBadge tone={m.active ? 'success' : 'warning'} label={m.active ? t('platform.clubDetailPage.modulesActive') : t('platform.clubDetailPage.modulesNotActivated')} />
                )}
                <StatusBadge tone={EFFECTIVE_STATE_TONE[effective]} label={t(`platform.clubDetailPage.modulesEffectiveState.${effective}`)} />
              </div>
              {m.updatedAt && (
                <p className="mt-1 text-xs text-text-secondary">
                  {t('platform.clubDetailPage.modulesLastChanged', { date: new Date(m.updatedAt).toLocaleString() })}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant={m.entitled ? 'outline' : 'default'}
                size="sm"
                disabled={entitlementMutation.isPending}
                onClick={() => entitlementMutation.mutate({ moduleKey: m.moduleKey, entitled: !m.entitled })}
              >
                {m.entitled ? t('platform.clubDetailPage.modulesDisable') : t('platform.clubDetailPage.modulesEnable')}
              </Button>
              {m.entitled && (
                <Button
                  variant={m.active ? 'outline' : 'default'}
                  size="sm"
                  disabled={activationMutation.isPending}
                  onClick={() => {
                    if (m.active) {
                      setDeactivateTarget({ moduleKey: m.moduleKey, reason: '' })
                    } else {
                      activationMutation.mutate({ moduleKey: m.moduleKey, active: true })
                    }
                  }}
                >
                  {m.active ? t('platform.clubDetailPage.modulesDeactivate') : t('platform.clubDetailPage.modulesActivate')}
                </Button>
              )}
            </div>
          </div>
        )
      })}

      {/* High-impact confirmation per directive: deactivation never
          deletes data -- state that explicitly, not a generic
          destructive-sounding warning. */}
      <Dialog open={deactivateTarget !== null} onOpenChange={(open) => !open && setDeactivateTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('platform.clubDetailPage.modulesDeactivateDialog.title', {
                module: deactivateTarget ? t(MODULE_LABELS[deactivateTarget.moduleKey] ?? deactivateTarget.moduleKey) : '',
              })}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-status-warning">{t('platform.clubDetailPage.modulesDeactivateDialog.impact')}</p>
            <Input
              value={deactivateTarget?.reason ?? ''}
              onChange={(e) => setDeactivateTarget((prev) => (prev ? { ...prev, reason: e.target.value } : prev))}
              placeholder={t('platform.clubDetailPage.reasonDialog.reasonPlaceholder')}
            />
            <Button
              variant="destructive"
              disabled={activationMutation.isPending}
              onClick={() => {
                if (!deactivateTarget) return
                activationMutation.mutate({ moduleKey: deactivateTarget.moduleKey, active: false, reason: deactivateTarget.reason })
              }}
            >
              {t('platform.clubDetailPage.modulesDeactivateDialog.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// PLATFORM OWNER AUTONOMOUS COMPLETION -- Phase A: per-club/provider
// payment allowlist UI. set_club_gateway_provider_policy() has been
// live since Commerce/Payment Phase 5 with zero UI -- this closes that
// gap. Never reads/shows a secret (get_platform_club_gateway_overview
// only returns `connected`/`enabled` booleans, matching
// list_club_gateway_connections' own established convention). Blocking
// a provider never disconnects an existing connection -- it only
// prevents a NEW connection or re-enabling one that's currently off,
// exactly matching the RPC's own documented, already-live behavior.
interface ProviderPolicyRow {
  providerKey: string
  providerDisplayName: string
  connected: boolean
  enabled: boolean
  policyStatus: string
  policyReason: string | null
}

async function fetchGatewayOverview(clubId: string): Promise<ProviderPolicyRow[]> {
  const { data, error } = await supabase.rpc('get_platform_club_gateway_overview', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({
    providerKey: r.provider_key,
    providerDisplayName: r.provider_display_name,
    connected: r.connected,
    enabled: r.enabled,
    policyStatus: r.policy_status,
    policyReason: r.policy_reason,
  }))
}

function ProviderPolicyPanel({ clubId }: { clubId: string }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['platform-club-gateway-overview', clubId],
    queryFn: () => fetchGatewayOverview(clubId),
  })

  const policyMutation = useMutation({
    mutationFn: async ({ providerKey, status }: { providerKey: string; status: 'allowed' | 'policy_blocked' }) => {
      const { error } = await supabase.rpc('set_club_gateway_provider_policy', {
        p_club_id: clubId,
        p_provider_key: providerKey,
        p_status: status,
        p_reason: status === 'policy_blocked' ? 'Blocked from Club Detail' : 'Restored from Club Detail',
      })
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-club-gateway-overview', clubId] }),
  })

  if (isLoading) return null

  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => (
        <div key={r.providerKey} className="flex items-center justify-between rounded-md border border-border p-2.5">
          <div>
            <p className="text-sm font-medium">{r.providerDisplayName}</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <StatusBadge
                tone={r.connected ? (r.enabled ? 'success' : 'neutral') : 'neutral'}
                label={r.connected ? (r.enabled ? t('platform.clubDetailPage.providerPolicy.connectedEnabled') : t('platform.clubDetailPage.providerPolicy.connectedDisabled')) : t('platform.clubDetailPage.providerPolicy.notConnected')}
              />
              <StatusBadge
                tone={r.policyStatus === 'policy_blocked' ? 'danger' : 'success'}
                label={r.policyStatus === 'policy_blocked' ? t('platform.clubDetailPage.providerPolicy.blocked') : t('platform.clubDetailPage.providerPolicy.allowed')}
              />
            </div>
          </div>
          <Button
            size="sm"
            variant={r.policyStatus === 'policy_blocked' ? 'default' : 'outline'}
            disabled={policyMutation.isPending}
            onClick={() =>
              policyMutation.mutate({
                providerKey: r.providerKey,
                status: r.policyStatus === 'policy_blocked' ? 'allowed' : 'policy_blocked',
              })
            }
          >
            {r.policyStatus === 'policy_blocked' ? t('platform.clubDetailPage.providerPolicy.restore') : t('platform.clubDetailPage.providerPolicy.block')}
          </Button>
        </div>
      ))}
    </div>
  )
}
