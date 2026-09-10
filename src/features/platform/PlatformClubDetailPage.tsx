import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
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
import { translateSupabaseError } from '@/lib/errors'

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
  const [reasonDialogAction, setReasonDialogAction] = useState<null | 'cancel' | 'reverse' | 'suspend' | 'changePlan' | 'payments'>(null)
  // Acceptance-sweep fix (2026-08-30): the payments kill switch used to
  // fire immediately on click with a hardcoded literal reason
  // ("Disabled from Club Detail" / "Re-enabled from Club Detail") and
  // no confirmation -- same bug class as ProviderPolicyPanel's fix just
  // above and PlatformPlansPage.tsx's hardcoded reason (documented in
  // the platform-owner acceptance pass). Disabling this immediately
  // blocks every future checkout attempt for a real paying club, so it
  // gets the same confirm-with-reason treatment as suspend/cancel, via
  // the page's existing shared reasonDialogAction dialog.
  const [paymentsToggleTarget, setPaymentsToggleTarget] = useState<boolean | null>(null)
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
  // WORKSTREAM 4 (founding customer offer wiring): a Platform-Owner-only
  // checkbox next to the paid-activation action. Deliberately NOT a
  // public self-service race-to-claim promotion -- the Platform Owner
  // decides per-club, at the moment of PAID conversion, whether this
  // club should be offered the founding discount. claim_founding_customer_slot()
  // itself is idempotent per club and structurally caps at 5 via
  // PRIMARY KEY(slot_number), so this checkbox can never over-claim even
  // if clicked more than once.
  const [applyFoundingOffer, setApplyFoundingOffer] = useState(false)
  const [foundingClaimResult, setFoundingClaimResult] = useState<
    { outcome: 'claimed'; slotNumber: number; promotionalPrice: number; promotionEnd: string }
    | { outcome: 'all_slots_taken' }
    | { outcome: 'error'; message: string }
    | null
  >(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [editingLimits, setEditingLimits] = useState(false)
  const [branchLimitInput, setBranchLimitInput] = useState('')
  const [fieldLimitInput, setFieldLimitInput] = useState('')
  const [academyLimitInput, setAcademyLimitInput] = useState('')
  // PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 3 (P1): a reason,
  // matching every other commercial-change dialog on this page, now
  // that limit changes are audited (see set_commercial_entitlements()).
  const [limitReasonInput, setLimitReasonInput] = useState('')
  // Per-request optional reason for the commercial-upgrade-request
  // approve/dismiss action fixed in this sweep -- keyed by request id
  // since multiple pending requests can render at once.
  const [upgradeRequestReasons, setUpgradeRequestReasons] = useState<Record<string, string>>({})

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
  // Phase E directive (C8/E4): WhatsApp health used to be fetched here
  // and rendered read-only. PLATFORM OWNER OPERATIONAL GAP CLOSURE --
  // Workstream 1 (2026-09-09): moved into PlatformWhatsAppCard below,
  // which now owns this query itself alongside the new connect/
  // disconnect/retry/QR polling it added -- keeping one component
  // responsible for the whole card's data + actions, matching
  // ModulesPanel/ProviderPolicyPanel's existing precedent of owning
  // their own queries rather than threading fetched data down as props.
  // Cross-phase directive (U2): staff visibility beyond club_owner
  // (managers, coaches, scanners, etc.) had no platform-level summary --
  // a platform owner had to open each club's own Staff page to see it.
  // Counts only, no permission editing -- full staff management stays
  // exactly where it already is.
  // Government / Ministry Collection Compliance directive, section 46:
  // Club 360 shows affiliation status, effective policy, receipt
  // counts, and collected total -- no receipt images (section 45).
  // PLATFORM OWNER CONTROL PLANE V1 -- Phase 4 (2026-09-08): the deep
  // dive's confirmed gap -- this query only ever destructured `data`,
  // so a real RPC failure and a legitimate "not affiliated" club (a
  // real row with enabled=false, or genuinely zero rows) rendered
  // identically: the card silently didn't appear either way. isLoading/
  // isError now branch explicitly below, matching the isLoading/isError
  // pattern already used elsewhere on this page (ModulesPanel,
  // ProviderPolicyPanel, CommercialUsageAndFoundingOfferCard).
  const { data: govCompliance, isLoading: govComplianceLoading, isError: govComplianceError } = useQuery({
    queryKey: ['platform-club-gov-compliance', clubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_platform_government_compliance_summary')
      if (error) throw error
      return (data ?? []).find((row) => row.club_id === clubId) ?? null
    },
    enabled: !!clubId,
  })
  // Phase 5: defensible "last meaningfully active" signal -- MAX of
  // bookings.created_at / payments.received_at / attendance.marked_at
  // for this club, computed server-side (get_platform_club_last_activity,
  // also inlined into get_platform_club_360 below so this page's own
  // batched RPC already carries it -- this standalone query exists only
  // so the indicator can show its own isLoading/isError state
  // independent of the larger club360 read, matching the loadError
  // banner's existing "don't let one slow/failing read block everything
  // else" philosophy).
  const { data: lastActivity, isLoading: lastActivityLoading, isError: lastActivityError } = useQuery({
    queryKey: ['platform-club-last-activity', clubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_platform_club_last_activity', { p_club_id: clubId! })
      if (error) throw error
      return data?.[0] ?? null
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
      // create_platform_subscription RETURNS uuid (the new subscription's
      // id) -- previously discarded (only `error` was read). Now captured
      // so the founding-offer claim below (which requires a real
      // platform_subscription_id, not just a club_id) can run in the same
      // action, at the exact moment of paid conversion.
      const { data: newSubscriptionId, error } = await supabase.rpc('create_platform_subscription', {
        p_club_id: clubId!,
        p_subscription_kind: 'paid',
        p_plan_id: selectedPlanId,
      })
      if (error) throw error

      // Founding-offer wiring (Platform-Owner-controlled, opt-in per
      // activation -- never automatic, never a public claim path).
      // claim_founding_customer_slot() itself never raises for
      // "all slots taken" -- it returns eligible=false, which must be
      // branched on explicitly rather than treated as an error.
      if (applyFoundingOffer && newSubscriptionId) {
        const { data: claimRows, error: claimError } = await supabase.rpc('claim_founding_customer_slot', {
          p_club_id: clubId!,
          p_platform_subscription_id: newSubscriptionId as string,
        })
        if (claimError) {
          setFoundingClaimResult({ outcome: 'error', message: claimError.message })
        } else {
          const claim = claimRows?.[0] as
            | { slot_number: number | null; eligible: boolean; promotional_price: number | null; promotion_end: string | null }
            | undefined
          if (claim?.eligible && claim.slot_number != null && claim.promotional_price != null && claim.promotion_end) {
            setFoundingClaimResult({
              outcome: 'claimed',
              slotNumber: claim.slot_number,
              promotionalPrice: claim.promotional_price,
              promotionEnd: claim.promotion_end,
            })
          } else {
            setFoundingClaimResult({ outcome: 'all_slots_taken' })
          }
        }
      } else {
        setFoundingClaimResult(null)
      }
    },
    onSuccess: () => {
      invalidateAll()
      setSelectedPlanId('')
      setApplyFoundingOffer(false)
      void queryClient.invalidateQueries({ queryKey: ['platform-founding-offer-status', clubId] })
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
      // toLimit intentionally returns null for an empty input (clears the
      // limit back to unlimited -- the column's own semantics). The
      // generated RPC arg type is a plain `number` because Postgres
      // parameter types carry no nullability signal the generator can see
      // (this integer parameter has always accepted a real SQL null at
      // runtime; a fresh `generate_typescript_types` run can tighten this
      // inferred type without the underlying function changing at all) --
      // cast at the call site rather than loosen the generated type or
      // touch the RPC signature, since both would be wider changes than
      // this single call site actually needs.
      const toLimit = (v: string) => (v.trim() === '' ? null : Number(v)) as number | null
      const { error } = await supabase.rpc('set_commercial_entitlements', {
        p_club_id: clubId!,
        p_branch_limit: toLimit(branchLimitInput) as number,
        p_field_limit: toLimit(fieldLimitInput) as number,
        p_academy_limit: toLimit(academyLimitInput) as number,
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
    mutationFn: async ({ enabled, reason }: { enabled: boolean; reason: string }) => {
      const { error } = await supabase.rpc('set_club_payments_enabled', {
        p_club_id: clubId!,
        p_enabled: enabled,
        p_reason: reason,
      })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateEntitlements()
      setReasonDialogAction(null)
      setReasonText('')
      setPaymentsToggleTarget(null)
    },
    onError: () => setActionError(t('platform.clubDetailPage.errors.setPaymentsEnabled')),
  })

  // Acceptance-sweep fix (2026-08-30), platform-owner acceptance
  // finding #2: this was a direct client-side .from().update() with no
  // audit trail -- same bug class as the P0 fix applied the same day in
  // 20260829040000_revoke_unaudited_platform_owner_direct_writes.sql,
  // which this table was missed by. Now routed through
  // resolve_commercial_upgrade_request(), which writes a real
  // audit_logs entry (before/after status + the request's own
  // limit_type/current_limit/current_usage). Reason stays optional here
  // (unlike suspend/kill-switch/support-session) -- this action is a
  // routine, reversible-by-a-new-request triage decision, not a
  // consequential one; the existing limitsCard.reasonLabel key already
  // said "(optional)" anticipating this wiring.
  const resolveUpgradeRequestMutation = useMutation({
    mutationFn: async ({ requestId, status, reason }: { requestId: string; status: 'approved' | 'dismissed'; reason: string }) => {
      const { error } = await supabase.rpc('resolve_commercial_upgrade_request', {
        p_request_id: requestId,
        p_status: status,
        p_reason: reason.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateEntitlements()
      setUpgradeRequestReasons({})
    },
    onError: () => setActionError(t('platform.clubDetailPage.errors.updateRequestStatus')),
  })

  const invoiceColumns: DataTableColumn<(typeof invoices)[number]>[] = [
    { key: 'number', header: t('platform.clubDetailPage.invoiceColumns.number'), render: (i) => <bdi>{i.invoice_number}</bdi> },
    { key: 'amount', header: t('platform.clubDetailPage.invoiceColumns.amount'), render: (i) => <MoneyDisplay amount={Number(i.amount)} size="sm" /> },
    { key: 'due', header: t('platform.clubDetailPage.invoiceColumns.due'), render: (i) => <bdi>{new Date(i.due_date).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi> },
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
          only, deliberately -- not a platform booking-operations system.

          Design remediation (premium-ui-ux-audit, Platform Owner phase):
          labeled "Tenant overview" so this record reads as a SaaS
          control plane's per-tenant profile (identity + contact +
          operational footprint) before the commercial/billing section
          further down -- purely a heading, no data or layout change. */}
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
        {t('platform.clubDetailPage.groups.tenantOverview', { defaultValue: 'Tenant overview' })}
      </p>
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
            {/* PLATFORM OWNER CONTROL PLANE V1 -- Phase 4: academies
                previously showed entitlement/active state only (Modules
                tab), with no count anywhere -- the one asymmetry vs.
                branches/fields/customers, confirmed by the deep dive
                (Section 6/7). get_platform_club_360()'s new
                academy_count column (same definition as
                commercial_entitlements_usage.academy_used) closes it
                here, in the same grid, same styling as its siblings. */}
            <div><span className="text-text-secondary">{t('platform.clubDetailPage.summaryCard.academies')}</span> <span className="font-medium">{club360?.academy_count ?? '—'}</span></div>
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
            {/* PLATFORM OWNER CONTROL PLANE V1 -- Phase 5: "no
                last-activity/last-login tracking exists anywhere in the
                product" (deep dive Section 12/23, HIGH VALUE) --
                surfaced prominently in the same Tenant overview grid
                the mission asked for ("near Identity/Summary"), not
                buried in a separate tab. MAX of
                bookings.created_at/payments.received_at/
                attendance.marked_at, computed server-side
                (get_platform_club_last_activity). isLoading/isError
                explicit, same discipline as the Government Compliance
                fix just below -- a stale/blank "—" here could otherwise
                read as "never active" when it may just mean "still
                loading" or "failed to load". */}
            <div className="col-span-2 border-t border-border pt-2">
              <span className="text-text-secondary">{t('platform.clubDetailPage.lastActivityCard.title')}</span>{' '}
              {lastActivityLoading ? (
                <span className="text-text-secondary">{t('platform.clubDetailPage.lastActivityCard.loading')}</span>
              ) : lastActivityError ? (
                <span className="text-status-danger">{t('platform.clubDetailPage.lastActivityCard.error')}</span>
              ) : lastActivity?.last_activity_at && lastActivity.last_activity_type ? (
                <span className="font-medium">
                  {t('platform.clubDetailPage.lastActivityCard.summary', {
                    type: t(`platform.clubDetailPage.lastActivityCard.typeLabels.${lastActivity.last_activity_type}`, { defaultValue: lastActivity.last_activity_type }),
                    date: `⁧${new Date(lastActivity.last_activity_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}⁩`,
                  })}
                </span>
              ) : (
                <span className="text-text-secondary">{t('platform.clubDetailPage.lastActivityCard.none')}</span>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Design remediation (premium-ui-ux-audit, Platform Owner phase):
          labeled "Commercial & operations" -- groups WhatsApp health,
          government compliance, subscription status/actions, limits,
          usage, and payment controls under one control-plane heading,
          distinct from the read-only "Tenant overview" identity section
          above. Heading only, no data/behavior change. */}
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
        {t('platform.clubDetailPage.groups.commercialOperations', { defaultValue: 'Commercial & operations' })}
      </p>

      {/* Phase E directive (C8/E4): operational health -- connection
          state, masked phone (last 4 digits), failure/queue counts.
          Never message content, per the directive's explicit privacy
          requirement (respect tenant privacy -- no customer conversation
          content).

          PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Workstream 1
          (2026-09-09): this card used to be read-only -- a platform
          owner/staff member could SEE a club's WhatsApp state but had no
          way to connect/disconnect/reconnect/view-QR for a club they do
          not personally own (every existing club-facing RPC is gated on
          club membership). PlatformWhatsAppCard below extends this exact
          card with those actions, wired to the new platform_* RPCs
          (20260909150000_platform_owner_whatsapp_connection_control.sql)
          -- same health data, same card position, just no longer
          read-only. Extracted to its own component (matching
          ModulesPanel/ProviderPolicyPanel's precedent below) since it
          now owns its own polling/QR/dialog state. */}
      {clubId && <PlatformWhatsAppCard clubId={clubId} />}

      {/* Government / Ministry Collection Compliance directive, section
          46: affiliation status, effective policy, receipt counts,
          collected total. No receipt images shown (section 45).

          PLATFORM OWNER CONTROL PLANE V1 -- Phase 4 fix (2026-09-08):
          the deep dive's confirmed gap -- this card previously rendered
          only on `govCompliance?.enabled`, so "not affiliated" (a real
          row, enabled=false) and "failed to load" (query error, data
          undefined) were visually IDENTICAL: the card simply didn't
          appear either way, with no way for a platform owner to tell
          "this club genuinely has no government affiliation" from "I
          don't actually know because the read failed". Three explicit
          branches now: loading / error / affiliated -- an unaffiliated
          club (enabled=false, no error) still renders nothing here,
          unchanged from before, since that is the correct default state
          for the overwhelming majority of ordinary commercial clubs and
          a permanent card here would be noise for them. */}
      {govComplianceLoading ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">{t('platform.clubDetailPage.govComplianceCard.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-text-secondary">{t('platform.clubDetailPage.govComplianceCard.loading')}</p>
          </CardContent>
        </Card>
      ) : govComplianceError ? (
        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="text-base">{t('platform.clubDetailPage.govComplianceCard.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ErrorState message={t('platform.clubDetailPage.govComplianceCard.error')} />
          </CardContent>
        </Card>
      ) : govCompliance?.enabled ? (
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
      ) : null}

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
                <div className="flex flex-col gap-2">
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
                  {/* WORKSTREAM 4: Platform-Owner-controlled founding-offer
                      grant, applied at the exact moment of PAID conversion
                      (never at trial start -- the offer is for "first 5
                      PAYING customers"). Not a public/self-service claim --
                      this checkbox is the only call site for
                      claim_founding_customer_slot() anywhere in the product. */}
                  <label htmlFor="apply-founding-offer" className="flex items-center gap-2 text-xs text-text-secondary">
                    <input
                      id="apply-founding-offer"
                      type="checkbox"
                      checked={applyFoundingOffer}
                      onChange={(e) => setApplyFoundingOffer(e.target.checked)}
                      className="size-4"
                    />
                    {t('platform.clubDetailPage.actionsCard.applyFoundingOffer')}
                  </label>
                  {foundingClaimResult?.outcome === 'claimed' && (
                    <p className="text-xs text-status-success">
                      {t('platform.clubDetailPage.actionsCard.foundingOfferClaimed', {
                        slot: foundingClaimResult.slotNumber,
                        price: foundingClaimResult.promotionalPrice,
                        date: new Date(foundingClaimResult.promotionEnd).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG'),
                      })}
                    </p>
                  )}
                  {foundingClaimResult?.outcome === 'all_slots_taken' && (
                    <p className="text-xs text-status-warning">{t('platform.clubDetailPage.actionsCard.foundingOfferAllSlotsTaken')}</p>
                  )}
                  {foundingClaimResult?.outcome === 'error' && (
                    <p className="text-xs text-status-danger">{t('platform.clubDetailPage.actionsCard.foundingOfferError', { message: foundingClaimResult.message })}</p>
                  )}
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
                // PLATFORM OWNER CONTROL PLANE V1 -- Phase 4
                // (2026-09-08): the deep dive found this card only ever
                // distinguished "over limit" vs. not -- no NORMAL/NEAR
                // LIMIT differentiation, unlike the separate
                // CommercialUsageAndFoundingOfferCard's controlled-
                // resource card just below, which already has
                // unlimited/normal/approaching_limit/grace/over_limit
                // via get_commercial_usage(). This card covers the
                // HARD-enforced resources (branch/field/academy) --
                // no GRACE state applies to them (the DB trigger blocks
                // new inserts outright, it doesn't grace-period them),
                // so the added vocabulary here is intentionally
                // narrower: unlimited / normal / approaching_limit (>=
                // 80%, same threshold get_commercial_usage() already
                // uses for its own hard-limit branch) / over_limit
                // (used > limit -- can still happen after a limit is
                // lowered below already-existing usage, per the
                // existing isOverLimit computation/comment above).
                const limitStatus: 'unlimited' | 'normal' | 'approaching_limit' | 'over_limit' =
                  limit === null ? 'unlimited' : isOverLimit ? 'over_limit' : used >= limit * 0.8 ? 'approaching_limit' : 'normal'
                const limitStatusTone: Record<typeof limitStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
                  unlimited: 'neutral',
                  normal: 'success',
                  approaching_limit: 'warning',
                  over_limit: 'danger',
                }
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
                      {isOverLimit ? (
                        <StatusBadge tone="danger" label={t('platform.clubDetailPage.limitsCard.overLimitBadge')} />
                      ) : limitStatus !== 'unlimited' ? (
                        <StatusBadge tone={limitStatusTone[limitStatus]} label={t(`platform.clubDetailPage.limitsCard.statusLabels.${limitStatus}`)} />
                      ) : null}
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
                <div key={r.id} className="flex flex-col gap-2 rounded-md bg-surface p-2 text-sm sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                  <span>
                    {t('platform.clubDetailPage.limitsCard.requestSummary', {
                      label: limitTypeLabel[r.limit_type] ?? r.limit_type,
                      limit: r.current_limit ?? t('platform.clubDetailPage.limitsCard.requestUnlimited'),
                      usage: r.current_usage,
                    })}
                    {r.note && <span className="text-text-secondary"> — {r.note}</span>}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <Input
                      className="h-8 w-40 text-xs"
                      value={upgradeRequestReasons[r.id] ?? ''}
                      onChange={(e) => setUpgradeRequestReasons((prev) => ({ ...prev, [r.id]: e.target.value }))}
                      placeholder={t('platform.clubDetailPage.limitsCard.reasonLabel')}
                    />
                    <Button
                      size="sm"
                      onClick={() => resolveUpgradeRequestMutation.mutate({ requestId: r.id, status: 'approved', reason: upgradeRequestReasons[r.id] ?? '' })}
                      disabled={resolveUpgradeRequestMutation.isPending}
                    >
                      {t('platform.clubDetailPage.limitsCard.approve')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resolveUpgradeRequestMutation.mutate({ requestId: r.id, status: 'dismissed', reason: upgradeRequestReasons[r.id] ?? '' })}
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

      {/* COMMERCIAL PACKAGING (2026-09-04): staff/active-player usage
          (controlled/grace resources, distinct from the hard-enforced
          branch/field/academy card above) + founding-customer offer
          status. Read-only -- reuses get_commercial_usage()/
          get_founding_offer_status(), never recomputes usage itself,
          same "single source of truth" discipline as the limits card
          above and EntitlementsCard.tsx's own tenant-facing view. */}
      {clubId && <CommercialUsageAndFoundingOfferCard clubId={clubId} />}

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
              onClick={() => {
                setPaymentsToggleTarget(!!entitlements?.payments_platform_disabled)
                setReasonTarget(clubId ?? 'payments')
                setReasonText('')
                setReasonDialogAction('payments')
              }}
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
              { key: 'start', header: t('platform.clubDetailPage.historyColumns.start'), render: (s: (typeof subscriptions)[number]) => <bdi>{new Date(s.start_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi> },
              { key: 'end', header: t('platform.clubDetailPage.historyColumns.end'), render: (s: (typeof subscriptions)[number]) => <bdi>{new Date(s.end_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi> },
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
              { key: 'created', header: t('platform.clubDetailPage.requestsColumns.createdAt'), render: (r: (typeof upgradeRequests)[number]) => <bdi>{new Date(r.created_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi> },
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
              { key: 'time', header: t('platform.clubDetailPage.auditColumns.time'), render: (a: (typeof auditRows)[number]) => <bdi>{new Date(a.created_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi> },
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
                    : reasonDialogAction === 'payments'
                      ? (paymentsToggleTarget ? t('platform.clubDetailPage.paymentsCard.enableDialogTitle') : t('platform.clubDetailPage.paymentsCard.disableDialogTitle'))
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
            {reasonDialogAction === 'payments' && paymentsToggleTarget === false && (
              <p className="text-sm text-status-danger">{t('platform.clubDetailPage.paymentsCard.disableDialogWarning')}</p>
            )}
            <Input value={reasonText} onChange={(e) => setReasonText(e.target.value)} placeholder={t('platform.clubDetailPage.reasonDialog.reasonPlaceholder')} />
            <Button
              variant={reasonDialogAction === 'suspend' || (reasonDialogAction === 'payments' && paymentsToggleTarget === false) ? 'destructive' : 'default'}
              disabled={!reasonText.trim() || cancelMutation.isPending || reverseMutation.isPending || suspendMutation.isPending || changePlanMutation.isPending || setPaymentsEnabledMutation.isPending}
              onClick={() => {
                if (!reasonTarget) return
                if (reasonDialogAction === 'cancel') cancelMutation.mutate(reasonText)
                else if (reasonDialogAction === 'suspend') suspendMutation.mutate(reasonText)
                else if (reasonDialogAction === 'changePlan') changePlanMutation.mutate(reasonText)
                else if (reasonDialogAction === 'payments') {
                  if (paymentsToggleTarget === null) return
                  setPaymentsEnabledMutation.mutate({ enabled: paymentsToggleTarget, reason: reasonText })
                } else reverseMutation.mutate({ paymentId: reasonTarget, reason: reasonText })
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
                {/* PLATFORM OWNER SAAS ACCEPTANCE (2026-08-31): same RTL bidi
                    gap as CashShiftPage.tsx's "Opened by {name} — {date}"
                    fix -- an i18next-interpolated date can't be wrapped in
                    JSX <bdi>, so it's isolated with the LRI/PDI Unicode
                    isolate pair (U+2067/U+2069) directly around the
                    interpolated value instead. */}
                {t('platform.clubDetailPage.graceDialog.resultingDate', {
                  date: `⁧${new Date(new Date(currentSub.end_at).getTime() + Number(graceDaysInput) * 86400000).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG')}⁩`,
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
  const { locale } = useDirection()
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
                  {t('platform.clubDetailPage.modulesLastChanged', { date: `⁧${new Date(m.updatedAt).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}⁩` })}
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
  // Acceptance-sweep fix (2026-08-30): this mutation used to send a
  // hardcoded literal reason ("Blocked from Club Detail" / "Restored
  // from Club Detail") -- same bug class as PlatformPlansPage.tsx's
  // hardcoded plan-update reason (documented in the platform-owner
  // acceptance pass). set_club_gateway_provider_policy() fully supports
  // and audits a real reason; the UI just never collected one. Now
  // mirrors ModulesPanel's confirm-dialog-with-reason pattern exactly,
  // and the fetched policyReason/policyUpdatedAt (already returned by
  // get_platform_club_gateway_overview but previously never rendered)
  // is shown on a blocked provider.
  const [policyTarget, setPolicyTarget] = useState<{ providerKey: string; providerDisplayName: string; status: 'allowed' | 'policy_blocked'; reason: string } | null>(null)

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['platform-club-gateway-overview', clubId],
    queryFn: () => fetchGatewayOverview(clubId),
  })

  const policyMutation = useMutation({
    mutationFn: async ({ providerKey, status, reason }: { providerKey: string; status: 'allowed' | 'policy_blocked'; reason: string }) => {
      const { error } = await supabase.rpc('set_club_gateway_provider_policy', {
        p_club_id: clubId,
        p_provider_key: providerKey,
        p_status: status,
        p_reason: reason.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['platform-club-gateway-overview', clubId] })
      setPolicyTarget(null)
    },
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
            {r.policyStatus === 'policy_blocked' && (
              <p className="mt-1 text-xs text-text-secondary">
                {r.policyReason ? t('platform.clubDetailPage.providerPolicy.blockedReason', { reason: r.policyReason }) : t('platform.clubDetailPage.providerPolicy.blockedReasonMissing')}
              </p>
            )}
          </div>
          <Button
            size="sm"
            variant={r.policyStatus === 'policy_blocked' ? 'default' : 'outline'}
            disabled={policyMutation.isPending}
            onClick={() =>
              setPolicyTarget({
                providerKey: r.providerKey,
                providerDisplayName: r.providerDisplayName,
                status: r.policyStatus === 'policy_blocked' ? 'allowed' : 'policy_blocked',
                reason: '',
              })
            }
          >
            {r.policyStatus === 'policy_blocked' ? t('platform.clubDetailPage.providerPolicy.restore') : t('platform.clubDetailPage.providerPolicy.block')}
          </Button>
        </div>
      ))}

      <Dialog open={policyTarget !== null} onOpenChange={(open) => !open && setPolicyTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {policyTarget &&
                (policyTarget.status === 'policy_blocked'
                  ? t('platform.clubDetailPage.providerPolicy.blockDialog.title', { provider: policyTarget.providerDisplayName })
                  : t('platform.clubDetailPage.providerPolicy.restoreDialog.title', { provider: policyTarget.providerDisplayName }))}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {policyTarget?.status === 'policy_blocked' && (
              <p className="text-sm text-status-warning">{t('platform.clubDetailPage.providerPolicy.blockDialog.impact')}</p>
            )}
            <Input
              value={policyTarget?.reason ?? ''}
              onChange={(e) => setPolicyTarget((prev) => (prev ? { ...prev, reason: e.target.value } : prev))}
              placeholder={t('platform.clubDetailPage.reasonDialog.reasonPlaceholder')}
            />
            <Button
              variant={policyTarget?.status === 'policy_blocked' ? 'destructive' : 'default'}
              disabled={policyMutation.isPending}
              onClick={() => {
                if (!policyTarget) return
                policyMutation.mutate({ providerKey: policyTarget.providerKey, status: policyTarget.status, reason: policyTarget.reason })
              }}
            >
              {policyTarget?.status === 'policy_blocked'
                ? t('platform.clubDetailPage.providerPolicy.blockDialog.confirm')
                : t('platform.clubDetailPage.providerPolicy.restoreDialog.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// COMMERCIAL PACKAGING (2026-09-04): staff/active-player usage
// (controlled/grace resources) + founding-customer offer status.
// Read-only Platform Owner view -- reuses get_commercial_usage() and
// get_founding_offer_status() exactly, never recomputes usage
// client-side (same discipline as the branch/field/academy limits
// card above, which reads commercial_entitlements_usage). Both RPCs
// are auth-gated server-side (club membership OR platform_owner) --
// this component adds no client-side authorization of its own.
interface CommercialUsageRow {
  resource_type: 'branch_limit' | 'field_limit' | 'academy_limit' | 'staff_limit' | 'active_player_limit'
  usage_count: number
  resource_limit: number | null
  percentage: number | null
  status: 'unlimited' | 'normal' | 'approaching_limit' | 'blocked' | 'grace' | 'over_limit'
  is_controlled: boolean
  grace_days: number | null
  over_limit_since: string | null
}

interface FoundingOfferStatus {
  is_founder: boolean
  slot_number: number | null
  list_price: number | null
  promotional_price: number | null
  promotion_start: string | null
  promotion_end: string | null
  normal_price_after_promotion: number | null
  current_effective_price: number | null
  promotion_active: boolean
  slots_remaining: number
}

const CONTROLLED_RESOURCE_STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  unlimited: 'neutral',
  normal: 'success',
  approaching_limit: 'warning',
  grace: 'warning',
  over_limit: 'danger',
}

async function fetchCommercialUsage(clubId: string): Promise<CommercialUsageRow[]> {
  const { data, error } = await supabase.rpc('get_commercial_usage', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []) as CommercialUsageRow[]
}

async function fetchFoundingOfferStatus(clubId: string): Promise<FoundingOfferStatus | null> {
  const { data, error } = await supabase.rpc('get_founding_offer_status', { p_club_id: clubId })
  if (error) throw error
  return (data?.[0] ?? null) as FoundingOfferStatus | null
}

function CommercialUsageAndFoundingOfferCard({ clubId }: { clubId: string }) {
  const { t } = useTranslation()
  const { locale } = useDirection()

  const { data: usage = [], isLoading: usageLoading } = useQuery({
    queryKey: ['platform-commercial-usage', clubId],
    queryFn: () => fetchCommercialUsage(clubId),
  })
  const { data: founding, isLoading: foundingLoading } = useQuery({
    queryKey: ['platform-founding-offer-status', clubId],
    queryFn: () => fetchFoundingOfferStatus(clubId),
  })

  // Only the two CONTROLLED resources belong on this card -- the hard
  // branch/field/academy triggers already have their own dedicated
  // card immediately above, with its own editing UI. Duplicating them
  // here would be a second, divergent display of the same numbers.
  const controlledRows = usage.filter((r) => r.is_controlled)

  return (
    <Card className="mb-4">
      <CardHeader>
        <CardTitle className="text-base">{t('platform.clubDetailPage.commercialUsageCard.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {usageLoading ? (
          <p className="text-sm text-text-secondary">{t('platform.clubDetailPage.commercialUsageCard.loading')}</p>
        ) : controlledRows.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('platform.clubDetailPage.commercialUsageCard.noData')}</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {controlledRows.map((row) => (
              <div key={row.resource_type} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {t(`platform.clubDetailPage.commercialUsageCard.resourceLabels.${row.resource_type}`)}
                  </p>
                  <StatusBadge
                    tone={CONTROLLED_RESOURCE_STATUS_TONE[row.status] ?? 'neutral'}
                    label={t(`platform.clubDetailPage.commercialUsageCard.statusLabels.${row.status}`)}
                  />
                </div>
                <p className="text-sm text-text-secondary tabular-nums">
                  {row.usage_count} {row.resource_limit === null ? t('platform.clubDetailPage.limitsCard.unlimited') : `/ ${row.resource_limit}`}
                </p>
                {row.status === 'grace' && row.over_limit_since && (
                  <p className="mt-1 text-xs text-status-warning">
                    {t('platform.clubDetailPage.commercialUsageCard.graceHint', {
                      days: row.grace_days ?? 7,
                      since: new Date(row.over_limit_since).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG'),
                    })}
                  </p>
                )}
                {row.status === 'over_limit' && (
                  <p className="mt-1 text-xs text-status-danger">{t('platform.clubDetailPage.commercialUsageCard.overLimitHint')}</p>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="border-t border-border pt-4">
          <p className="mb-2 text-sm font-medium">{t('platform.clubDetailPage.commercialUsageCard.foundingOfferTitle')}</p>
          {foundingLoading ? (
            <p className="text-sm text-text-secondary">{t('platform.clubDetailPage.commercialUsageCard.loading')}</p>
          ) : !founding ? (
            <p className="text-sm text-text-secondary">{t('platform.clubDetailPage.commercialUsageCard.noData')}</p>
          ) : founding.is_founder ? (
            <div className="flex flex-col gap-1 rounded-lg border border-status-success/40 bg-status-success/10 p-3">
              <div className="flex items-center gap-2">
                <StatusBadge tone="success" label={t('platform.clubDetailPage.commercialUsageCard.founderBadge', { slot: founding.slot_number })} />
                {founding.promotion_active && <StatusBadge tone="warning" label={t('platform.clubDetailPage.commercialUsageCard.promotionActiveBadge')} />}
              </div>
              <p className="text-sm text-text-secondary">
                {t('platform.clubDetailPage.commercialUsageCard.foundingPriceSummary', {
                  effective: founding.current_effective_price ?? 0,
                  list: founding.list_price ?? 0,
                })}
              </p>
              {founding.promotion_active && founding.promotion_end && (
                <p className="text-xs text-text-secondary">
                  {t('platform.clubDetailPage.commercialUsageCard.promotionEndsAt', {
                    date: new Date(founding.promotion_end).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG'),
                  })}
                </p>
              )}
            </div>
          ) : (
            <p className="text-sm text-text-secondary">
              {t('platform.clubDetailPage.commercialUsageCard.notFounder', { slotsRemaining: founding.slots_remaining })}
              {founding.current_effective_price !== null && (
                <> — <MoneyDisplay amount={founding.current_effective_price} currency="EGP" size="sm" /></>
              )}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

// ============================================================
// PlatformWhatsAppCard -- PLATFORM OWNER OPERATIONAL GAP CLOSURE,
// Workstream 1 (2026-09-09). Extends the formerly read-only WhatsApp
// health card with connect/retry/disconnect/QR actions, wired to the
// new platform_* RPCs (20260909150000_platform_owner_whatsapp_connection_
// control.sql). Mirrors WhatsAppConnectionCard.tsx's own UX pattern
// exactly (5s status poll, 3s QR poll while qr_required, client-side
// QRCode.toDataURL(), 20s honest QR-wait timeout) -- the only real
// difference is which RPCs are called (platform_* instead of the
// club-facing ones) and the authorization tier those RPCs check
// server-side (is_platform_owner() OR platform.whatsapp_tenant.manage,
// instead of club membership). This card never itself decides who is
// allowed to act -- every mutation below simply calls the RPC and
// surfaces whatever error Postgres returns (including "not authorized"
// for a platform staff member who lacks platform.whatsapp_tenant.manage --
// a distinct permission from platform.whatsapp_platform.manage, which
// governs Mal3aby's own Platform WhatsApp domain and does NOT imply
// this one, per owner decision #21).
//
// get_platform_whatsapp_health() (already used by this page before this
// workstream) remains the source for connected_phone_masked/
// failed_count_7d/pending_count -- none of the new platform_* RPCs
// duplicate that data. connection_status from that RPC coalesces to
// 'not_connected' when no whatsapp_accounts row exists yet, which this
// component treats identically to 'disconnected' for action-eligibility
// purposes (a club with no row at all is exactly as "not connected" as
// one with a disconnected row -- platform_start_whatsapp_pairing's own
// ON CONFLICT DO UPDATE upsert already handles both cases identically).

type PlatformWhatsAppStatus =
  | 'not_connected'
  | 'disconnected'
  | 'qr_required'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'logged_out'
  | 'restricted'
  | 'failed'
  | 'error'

interface PlatformWhatsAppHealthRow {
  club_id: string
  club_name: string
  connection_status: string
  connected_phone_masked: string | null
  last_seen_at: string | null
  circuit_breaker_open: boolean
  failed_count_7d: number
  pending_count: number
}

interface PlatformWhatsAppEventRow {
  id: string
  event: string
  actor_id: string | null
  actor_name: string | null
  // Defensive per the mission's own instruction: this column is
  // migration-documented as always {initiated_by, reason}-shaped, but
  // rendered here via a narrow whitelist of known keys rather than a
  // raw JSON dump, so an unexpected/malformed future value can never
  // leak something unintended onto the screen.
  detail: Record<string, unknown> | null
  created_at: string
}

const PLATFORM_WHATSAPP_STATUS_TONE: Record<PlatformWhatsAppStatus, StatusTone> = {
  not_connected: 'neutral',
  disconnected: 'neutral',
  qr_required: 'warning',
  connecting: 'warning',
  connected: 'success',
  reconnecting: 'warning',
  degraded: 'warning',
  logged_out: 'danger',
  restricted: 'danger',
  failed: 'danger',
  error: 'danger',
}

// Matches WhatsAppConnectionCard.tsx's own QR_WAIT_TIMEOUT_MS exactly --
// same connector, same real-world QR TTL/poll cadence, so the same
// honest-timeout window applies regardless of which actor (club owner
// or platform owner) initiated the pairing.
const PLATFORM_QR_WAIT_TIMEOUT_MS = 20000

async function fetchPlatformWhatsAppHealth(clubId: string): Promise<PlatformWhatsAppHealthRow | null> {
  const { data, error } = await supabase.rpc('get_platform_whatsapp_health', { p_club_id: clubId })
  if (error) throw error
  return data?.[0] ?? null
}

async function fetchPlatformWhatsAppQr(clubId: string): Promise<{ qrPayload: string | null; qrExpiresAt: string | null }> {
  const { data, error } = await supabase.rpc('platform_get_whatsapp_qr', { p_club_id: clubId })
  if (error) throw error
  const row = data?.[0]
  return { qrPayload: row?.qr_payload ?? null, qrExpiresAt: row?.qr_expires_at ?? null }
}

async function fetchPlatformWhatsAppRecentEvents(clubId: string): Promise<PlatformWhatsAppEventRow[]> {
  const { data, error } = await supabase.rpc('platform_get_whatsapp_recent_events', { p_club_id: clubId, p_limit: 10 })
  if (error) throw error
  return (data ?? []) as PlatformWhatsAppEventRow[]
}

function PlatformWhatsAppCard({ clubId }: { clubId: string }) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const queryClient = useQueryClient()

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [qrWaitStartedAt, setQrWaitStartedAt] = useState<number | null>(null)
  const [qrTimedOut, setQrTimedOut] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  // Reason-required confirm dialog, matching PlatformStaffPage.tsx's
  // ChangeRoleDialog pattern exactly: Save/Confirm stays disabled until
  // a real non-empty reason is typed. platform_disconnect_whatsapp()
  // itself also rejects an empty reason server-side -- this is
  // defense-in-depth in the UI, not the only enforcement.
  const [disconnectDialogOpen, setDisconnectDialogOpen] = useState(false)
  const [disconnectReason, setDisconnectReason] = useState('')

  const { data: health, isLoading: healthLoading, isError: healthError } = useQuery({
    queryKey: ['platform-whatsapp-health', clubId],
    queryFn: () => fetchPlatformWhatsAppHealth(clubId),
    enabled: !!clubId,
    // Same live-state polling cadence as WhatsAppConnectionCard.tsx's
    // own status query -- a platform owner watching this card while a
    // connect/retry is in flight needs to see it move without a manual
    // refresh, and status can also change from real WhatsApp-side
    // events (reconnect, logout from phone) no one in this tab triggered.
    refetchInterval: 5000,
  })

  const rawStatus = (health?.connection_status ?? 'not_connected') as PlatformWhatsAppStatus
  const isQrPending = rawStatus === 'qr_required'
  const isWaitingForConnector = rawStatus === 'connecting' || rawStatus === 'qr_required'

  const { data: qr } = useQuery({
    queryKey: ['platform-whatsapp-qr', clubId],
    queryFn: () => fetchPlatformWhatsAppQr(clubId),
    enabled: !!clubId && isQrPending && !qrTimedOut,
    // Matches WhatsAppConnectionCard.tsx's own QR poll cadence exactly
    // -- QR polling is only ever active while actively waiting for a
    // scan, never continuously (isQrPending above gates it off outside
    // that window).
    refetchInterval: 3000,
  })

  const { data: recentEvents = [], isLoading: eventsLoading, refetch: refetchEvents } = useQuery({
    queryKey: ['platform-whatsapp-recent-events', clubId],
    queryFn: () => fetchPlatformWhatsAppRecentEvents(clubId),
    enabled: !!clubId && showEvents,
  })

  useEffect(() => {
    if (!isWaitingForConnector) {
      setQrWaitStartedAt(null)
      setQrTimedOut(false)
      return
    }
    if (qrDataUrl) {
      setQrTimedOut(false)
      return
    }
    if (qrWaitStartedAt === null) {
      setQrWaitStartedAt(Date.now())
      return
    }
    const elapsed = Date.now() - qrWaitStartedAt
    if (elapsed >= PLATFORM_QR_WAIT_TIMEOUT_MS) {
      setQrTimedOut(true)
    } else {
      const timer = setTimeout(() => setQrTimedOut(true), PLATFORM_QR_WAIT_TIMEOUT_MS - elapsed)
      return () => clearTimeout(timer)
    }
  }, [isWaitingForConnector, qrDataUrl, qrWaitStartedAt])

  useEffect(() => {
    if (!qr?.qrPayload) {
      setQrDataUrl(null)
      return
    }
    let cancelled = false
    QRCode.toDataURL(qr.qrPayload, { width: 240, margin: 1 }).then((url) => {
      if (!cancelled) setQrDataUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [qr?.qrPayload])

  const invalidateHealth = () => {
    void queryClient.invalidateQueries({ queryKey: ['platform-whatsapp-health', clubId] })
  }

  const connectMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('platform_start_whatsapp_pairing', { p_club_id: clubId })
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      setQrTimedOut(false)
      setQrWaitStartedAt(Date.now())
      invalidateHealth()
    },
    onError: (err) => setActionError(translateSupabaseError(err, t('platform.clubDetailPage.whatsappCard.errors.connect'))),
  })

  const retryMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('platform_retry_whatsapp_connection', { p_club_id: clubId })
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      setQrTimedOut(false)
      setQrWaitStartedAt(Date.now())
      invalidateHealth()
      void queryClient.invalidateQueries({ queryKey: ['platform-whatsapp-qr', clubId] })
    },
    onError: (err) => setActionError(translateSupabaseError(err, t('platform.clubDetailPage.whatsappCard.errors.retry'))),
  })

  const disconnectMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await supabase.rpc('platform_disconnect_whatsapp', { p_club_id: clubId, p_reason: reason })
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      setDisconnectDialogOpen(false)
      setDisconnectReason('')
      invalidateHealth()
      if (showEvents) void refetchEvents()
    },
    onError: (err) => setActionError(translateSupabaseError(err, t('platform.clubDetailPage.whatsappCard.errors.disconnect'))),
  })

  const statusLabel = t(`whatsapp.statusLabels.${rawStatus === 'not_connected' ? 'disconnected' : rawStatus}`, {
    defaultValue: rawStatus,
  })

  // Renders only the known, migration-documented shape
  // ({initiated_by, reason}) -- never the raw jsonb blob -- per the
  // mission's explicit instruction to read `detail` defensively even
  // though the backend never puts anything else in it today.
  function renderEventDetail(detail: Record<string, unknown> | null): string | null {
    if (!detail) return null
    const parts: string[] = []
    if (typeof detail.reason === 'string' && detail.reason.trim()) parts.push(detail.reason)
    if (typeof detail.initiated_by === 'string' && detail.initiated_by.trim()) {
      parts.push(t('platform.clubDetailPage.whatsappCard.recentEvents.initiatedByPrefix', { who: detail.initiated_by }))
    }
    return parts.length ? parts.join(' — ') : null
  }

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t('platform.clubDetailPage.whatsappCard.title')}</CardTitle>
        {!healthLoading && <StatusBadge tone={PLATFORM_WHATSAPP_STATUS_TONE[rawStatus] ?? 'neutral'} label={statusLabel} />}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {healthLoading && <p className="text-sm text-text-secondary">{t('platform.clubDetailPage.whatsappCard.loading')}</p>}
        {healthError && <ErrorState message={t('platform.clubDetailPage.whatsappCard.loadError')} />}
        {actionError && (
          <p role="alert" className="text-sm text-status-danger">
            {actionError}
          </p>
        )}

        {!healthLoading && !healthError && (
          <>
            <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div>
                <p className="text-text-secondary">{t('platform.clubDetailPage.whatsappCard.number')}</p>
                <bdi>{health?.connected_phone_masked ?? '—'}</bdi>
              </div>
              <div>
                <p className="text-text-secondary">{t('platform.clubDetailPage.whatsappCard.lastSeen')}</p>
                <p className="font-medium">{formatPlatformWhatsAppDateTime(health?.last_seen_at ?? null, locale)}</p>
              </div>
              <div>
                <p className="text-text-secondary">{t('platform.clubDetailPage.whatsappCard.failures7d')}</p>
                <p className="font-medium tabular-nums">{health?.failed_count_7d ?? 0}</p>
              </div>
              <div>
                <p className="text-text-secondary">{t('platform.clubDetailPage.whatsappCard.pending')}</p>
                <p className="font-medium tabular-nums">{health?.pending_count ?? 0}</p>
              </div>
            </div>

            {/* Connected state -- disconnect available, reason required. */}
            {(rawStatus === 'connected' || rawStatus === 'reconnecting' || rawStatus === 'degraded') && (
              <div className="flex flex-col gap-2">
                {rawStatus === 'reconnecting' && (
                  <p className="text-sm text-text-secondary">{t('whatsapp.connectionCard.reconnecting')}</p>
                )}
                {rawStatus === 'degraded' && (
                  <p className="text-sm text-text-secondary">{t('whatsapp.connectionCard.degraded')}</p>
                )}
                <Button
                  variant="destructive"
                  size="sm"
                  className="self-start"
                  onClick={() => {
                    setDisconnectReason('')
                    setDisconnectDialogOpen(true)
                  }}
                  disabled={disconnectMutation.isPending}
                >
                  {t('platform.clubDetailPage.whatsappCard.disconnect')}
                </Button>
              </div>
            )}

            {/* Connecting / QR wait -- same QR render + 20s honest
                timeout as WhatsAppConnectionCard.tsx. */}
            {(rawStatus === 'qr_required' || rawStatus === 'connecting') && (
              <div className="flex flex-col items-center gap-3 text-center">
                {qrDataUrl ? (
                  <>
                    <img src={qrDataUrl} alt={t('whatsapp.connectionCard.qrAlt')} className="size-60 rounded-md border border-border" />
                    <p className="text-sm text-text-secondary">{t('whatsapp.connectionCard.qrInstructions')}</p>
                    <p className="text-xs text-text-secondary">{t('whatsapp.connectionCard.qrExpiryHint')}</p>
                  </>
                ) : qrTimedOut ? (
                  <>
                    <p className="text-sm text-status-danger">{t('whatsapp.connectionCard.timeoutMessage')}</p>
                    <Button size="sm" onClick={() => retryMutation.mutate()} disabled={retryMutation.isPending}>
                      {t('platform.clubDetailPage.whatsappCard.retry')}
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-text-secondary">{t('whatsapp.connectionCard.generatingQr')}</p>
                )}
              </div>
            )}

            {/* Not connected / logged out / failed -- connect available. */}
            {(rawStatus === 'not_connected' ||
              rawStatus === 'disconnected' ||
              rawStatus === 'logged_out' ||
              rawStatus === 'failed' ||
              rawStatus === 'error' ||
              rawStatus === 'restricted') && (
              <div className="flex flex-col gap-2">
                <p className="text-sm text-text-secondary">
                  {rawStatus === 'restricted' ? t('whatsapp.connectionCard.restrictedHint') : t('platform.clubDetailPage.whatsappCard.connectHint')}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" className="self-start" onClick={() => connectMutation.mutate()} disabled={connectMutation.isPending}>
                    {t('platform.clubDetailPage.whatsappCard.connect')}
                  </Button>
                  {(rawStatus === 'failed' || rawStatus === 'error') && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="self-start"
                      onClick={() => retryMutation.mutate()}
                      disabled={retryMutation.isPending}
                    >
                      {t('platform.clubDetailPage.whatsappCard.retry')}
                    </Button>
                  )}
                </div>
              </div>
            )}

            {/* Recent events -- short list, not a new page, matching the
                mission's explicit "keep this simple" instruction. */}
            <div className="border-t border-border pt-3">
              <Button variant="outline" size="sm" onClick={() => setShowEvents((v) => !v)}>
                {showEvents ? t('platform.clubDetailPage.whatsappCard.recentEvents.hide') : t('platform.clubDetailPage.whatsappCard.recentEvents.show')}
              </Button>
              {showEvents && (
                <div className="mt-3 flex flex-col gap-2">
                  {eventsLoading ? (
                    <p className="text-sm text-text-secondary">{t('platform.clubDetailPage.whatsappCard.recentEvents.loading')}</p>
                  ) : recentEvents.length === 0 ? (
                    <p className="text-sm text-text-secondary">{t('platform.clubDetailPage.whatsappCard.recentEvents.empty')}</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5 text-sm">
                      {recentEvents.map((ev) => (
                        <li key={ev.id} className="rounded-md border border-border p-2">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium">{t(`platform.clubDetailPage.whatsappCard.recentEvents.eventLabels.${ev.event}`, { defaultValue: ev.event })}</span>
                            <span className="text-xs text-text-secondary">{formatPlatformWhatsAppDateTime(ev.created_at, locale)}</span>
                          </div>
                          <p className="text-xs text-text-secondary">
                            {ev.actor_name ?? t('platform.clubDetailPage.whatsappCard.recentEvents.systemActor')}
                            {renderEventDetail(ev.detail) ? ` — ${renderEventDetail(ev.detail)}` : ''}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={disconnectDialogOpen} onOpenChange={(open) => !open && setDisconnectDialogOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('platform.clubDetailPage.whatsappCard.disconnectDialog.title')}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-status-danger">{t('platform.clubDetailPage.whatsappCard.disconnectDialog.warning')}</p>
            <Input
              value={disconnectReason}
              onChange={(e) => setDisconnectReason(e.target.value)}
              placeholder={t('platform.clubDetailPage.reasonDialog.reasonPlaceholder')}
            />
            <Button
              variant="destructive"
              disabled={!disconnectReason.trim() || disconnectMutation.isPending}
              onClick={() => disconnectMutation.mutate(disconnectReason)}
            >
              {t('platform.clubDetailPage.whatsappCard.disconnectDialog.confirm')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

// Matches WhatsAppConnectionCard.tsx's own formatDateTime() FSI/PDI-
// isolated helper exactly (production audit finding H-1) -- a local
// copy rather than an import since that component is explicitly
// read-only/off-limits for this workstream (mission instruction: "don't
// edit the club-facing component"), and exporting a helper out of it
// just for this one caller would be a bigger change than duplicating
// eight lines.
const PLATFORM_DATETIME_FSI = '⁦'
const PLATFORM_DATETIME_PDI = '⁩'
function formatPlatformWhatsAppDateTime(iso: string | null, locale: 'ar' | 'en'): string {
  if (!iso) return '—'
  const formatted = new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG', { dateStyle: 'medium', timeStyle: 'short' })
  return `${PLATFORM_DATETIME_FSI}${formatted}${PLATFORM_DATETIME_PDI}`
}
