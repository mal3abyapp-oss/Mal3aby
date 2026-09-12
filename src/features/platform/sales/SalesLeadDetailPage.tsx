// SalesLeadDetailPage -- Sales Intelligence Phase 8 (ADR-054). The rich
// lead profile: overview, contact, location, facility signals with
// source evidence, score explanation, activity timeline, notes,
// outreach history, follow-up schedule, demo status, and conversion
// status.
//
// PHASE 14 (ADR-054 final decision -- INVITE-BASED OWNER ACTIVATION):
// "Convert to Tenant" sends a secure activation invite to the prospect's
// own email; the platform owner never becomes the tenant's owner and
// never types a password on the prospect's behalf. sales_win_lead_and_
// invite_owner() moves the lead WON -> AWAITING_OWNER_ACTIVATION in one
// call and mints the invite; the prospect completes activation
// themselves at /sales-activate/:token (ActivateTenantOwnerPage), which
// is the only place complete_new_club_onboarding() is ever invoked, and
// always under the prospect's own session. This page only shows status
// and offers Resend -- it can never activate a tenant directly.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { FormattedDate } from '@/components/ui/formatted-date'
import { FormLabel } from '@/components/ui/form-label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { MessageCircle } from 'lucide-react'
import { SALES_DISPLAY_TIMEZONE } from './salesTimeZone'

// PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Workstream 2 (2026-09-09):
// pipeline statuses this page's status-change control can offer.
// 'won', 'awaiting_owner_activation', 'tenant_activated' are excluded
// (only reachable via sales_win_lead_and_invite_owner -- attempting
// them via sales_change_lead_status correctly raises server-side).
// The current status itself is also filtered out client-side below.
const CHANGEABLE_STATUSES = [
  'discovered', 'enriching', 'enriched', 'qualified', 'contact_ready', 'contacted',
  'replied', 'demo_scheduled', 'demo_completed', 'negotiation', 'lost', 'do_not_contact',
]

// Statuses where a reason is required per the mission's "record reason
// lost" instruction. Originally UI-only (the RPC's p_reason was
// default null with no server-side check for these); a Phase 16
// independent UX review correctly flagged this as a real gap (a direct
// RPC call could bypass it), fixed server-side in
// 20260910100000_sales_change_lead_status_require_reason_for_lost.sql
// -- this constant now mirrors that RPC's own guard, kept here so the
// UI can disable Save before the round-trip rather than only surfacing
// the server's rejection after the fact.
const REASON_REQUIRED_STATUSES = new Set(['lost', 'do_not_contact'])
// Statuses where a real confirm step is required before saving --
// terminal-ish transitions that are hard to walk back from.
const CONFIRM_REQUIRED_STATUSES = new Set(['lost', 'do_not_contact'])

const DEMO_OUTCOMES = ['positive', 'neutral', 'negative', 'no_show']
const OUTREACH_MESSAGE_TYPES = ['intro', 'offer', 'followup', 'demo_pitch', 'proposal_summary']
// OWNER DECISION #20 FRONTEND (2026-09-10): 'whatsapp_message' is a NEW,
// genuinely distinct channel -- a single, literal, send-ready WhatsApp
// message -- structurally separate from 'whatsapp_talking_points' (a
// human call/chat script that stays permanently un-sendable; see
// 20260910110000_sales_whatsapp_message_channel_and_edit_tracking.sql).
const OUTREACH_CHANNELS = ['email', 'phone_script', 'whatsapp_talking_points', 'whatsapp_message']

interface LeadProfile {
  lead: {
    id: string
    business_name: string
    business_type: string | null
    country: string | null
    city: string | null
    area: string | null
    address: string | null
    website: string | null
    public_phone: string | null
    public_email: string | null
    whatsapp_public_number: string | null
    rating: number | null
    review_count: number | null
    status: string
    current_score: number | null
    current_score_band: string | null
    converted_club_id: string | null
    converted_at: string | null
    business_name_ar: string | null
  }
  signals: Array<{ id: string; signal_key: string; confidence: string; evidence: Record<string, unknown>; source_url: string | null; retrieved_at: string }>
  latest_score: { score: number; score_band: string; dimension_breakdown: Record<string, number>; explanation_en: string; explanation_ar: string } | null
  notes: Array<{ id: string; note: string; created_at: string }>
  activities: Array<{ id: string; activity_type: string; detail: Record<string, unknown>; created_at: string }>
  outreach_messages: Array<{
    id: string; channel: string; message_type: string; language: string; subject: string | null; body: string; status: string; created_at: string
    quality_status?: string | null
    quality_gate_result?: { gates?: Record<string, boolean>; rejection_reasons?: string[] } | null
    edited_body?: string | null
    edited_at?: string | null
  }>
  followups: Array<{ id: string; reason: string; scheduled_at: string; status: string }>
  status_history: Array<{ from_status: string | null; to_status: string; reason: string | null; changed_at: string }>
  demo_events: Array<{ id: string; scheduled_at: string | null; completed_at: string | null; outcome: string | null; notes: string | null; created_at: string }>
  possible_duplicates: Array<{ id: string; lead_id_a: string; lead_id_b: string; confidence: string }>
  activation_invite: { status: string; owner_email: string; expires_at: string; created_at: string; consumed_at: string | null } | null
}

interface ChannelEligibility {
  email_eligible: boolean
  email_reason: string
  whatsapp_eligible: boolean
  whatsapp_reason: string
  call_task_eligible: boolean
  call_task_reason: string
  recommended_channel: string
  recommended_reason: string
}

interface CallTask {
  id: string
  phone_number: string
  talking_points: string | null
  status: string
  outcome: string | null
  created_at: string
}

interface OutreachEvent {
  id: string
  message_id: string
  event_type: string
  is_reply: boolean
  reply_excerpt: string | null
  created_at: string
  message_channel: string
  message_subject: string | null
}

async function fetchChannelEligibility(leadId: string): Promise<ChannelEligibility> {
  const { data, error } = await supabase.rpc('get_lead_channel_eligibility', { p_lead_id: leadId })
  if (error) throw error
  return (Array.isArray(data) ? data[0] : data) as unknown as ChannelEligibility
}

async function fetchCallTasks(leadId: string): Promise<CallTask[]> {
  const { data, error } = await supabase.rpc('get_lead_call_tasks', { p_lead_id: leadId })
  if (error) throw error
  return (data ?? []) as unknown as CallTask[]
}

async function fetchOutreachEvents(leadId: string): Promise<OutreachEvent[]> {
  const { data, error } = await supabase.rpc('get_lead_outreach_events', { p_lead_id: leadId })
  if (error) throw error
  return (data ?? []) as unknown as OutreachEvent[]
}

// OWNER DECISION #20 FRONTEND: Send step needs to know which Platform
// WhatsApp account will send and whether it's connected, before
// offering a Send button. get_platform_whatsapp_sender_identity() is a
// narrow read scoped exactly to that -- see
// 20260910120000_sales_platform_whatsapp_send_enabled.sql.
interface PlatformWhatsAppSenderIdentity {
  status: string
  connected_phone_number: string | null
}

async function fetchPlatformWhatsAppSenderIdentity(): Promise<PlatformWhatsAppSenderIdentity | null> {
  const { data, error } = await supabase.rpc('get_platform_whatsapp_sender_identity')
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  return (row ?? null) as PlatformWhatsAppSenderIdentity | null
}

function scoreBandTone(band: string | null): 'danger' | 'warning' | 'neutral' {
  if (band === 'hot') return 'danger'
  if (band === 'warm') return 'warning'
  return 'neutral'
}

async function fetchProfile(leadId: string): Promise<LeadProfile> {
  const { data, error } = await supabase.rpc('get_lead_full_profile', { p_lead_id: leadId })
  if (error) throw error
  return data as unknown as LeadProfile
}

export function SalesLeadDetailPage() {
  const { leadId } = useParams<{ leadId: string }>()
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const [noteText, setNoteText] = useState('')
  const [followupReason, setFollowupReason] = useState('')
  const [followupDate, setFollowupDate] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [convertContactPhone, setConvertContactPhone] = useState('')
  const [convertError, setConvertError] = useState<string | null>(null)

  const [callOutcomeDrafts, setCallOutcomeDrafts] = useState<Record<string, string>>({})

  // Item 1: general pipeline status-change control.
  const [statusDialogOpen, setStatusDialogOpen] = useState(false)
  const [newStatus, setNewStatus] = useState('')
  const [statusReason, setStatusReason] = useState('')
  const [statusChangeError, setStatusChangeError] = useState<string | null>(null)

  // Item 2: demo scheduling / completion.
  const [scheduleDemoOpen, setScheduleDemoOpen] = useState(false)
  const [demoScheduledAt, setDemoScheduledAt] = useState('')
  const [demoScheduleNotes, setDemoScheduleNotes] = useState('')
  const [demoScheduleError, setDemoScheduleError] = useState<string | null>(null)
  const [completeDemoOpen, setCompleteDemoOpen] = useState(false)
  const [demoOutcome, setDemoOutcome] = useState('')
  const [demoCompleteNotes, setDemoCompleteNotes] = useState('')
  const [demoCompleteError, setDemoCompleteError] = useState<string | null>(null)

  // Item 4: AI draft approve/reject/queue/regenerate.
  const [rejectDialogFor, setRejectDialogFor] = useState<string | null>(null)
  const [rejectReason, setRejectReason] = useState('')
  const [rejectError, setRejectError] = useState<string | null>(null)
  const [approveError, setApproveError] = useState<string | null>(null)
  const [queueError, setQueueError] = useState<string | null>(null)
  const [regenerateError, setRegenerateError] = useState<string | null>(null)
  const [regenMessageType, setRegenMessageType] = useState('offer')
  const [regenChannel, setRegenChannel] = useState('email')
  const [regenLanguage, setRegenLanguage] = useState<'ar' | 'en'>('ar')

  // OWNER DECISION #20 FRONTEND: Edit (whatsapp_message drafts, status
  // generated/approved) and explicit Send (whatsapp_message drafts,
  // status approved, via Platform WhatsApp only).
  const [editDialogFor, setEditDialogFor] = useState<string | null>(null)
  const [editBody, setEditBody] = useState('')
  const [editError, setEditError] = useState<string | null>(null)
  const [sendErrors, setSendErrors] = useState<Record<string, { message: string; isNotConnected: boolean }>>({})

  const profileQuery = useQuery({
    queryKey: ['sales-lead-profile', leadId],
    queryFn: () => fetchProfile(leadId!),
    enabled: !!leadId,
  })

  const eligibilityQuery = useQuery({
    queryKey: ['sales-lead-channel-eligibility', leadId],
    queryFn: () => fetchChannelEligibility(leadId!),
    enabled: !!leadId,
  })

  const callTasksQuery = useQuery({
    queryKey: ['sales-lead-call-tasks', leadId],
    queryFn: () => fetchCallTasks(leadId!),
    enabled: !!leadId,
  })

  const outreachEventsQuery = useQuery({
    queryKey: ['sales-lead-outreach-events', leadId],
    queryFn: () => fetchOutreachEvents(leadId!),
    enabled: !!leadId,
  })

  // Only needed once a whatsapp_message draft exists on this lead --
  // still cheap/harmless to fetch unconditionally (narrow, read-only,
  // no p_lead_id parameter -- it's the platform account's own status,
  // not lead-scoped), matching how eligibilityQuery etc. run eagerly too.
  //
  // FIX (2026-09-12, UX review finding): this query previously relied
  // solely on the 30s global staleTime + refetchOnWindowFocus, so an
  // owner who opens a lead, sees "connected", and stays on this exact
  // tab (no window blur/refocus) while Platform WhatsApp is disconnected
  // elsewhere would keep seeing the stale "connected" banner and an
  // enabled Send button indefinitely -- only discovering the disconnect
  // when Send itself fails. A 15s poll while this page is mounted closes
  // that window without adding meaningful load (matches the spirit of
  // PlatformWhatsAppPage.tsx's own 5s status poll, relaxed here since
  // this is a lighter, less latency-critical confirmation check, not
  // the dedicated connection-management page).
  const whatsappSenderQuery = useQuery({
    queryKey: ['platform-whatsapp-sender-identity'],
    queryFn: fetchPlatformWhatsAppSenderIdentity,
    enabled: !!leadId,
    refetchInterval: 15_000,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['sales-lead-profile', leadId] })
    queryClient.invalidateQueries({ queryKey: ['sales-lead-channel-eligibility', leadId] })
    queryClient.invalidateQueries({ queryKey: ['sales-lead-call-tasks', leadId] })
    queryClient.invalidateQueries({ queryKey: ['sales-lead-outreach-events', leadId] })
  }

  const createCallTaskMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_create_call_task', { p_lead_id: leadId! })
      if (error) throw error
    },
    onSuccess: invalidate,
  })

  const completeCallTaskMutation = useMutation({
    mutationFn: async (taskId: string) => {
      const { error } = await supabase.rpc('sales_complete_call_task', {
        p_task_id: taskId,
        p_outcome: callOutcomeDrafts[taskId] ?? '',
      })
      if (error) throw error
    },
    onSuccess: (_data, taskId) => {
      setCallOutcomeDrafts((prev) => {
        const next = { ...prev }
        delete next[taskId]
        return next
      })
      invalidate()
    },
  })

  const scoreMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_compute_lead_score', { p_lead_id: leadId! })
      if (error) throw error
    },
    onSuccess: invalidate,
  })

  // PHASE 3 acceptance-test fix (2026-09-04): sales-website-enrichment
  // existed as a working Edge Function since Phase 5 but had NO frontend
  // trigger anywhere in the app -- confirmed via a full source grep
  // finding zero calls to it. This button is that missing production
  // entrypoint. Requires lead.website to be set (mirrors the Edge
  // Function's own "lead has no website to enrich" 400 guard).
  const enrichMutation = useMutation({
    mutationFn: async () => {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sales-website-enrichment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lead_id: leadId }),
      })
      const json = await res.json()
      if (!res.ok) throw Object.assign(new Error(json.error ?? 'website enrichment failed'), { status: res.status, detail: json })
      return json
    },
    onSuccess: invalidate,
  })

  const noteMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_add_lead_note', { p_lead_id: leadId!, p_note: noteText })
      if (error) throw error
    },
    onSuccess: () => {
      setNoteText('')
      invalidate()
    },
  })

  const followupMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_schedule_followup', {
        p_lead_id: leadId!,
        p_reason: followupReason,
        p_scheduled_at: new Date(followupDate).toISOString(),
      })
      if (error) throw error
    },
    onSuccess: () => {
      setFollowupReason('')
      setFollowupDate('')
      invalidate()
    },
  })

  // Item 1: general pipeline status-change control -- replaces the old
  // single hardcoded "Mark do_not_contact" button. sales_change_lead_
  // status() itself enforces the real guards server-side (do_not_contact
  // near-terminal, won/awaiting_owner_activation/tenant_activated fully
  // terminal and only reachable via the dedicated conversion RPC) -- this
  // is a thin, general UI over that same single RPC.
  const changeStatusMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_change_lead_status', {
        p_lead_id: leadId!,
        p_new_status: newStatus,
        p_reason: statusReason.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setStatusDialogOpen(false)
      setNewStatus('')
      setStatusReason('')
      setStatusChangeError(null)
      invalidate()
    },
    onError: (error: { message?: string }) => {
      setStatusChangeError(error?.message || t('platform.sales.leadProfile.changeStatusError'))
    },
  })

  // Item 2: demo scheduling / completion -- first writers to
  // sales_demo_events (schema-only stub before this session).
  const scheduleDemoMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_schedule_demo', {
        p_lead_id: leadId!,
        p_scheduled_at: new Date(demoScheduledAt).toISOString(),
        p_notes: demoScheduleNotes.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setScheduleDemoOpen(false)
      setDemoScheduledAt('')
      setDemoScheduleNotes('')
      setDemoScheduleError(null)
      invalidate()
    },
    onError: (error: { message?: string }) => {
      setDemoScheduleError(error?.message || t('platform.sales.leadProfile.demoScheduleError'))
    },
  })

  const completeDemoMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_complete_demo', {
        p_lead_id: leadId!,
        p_outcome: demoOutcome,
        p_notes: demoCompleteNotes.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setCompleteDemoOpen(false)
      setDemoOutcome('')
      setDemoCompleteNotes('')
      setDemoCompleteError(null)
      invalidate()
    },
    onError: (error: { message?: string }) => {
      setDemoCompleteError(error?.message || t('platform.sales.leadProfile.demoCompleteError'))
    },
  })

  // Item 4: AI draft approve/reject/queue -- these RPCs already exist
  // and are already permission-gated server-side but had ZERO frontend
  // callers before this pass.
  const approveMessageMutation = useMutation({
    mutationFn: async (messageId: string) => {
      const { error } = await supabase.rpc('sales_approve_outreach_message', { p_message_id: messageId })
      if (error) throw error
    },
    onSuccess: () => {
      setApproveError(null)
      invalidate()
    },
    onError: (error: { message?: string }) => {
      setApproveError(error?.message || t('platform.sales.leadProfile.outreachApproveError'))
    },
  })

  const rejectMessageMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_reject_outreach_message', {
        p_message_id: rejectDialogFor!,
        p_reason: rejectReason.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setRejectDialogFor(null)
      setRejectReason('')
      setRejectError(null)
      invalidate()
    },
    onError: (error: { message?: string }) => {
      setRejectError(error?.message || t('platform.sales.leadProfile.outreachRejectError'))
    },
  })

  // sales_queue_outreach_message() refuses non-email channel server-side
  // -- the button that calls this is only shown for channel='email'
  // approved messages (belt-and-suspenders: the RPC's own guard is the
  // real enforcement, this is just not offering a button that would
  // always fail).
  const queueMessageMutation = useMutation({
    mutationFn: async (messageId: string) => {
      const { error } = await supabase.rpc('sales_queue_outreach_message', { p_message_id: messageId })
      if (error) throw error
    },
    onSuccess: () => {
      setQueueError(null)
      invalidate()
    },
    onError: (error: { message?: string }) => {
      setQueueError(error?.message || t('platform.sales.leadProfile.outreachQueueError'))
    },
  })

  // OWNER DECISION #20 FRONTEND (2026-09-10): sales_edit_outreach_draft()
  // now exists (20260910130000_sales_edit_outreach_draft.sql) -- but only
  // for channel='whatsapp_message' drafts in this UI (the owner's exact
  // required workflow: Generate -> Review -> Edit (optional) -> Approve
  // -> Send). Every other channel keeps "Regenerate" as its only revision
  // path, unchanged. "Regenerate" calls the same generation Edge Function
  // used everywhere else in this module; the fresh draft goes through the
  // same quality gate and approval flow as any other generation.
  const editMessageMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_edit_outreach_draft', {
        p_message_id: editDialogFor!,
        p_edited_body: editBody,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setEditDialogFor(null)
      setEditBody('')
      setEditError(null)
      invalidate()
    },
    onError: (error: { message?: string }) => {
      setEditError(translateSupabaseError(error, t('platform.sales.leadProfile.outreachEditError')))
    },
  })

  // OWNER DECISION #20 FRONTEND: explicit Send action, separate from
  // Approve -- "Approval does NOT silently send unless the owner
  // explicitly presses Send" is the owner's own literal requirement.
  // Only ever called for channel='whatsapp_message' + status='approved'
  // rows; the RPC itself re-checks both server-side regardless.
  const sendWhatsAppMutation = useMutation({
    mutationFn: async (messageId: string) => {
      const { error } = await supabase.rpc('sales_queue_platform_whatsapp_message', { p_message_id: messageId })
      if (error) throw error
    },
    onSuccess: (_data, messageId) => {
      setSendErrors((prev) => {
        const next = { ...prev }
        delete next[messageId]
        return next
      })
      invalidate()
    },
    onError: (error: { message?: string }, messageId) => {
      // Independent UX review finding, fixed: the connection-status
      // race (Platform WhatsApp disconnects between page load and the
      // Send click -- the RPC's own server-side guard,
      // 20260910120000_sales_platform_whatsapp_send_enabled.sql)
      // previously fell through to the generic outreachSendError
      // fallback with no link back to /platform/whatsapp, even though
      // the page-load-time "not connected" state (whatsappSenderQuery)
      // already showed one. Detect the RPC's own machine-parseable
      // error prefix and render the same actionable Link for this case
      // too, matching translateSupabaseError's own now-added mapped
      // text (src/lib/errors.ts) for the plain-message part.
      const isNotConnected = !!error.message?.toLowerCase().includes('platform_whatsapp_not_connected')
      setSendErrors((prev) => ({
        ...prev,
        [messageId]: {
          message: translateSupabaseError(error, t('platform.sales.leadProfile.outreachSendError')),
          isNotConnected,
        },
      }))
      if (isNotConnected) {
        // The page's own cached connection status is now known-stale --
        // refetch so the primary "not connected" card (with its own
        // Link) takes over on the next render instead of relying only
        // on this inline fallback.
        void whatsappSenderQuery.refetch()
      }
    },
  })

  const regenerateMutation = useMutation({
    mutationFn: async () => {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/sales-ai-offer-generator`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lead_id: leadId, message_type: regenMessageType, language: regenLanguage, channel: regenChannel }),
      })
      const json = await res.json()
      if (!res.ok) throw Object.assign(new Error(json.error ?? 'regeneration failed'), { status: res.status, detail: json })
      return json
    },
    onSuccess: () => {
      setRegenerateError(null)
      invalidate()
    },
    onError: (error: { message?: string }) => {
      setRegenerateError(error?.message || t('platform.sales.leadProfile.outreachRegenerateError'))
    },
  })

  // PHASE 14: sends the secure activation invite -- never creates a
  // tenant directly. The prospect completes activation themselves.
  const sendInviteMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_win_lead_and_invite_owner', {
        p_lead_id: leadId!,
        p_owner_email: ownerEmail.trim(),
        p_contact_phone: convertContactPhone.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setConvertError(null)
      invalidate()
    },
    onError: (error: { message?: string }) => {
      setConvertError(error?.message || t('platform.sales.leadProfile.convertInviteError'))
    },
  })

  const resendInviteMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('resend_sales_activation_invite', { p_lead_id: leadId! })
      if (error) throw error
    },
    onSuccess: invalidate,
    onError: (error: { message?: string }) => {
      setConvertError(error?.message || t('platform.sales.leadProfile.resendError'))
    },
  })

  if (profileQuery.isError) {
    return <ErrorState message={translateSupabaseError(profileQuery.error, t('platform.sales.leadProfile.loadError'))} onRetry={() => profileQuery.refetch()} />
  }

  if (profileQuery.isLoading || !profileQuery.data) {
    return <p className="text-sm text-text-secondary">{t('common.loading')}</p>
  }

  const { lead, latest_score, activation_invite } = profileQuery.data
  // Defensive: get_lead_full_profile() always coalesces every one of
  // these eight array fields to '[]', but a stale/incomplete test
  // fixture or an older cached RPC response should degrade to "no
  // items" rather than crash the whole page -- normalized once here
  // for ALL eight fields consistently, instead of the single field
  // (demo_events) this guard originally covered. That earlier
  // asymmetry meant a future regression in the RPC's own coalesce
  // logic would crash the page via any of the other seven fields the
  // exact same way demo_events was once found to (found in an
  // independent UX review, 2026-09-12).
  const signals = profileQuery.data.signals ?? []
  const notes = profileQuery.data.notes ?? []
  const activities = profileQuery.data.activities ?? []
  const outreach_messages = profileQuery.data.outreach_messages ?? []
  const followups = profileQuery.data.followups ?? []
  const status_history = profileQuery.data.status_history ?? []
  const possible_duplicates = profileQuery.data.possible_duplicates ?? []
  const demo_events = profileQuery.data.demo_events ?? []

  const isTerminalStatus = ['do_not_contact', 'won', 'awaiting_owner_activation', 'tenant_activated'].includes(lead.status)
  const openDemo = demo_events.find((d) => d.scheduled_at && !d.completed_at)

  return (
    <div className="space-y-6">
      <PageHeader
        title={lead.business_name}
        description={[lead.business_type, lead.city, lead.country].filter(Boolean).join(' · ')}
        actions={
          !isTerminalStatus ? (
            <Button
              variant="outline"
              onClick={() => {
                setNewStatus('')
                setStatusReason('')
                setStatusChangeError(null)
                setStatusDialogOpen(true)
              }}
            >
              {t('platform.sales.leadProfile.changeStatusButton')}
            </Button>
          ) : undefined
        }
      />

      <div className="flex items-center gap-2">
        <StatusBadge tone="info" label={t(`platform.sales.pipeline.stage.${lead.status}`)} />
        {lead.current_score != null && (
          <StatusBadge tone={scoreBandTone(lead.current_score_band)} label={`${lead.current_score}/100 · ${t(`platform.sales.leads.scoreBand.${lead.current_score_band}`)}`} />
        )}
      </div>

      {possible_duplicates.length > 0 && (
        <Card className="border-status-warning">
          <CardHeader><CardTitle>{t('platform.sales.leadProfile.possibleDuplicates')}</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-text-secondary">{possible_duplicates.length}</p>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>{t('platform.sales.leadProfile.contact')}</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p><bdi>{lead.public_phone ?? '—'}</bdi></p>
            <p><bdi>{lead.public_email ?? '—'}</bdi></p>
            <p><bdi>{lead.website ?? '—'}</bdi></p>
            <p><bdi>{lead.whatsapp_public_number ?? '—'}</bdi></p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>{t('platform.sales.leadProfile.location')}</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p>{[lead.address, lead.area, lead.city, lead.country].filter(Boolean).join(', ') || '—'}</p>
            <p>{t('platform.sales.leads.columns.rating')}: {lead.rating ?? '—'} ({lead.review_count ?? 0})</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.leadProfile.channels')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {eligibilityQuery.data ? (
            <>
              <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {(
                  [
                    { key: 'email', label: t('platform.sales.leadProfile.channelEmail'), eligible: eligibilityQuery.data.email_eligible, reason: eligibilityQuery.data.email_reason },
                    { key: 'whatsapp', label: t('platform.sales.leadProfile.channelWhatsapp'), eligible: eligibilityQuery.data.whatsapp_eligible, reason: eligibilityQuery.data.whatsapp_reason },
                    { key: 'call_task', label: t('platform.sales.leadProfile.channelCallTask'), eligible: eligibilityQuery.data.call_task_eligible, reason: eligibilityQuery.data.call_task_reason },
                  ] as const
                ).map((c) => (
                  <li key={c.key} className="rounded-md border border-border-subtle p-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{c.label}</span>
                      <StatusBadge tone={c.eligible ? 'success' : 'neutral'} label={c.eligible ? t('platform.sales.leadProfile.channelEligible') : t('platform.sales.leadProfile.channelNotEligible')} />
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">{c.reason}</p>
                  </li>
                ))}
              </ul>
              <p className="text-sm">
                <span className="font-medium">{t('platform.sales.leadProfile.channelRecommended')}:</span>{' '}
                {eligibilityQuery.data.recommended_channel} — <span className="text-text-secondary">{eligibilityQuery.data.recommended_reason}</span>
              </p>
              {eligibilityQuery.data.call_task_eligible && (
                <Button size="sm" variant="outline" onClick={() => createCallTaskMutation.mutate()} disabled={createCallTaskMutation.isPending}>
                  {createCallTaskMutation.isPending ? t('platform.sales.leadProfile.creatingCallTask') : t('platform.sales.leadProfile.createCallTaskButton')}
                </Button>
              )}
            </>
          ) : (
            <p className="text-sm text-text-secondary">{t('common.loading')}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.leadProfile.callTasks')}</CardTitle></CardHeader>
        <CardContent>
          {!callTasksQuery.data || callTasksQuery.data.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.leadProfile.noCallTasks')}</p>
          ) : (
            <ul className="space-y-2">
              {callTasksQuery.data.map((task) => (
                <li key={task.id} className="rounded-md border border-border-subtle p-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span><bdi dir="ltr">{task.phone_number}</bdi></span>
                    <StatusBadge tone={task.status === 'completed' ? 'success' : task.status === 'cancelled' ? 'neutral' : 'info'} label={task.status} />
                  </div>
                  {task.outcome && <p className="mt-1 text-text-secondary">{task.outcome}</p>}
                  {task.status === 'pending' && (
                    <div className="mt-2 flex gap-2">
                      <input
                        className="flex-1 rounded-md border border-border-subtle p-1.5 text-sm"
                        placeholder={t('platform.sales.leadProfile.callTaskOutcomePlaceholder')}
                        value={callOutcomeDrafts[task.id] ?? ''}
                        onChange={(e) => setCallOutcomeDrafts((prev) => ({ ...prev, [task.id]: e.target.value }))}
                      />
                      <Button
                        size="sm"
                        onClick={() => completeCallTaskMutation.mutate(task.id)}
                        disabled={!callOutcomeDrafts[task.id] || completeCallTaskMutation.isPending}
                      >
                        {t('platform.sales.leadProfile.completeCallTaskButton')}
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.leadProfile.events')}</CardTitle></CardHeader>
        <CardContent>
          {!outreachEventsQuery.data || outreachEventsQuery.data.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.leadProfile.noEvents')}</p>
          ) : (
            <ul className="space-y-2">
              {outreachEventsQuery.data.map((ev) => (
                <li key={ev.id} className="rounded-md border border-border-subtle p-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span>{ev.message_channel} · {t(`platform.sales.leadProfile.eventTypeLabels.${ev.event_type}`, ev.event_type)}</span>
                    <FormattedDate value={ev.created_at} timeZone={SALES_DISPLAY_TIMEZONE} className="text-xs text-text-secondary" />
                  </div>
                  {ev.reply_excerpt && <p className="mt-1 whitespace-pre-wrap text-text-secondary">{ev.reply_excerpt}</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('platform.sales.leadProfile.signals')}</CardTitle>
          {lead.website && (
            <Button size="sm" variant="outline" onClick={() => enrichMutation.mutate()} disabled={enrichMutation.isPending}>
              {enrichMutation.isPending ? t('platform.sales.leadProfile.enriching') : t('platform.sales.leadProfile.runEnrichmentButton')}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {enrichMutation.isError && (
            <p role="alert" className="mb-2 text-sm text-status-danger">
              {(enrichMutation.error as { detail?: { error?: string } })?.detail?.error === 'CONFIGURATION_BLOCKED'
                ? t('platform.sales.discover.configurationBlocked')
                : translateSupabaseError(enrichMutation.error, t('platform.sales.leadProfile.enrichmentError'))}
            </p>
          )}
          {enrichMutation.isSuccess && (
            <p className="mb-2 text-sm text-status-success">{t('platform.sales.leadProfile.enrichmentSuccess')}</p>
          )}
          {signals.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.leadProfile.noSignals')}</p>
          ) : (
            <ul className="space-y-2">
              {signals.map((s) => (
                <li key={s.id} className="rounded-md border border-border-subtle p-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{s.signal_key}</span>
                    <StatusBadge tone={s.confidence === 'high' ? 'success' : s.confidence === 'medium' ? 'warning' : 'neutral'} label={s.confidence} />
                  </div>
                  {s.source_url && (
                    <a href={s.source_url} target="_blank" rel="noreferrer" className="text-xs text-accent-foreground hover:underline">
                      {s.source_url}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('platform.sales.leadProfile.score')}</CardTitle>
          <Button size="sm" variant="outline" onClick={() => scoreMutation.mutate()} disabled={scoreMutation.isPending}>
            {t('platform.sales.leadProfile.computeScoreButton')}
          </Button>
        </CardHeader>
        <CardContent>
          {latest_score ? (
            <p className="text-sm">{i18n.language === 'ar' ? latest_score.explanation_ar : latest_score.explanation_en}</p>
          ) : (
            <p className="text-sm text-text-secondary">{t('platform.sales.leadProfile.noScore')}</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.leadProfile.notes')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <textarea
              className="min-h-16 flex-1 rounded-md border border-border-subtle p-2 text-sm"
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              placeholder={t('platform.sales.leadProfile.notePlaceholder')}
            />
            <Button onClick={() => noteMutation.mutate()} disabled={!noteText || noteMutation.isPending}>
              {t('platform.sales.leadProfile.addNoteButton')}
            </Button>
          </div>
          <ul className="space-y-2">
            {notes.map((n) => (
              <li key={n.id} className="border-b border-border-subtle pb-2 text-sm last:border-0">
                <p>{n.note}</p>
                <FormattedDate value={n.created_at} timeZone={SALES_DISPLAY_TIMEZONE} className="text-xs text-text-secondary" />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('platform.sales.leadProfile.outreach')}</CardTitle>
          {!isTerminalStatus && (
            <div className="flex items-center gap-2">
              <Select value={regenMessageType} onValueChange={setRegenMessageType}>
                <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OUTREACH_MESSAGE_TYPES.map((mt) => (
                    <SelectItem key={mt} value={mt}>{t(`platform.sales.leadProfile.outreachMessageType.${mt}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={regenChannel} onValueChange={setRegenChannel}>
                <SelectTrigger className="h-8 w-40 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OUTREACH_CHANNELS.map((c) => (
                    <SelectItem key={c} value={c}>{t(`platform.sales.leadProfile.outreachChannelOptions.${c}`)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={regenLanguage} onValueChange={(v) => setRegenLanguage(v as 'ar' | 'en')}>
                <SelectTrigger className="h-8 w-28 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ar">{t('platform.sales.leadProfile.outreachLanguageOptions.ar')}</SelectItem>
                  <SelectItem value="en">{t('platform.sales.leadProfile.outreachLanguageOptions.en')}</SelectItem>
                </SelectContent>
              </Select>
              <Button size="sm" variant="outline" onClick={() => regenerateMutation.mutate()} disabled={regenerateMutation.isPending}>
                {regenerateMutation.isPending ? t('platform.sales.leadProfile.outreachRegenerating') : t('platform.sales.leadProfile.outreachRegenerateButton')}
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent className="space-y-2">
          {/* AI GENERATES/ASSISTS, OWNER REVIEWS, OWNER AUTHORIZES SEND.
              OWNER DECISION #20 (2026-09-10): channel='whatsapp_message'
              drafts now support in-place Edit (sales_edit_outreach_draft)
              and an explicit Send through Platform WhatsApp
              (sales_queue_platform_whatsapp_message) -- see the two
              action blocks below. Every other channel is unchanged:
              "Regenerate" (above) remains the only way to get a revised
              draft for them; it produces a NEW message through the same
              generation -> quality-gate -> approval flow as any other
              draft, it does not mutate an existing one. */}
          {(approveError || rejectError || queueError || regenerateError || editError) && (
            <p role="alert" className="text-sm text-status-danger">
              {approveError || rejectError || queueError || regenerateError || editError}
            </p>
          )}
          {regenerateMutation.isSuccess && (
            <p className="text-sm text-status-success">{t('platform.sales.leadProfile.outreachRegenerateButton')} ✓</p>
          )}
          {outreach_messages.length === 0 ? (
            <p className="text-sm text-text-secondary">—</p>
          ) : (
            <ul className="space-y-2">
              {outreach_messages.map((m, index) => {
                const isWhatsAppMessage = m.channel === 'whatsapp_message'
                const effectiveBody = m.edited_body ?? m.body
                const senderIdentity = whatsappSenderQuery.data
                const isPlatformWhatsAppConnected = senderIdentity?.status === 'connected'
                return (
                  <li
                    key={m.id}
                    className={`rounded-md border p-2 text-sm ${index === 0 ? 'border-primary/40 bg-primary/5' : 'border-border-subtle'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2">
                        {index === 0 && (
                          <StatusBadge tone="info" label={t('platform.sales.leadProfile.outreachLatestBadge')} />
                        )}
                        {isWhatsAppMessage && <MessageCircle className="size-4 text-status-success" aria-hidden="true" />}
                        <span>
                          {isWhatsAppMessage ? t('platform.sales.leadProfile.outreachChannelOptions.whatsapp_message') : m.channel} · {m.message_type}
                        </span>
                      </span>
                      <StatusBadge
                        tone={m.status === 'sent' || m.status === 'approved' || m.status === 'queued' ? 'success' : m.status === 'failed' || m.status === 'rejected' ? 'danger' : 'info'}
                        label={t(`platform.sales.leadProfile.outreachStatus.${m.status}`, m.status)}
                      />
                    </div>
                    {m.quality_status && (
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <StatusBadge
                          tone={m.quality_status === 'approval_ready' ? 'success' : m.quality_status === 'quality_rejected' ? 'danger' : 'neutral'}
                          label={t(`platform.sales.leadProfile.qualityStatus.${m.quality_status}`, m.quality_status)}
                        />
                        {m.quality_status === 'quality_rejected' && m.quality_gate_result?.rejection_reasons && m.quality_gate_result.rejection_reasons.length > 0 && (
                          <span className="text-xs text-status-danger">
                            {m.quality_gate_result.rejection_reasons.join(', ')}
                          </span>
                        )}
                      </div>
                    )}
                    {m.subject && <p className="mt-1 font-medium">{m.subject}</p>}
                    <p className="text-text-secondary">{effectiveBody.slice(0, 200)}</p>
                    {m.edited_body != null && (
                      <p className="mt-1 text-xs text-text-secondary">{t('platform.sales.leadProfile.outreachEditedBadge')}</p>
                    )}

                    {m.status === 'generated' && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={() => approveMessageMutation.mutate(m.id)}
                          disabled={m.quality_status !== 'approval_ready' || approveMessageMutation.isPending}
                          title={m.quality_status !== 'approval_ready' ? t('platform.sales.leadProfile.qualityStatus.quality_rejected') : undefined}
                        >
                          {approveMessageMutation.isPending ? t('platform.sales.leadProfile.outreachApproving') : t('platform.sales.leadProfile.outreachApproveButton')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => { setRejectDialogFor(m.id); setRejectReason(''); setRejectError(null) }}
                          disabled={rejectMessageMutation.isPending}
                        >
                          {t('platform.sales.leadProfile.outreachRejectButton')}
                        </Button>
                        {isWhatsAppMessage && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => { setEditDialogFor(m.id); setEditBody(effectiveBody); setEditError(null) }}
                          >
                            {t('platform.sales.leadProfile.outreachEditButton')}
                          </Button>
                        )}
                      </div>
                    )}
                    {m.status === 'approved' && m.channel === 'email' && (
                      <div className="mt-2">
                        <Button size="sm" onClick={() => queueMessageMutation.mutate(m.id)} disabled={queueMessageMutation.isPending}>
                          {queueMessageMutation.isPending ? t('platform.sales.leadProfile.outreachQueuing') : t('platform.sales.leadProfile.outreachQueueButton')}
                        </Button>
                      </div>
                    )}
                    {m.status === 'approved' && isWhatsAppMessage && (
                      <div className="mt-2 space-y-2 rounded-md border border-border-subtle bg-surface p-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => { setEditDialogFor(m.id); setEditBody(effectiveBody); setEditError(null) }}
                        >
                          {t('platform.sales.leadProfile.outreachEditButton')}
                        </Button>
                        {whatsappSenderQuery.isLoading ? (
                          <p className="text-xs text-text-secondary">{t('common.loading')}</p>
                        ) : isPlatformWhatsAppConnected ? (
                          <>
                            <p className="text-xs text-text-secondary">
                              {t('platform.sales.leadProfile.outreachSendFrom', { number: senderIdentity?.connected_phone_number ?? '—' })}
                            </p>
                            {/* UX review finding, fixed (2026-09-12): one shared
                                mutation backs every whatsapp_message row's Send
                                button. Disabling on isPending alone froze every
                                OTHER approved draft's Send button too while any
                                single one was in flight, with no explanation --
                                confusing when a lead has more than one approved
                                whatsapp_message draft. Scope the disabled state to
                                THIS row (isPending AND this is the row in flight)
                                so sibling rows stay interactive; the server's own
                                idempotency guard (unique constraint on
                                platform_whatsapp_queue.outreach_message_id) is the
                                real safety net regardless of button state. */}
                            <Button
                              size="sm"
                              onClick={() => sendWhatsAppMutation.mutate(m.id)}
                              disabled={sendWhatsAppMutation.isPending && sendWhatsAppMutation.variables === m.id}
                            >
                              {sendWhatsAppMutation.isPending && sendWhatsAppMutation.variables === m.id
                                ? t('platform.sales.leadProfile.outreachSending')
                                : t('platform.sales.leadProfile.outreachSendButton')}
                            </Button>
                          </>
                        ) : (
                          <div className="space-y-1">
                            <p className="text-xs text-status-danger">
                              {t('platform.sales.leadProfile.outreachWhatsappNotConnected', {
                                status: t(`whatsapp.statusLabels.${senderIdentity?.status ?? 'disconnected'}`, senderIdentity?.status ?? '—'),
                              })}
                            </p>
                            <Link to="/platform/whatsapp" className="text-xs text-accent-foreground hover:underline">
                              {t('platform.sales.leadProfile.outreachGoToWhatsappSettings')}
                            </Link>
                          </div>
                        )}
                        {(() => {
                          const sendError = sendErrors[m.id]
                          if (!sendError) return null
                          return (
                            <div className="space-y-1">
                              <p role="alert" className="text-xs text-status-danger">{sendError.message}</p>
                              {sendError.isNotConnected && (
                                <Link to="/platform/whatsapp" className="text-xs text-accent-foreground hover:underline">
                                  {t('platform.sales.leadProfile.outreachGoToWhatsappSettings')}
                                </Link>
                              )}
                            </div>
                          )
                        })()}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
          <p className="text-xs text-text-secondary">{t('platform.sales.leadProfile.outreachNoEditNotice')}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.leadProfile.followups')}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <FormLabel htmlFor="followup-reason">{t('platform.sales.followups.reasonLabel')}</FormLabel>
              <input id="followup-reason" className="w-full rounded-md border border-border-subtle p-2 text-sm" value={followupReason} onChange={(e) => setFollowupReason(e.target.value)} />
            </div>
            <div>
              <FormLabel htmlFor="followup-date">{t('common.date')}</FormLabel>
              <input id="followup-date" type="datetime-local" className="w-full rounded-md border border-border-subtle p-2 text-sm" value={followupDate} onChange={(e) => setFollowupDate(e.target.value)} />
            </div>
            <Button className="self-end" onClick={() => followupMutation.mutate()} disabled={!followupReason || !followupDate || followupMutation.isPending}>
              {t('platform.sales.leadProfile.scheduleFollowupButton')}
            </Button>
          </div>
          <ul className="space-y-2">
            {followups.map((f) => (
              <li key={f.id} className="flex items-center justify-between border-b border-border-subtle pb-2 text-sm last:border-0">
                <span>{f.reason}</span>
                <FormattedDate value={f.scheduled_at} timeZone={SALES_DISPLAY_TIMEZONE} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('platform.sales.leadProfile.demos')}</CardTitle>
          {!isTerminalStatus && (
            <div className="flex gap-2">
              {openDemo ? (
                <Button
                  size="sm"
                  onClick={() => { setDemoOutcome(''); setDemoCompleteNotes(''); setDemoCompleteError(null); setCompleteDemoOpen(true) }}
                >
                  {t('platform.sales.leadProfile.demoCompleteButton')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => { setDemoScheduledAt(''); setDemoScheduleNotes(''); setDemoScheduleError(null); setScheduleDemoOpen(true) }}
                >
                  {t('platform.sales.leadProfile.demoScheduleButton')}
                </Button>
              )}
            </div>
          )}
        </CardHeader>
        <CardContent>
          {demo_events.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.leadProfile.demoNoDemos')}</p>
          ) : (
            <ul className="space-y-2">
              {demo_events.map((d) => (
                <li key={d.id} className="rounded-md border border-border-subtle p-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span>
                      {t('platform.sales.leadProfile.demoScheduledAt')}: {d.scheduled_at ? <FormattedDate value={d.scheduled_at} timeZone={SALES_DISPLAY_TIMEZONE} /> : '—'}
                    </span>
                    {d.completed_at ? (
                      <StatusBadge
                        tone={d.outcome === 'positive' ? 'success' : d.outcome === 'negative' || d.outcome === 'no_show' ? 'danger' : 'neutral'}
                        label={d.outcome ? t(`platform.sales.leadProfile.demoOutcome.${d.outcome}`, d.outcome) : t('platform.sales.leadProfile.demoCompletedBadge')}
                      />
                    ) : (
                      <StatusBadge tone="info" label={t('platform.sales.leadProfile.demoOpenBadge')} />
                    )}
                  </div>
                  {d.completed_at && (
                    <p className="mt-1 text-xs text-text-secondary">
                      {t('platform.sales.leadProfile.demoCompletedAt')}: <FormattedDate value={d.completed_at} timeZone={SALES_DISPLAY_TIMEZONE} />
                    </p>
                  )}
                  {d.notes && <p className="mt-1 text-text-secondary">{d.notes}</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.leadProfile.statusHistory')}</CardTitle></CardHeader>
        <CardContent>
          {status_history.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.leadProfile.noStatusHistory')}</p>
          ) : (
            <ul className="space-y-2">
              {status_history.map((h, idx) => (
                <li key={idx} className="border-b border-border-subtle pb-2 text-sm last:border-0">
                  <div className="flex items-center justify-between">
                    <span>
                      {t('platform.sales.leadProfile.statusHistoryTransition', {
                        from: h.from_status ? t(`platform.sales.pipeline.stage.${h.from_status}`, h.from_status) : t('platform.sales.leadProfile.statusHistoryNoPreviousStatus'),
                        to: t(`platform.sales.pipeline.stage.${h.to_status}`, h.to_status),
                      })}
                    </span>
                    <FormattedDate value={h.changed_at} timeZone={SALES_DISPLAY_TIMEZONE} className="text-xs text-text-secondary" />
                  </div>
                  {h.reason && <p className="mt-1 text-text-secondary">{h.reason}</p>}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.leadProfile.activity')}</CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {activities.map((a) => (
              <li key={a.id} className="flex items-center justify-between text-sm">
                <span>{a.activity_type}</span>
                <FormattedDate value={a.created_at} timeZone={SALES_DISPLAY_TIMEZONE} className="text-text-secondary" />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{t('platform.sales.leadProfile.convertSection')}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {lead.status === 'tenant_activated' && lead.converted_club_id ? (
            <div className="space-y-2">
              <StatusBadge tone="success" label={t('platform.sales.leadProfile.statusTenantActivated')} />
              <p className="text-sm text-text-secondary">{t('platform.sales.leadProfile.tenantActivatedMessage')}</p>
              <Link to={`/platform/clubs/${lead.converted_club_id}`} className="text-sm text-accent-foreground hover:underline">
                {t('platform.sales.leadProfile.viewClubLink')}
              </Link>
            </div>
          ) : lead.status === 'awaiting_owner_activation' && activation_invite ? (
            <div className="space-y-3">
              <StatusBadge tone="warning" label={t('platform.sales.leadProfile.statusAwaitingActivation')} />
              <p className="text-sm text-text-secondary">
                {t('platform.sales.leadProfile.invitePendingLabel')} <bdi dir="ltr">{activation_invite.owner_email}</bdi>
              </p>
              <p className="text-sm text-text-secondary">
                {t('platform.sales.leadProfile.inviteExpiresLabel')}: <FormattedDate value={activation_invite.expires_at} timeZone={SALES_DISPLAY_TIMEZONE} />
              </p>
              {new Date(activation_invite.expires_at) <= new Date() && (
                <p className="text-sm text-status-danger">{t('platform.sales.leadProfile.inviteExpiredLabel')}</p>
              )}
              {convertError && <p role="alert" className="text-sm text-status-danger">{convertError}</p>}
              <Button variant="outline" onClick={() => resendInviteMutation.mutate()} disabled={resendInviteMutation.isPending}>
                {resendInviteMutation.isPending ? t('platform.sales.leadProfile.resendSending') : t('platform.sales.leadProfile.resendInviteButton')}
              </Button>
              {resendInviteMutation.isSuccess && (
                <p className="text-sm text-status-success">{t('platform.sales.leadProfile.resendSuccess')}</p>
              )}
            </div>
          ) : ['lost', 'do_not_contact', 'won'].includes(lead.status) ? (
            <p className="text-sm text-text-secondary">{t('platform.sales.leadProfile.convertBlocked')}</p>
          ) : (
            <div className="space-y-3">
              <div>
                <FormLabel htmlFor="convert-owner-email">{t('platform.sales.leadProfile.convertOwnerEmailLabel')}</FormLabel>
                <Input id="convert-owner-email" type="email" dir="ltr" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="owner@example.com" />
                <p className="mt-1 text-xs text-text-secondary">{t('platform.sales.leadProfile.convertOwnerEmailHint')}</p>
              </div>
              <div>
                <FormLabel htmlFor="convert-contact-phone">{t('platform.sales.leadProfile.convertContactPhoneLabel')}</FormLabel>
                <Input id="convert-contact-phone" value={convertContactPhone} onChange={(e) => setConvertContactPhone(e.target.value)} />
              </div>
              {convertError && <p role="alert" className="text-sm text-status-danger">{convertError}</p>}
              <Button
                onClick={() => sendInviteMutation.mutate()}
                disabled={!ownerEmail.includes('@') || sendInviteMutation.isPending}
              >
                {sendInviteMutation.isPending ? t('platform.sales.leadProfile.convertSending') : t('platform.sales.leadProfile.convertSendInviteButton')}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {statusDialogOpen && (
        <Dialog open onOpenChange={(open) => { if (!open) setStatusDialogOpen(false) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('platform.sales.leadProfile.changeStatusTitle')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <FormLabel htmlFor="change-status-new-status">{t('platform.sales.leadProfile.changeStatusNewStatusLabel')}</FormLabel>
                <Select value={newStatus} onValueChange={setNewStatus}>
                  <SelectTrigger id="change-status-new-status"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CHANGEABLE_STATUSES.filter((s) => s !== lead.status).map((s) => (
                      <SelectItem key={s} value={s}>{t(`platform.sales.pipeline.stage.${s}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <FormLabel htmlFor="change-status-reason">
                  {t('platform.sales.leadProfile.changeStatusReasonLabel')}
                  {newStatus && REASON_REQUIRED_STATUSES.has(newStatus) ? ' *' : ''}
                </FormLabel>
                <Input
                  id="change-status-reason"
                  value={statusReason}
                  onChange={(e) => setStatusReason(e.target.value)}
                  placeholder={t('platform.sales.leadProfile.changeStatusReasonLabel')}
                />
                <p className="text-xs text-text-secondary">
                  {newStatus && REASON_REQUIRED_STATUSES.has(newStatus)
                    ? t('platform.sales.leadProfile.changeStatusReasonRequiredHint')
                    : t('platform.sales.leadProfile.changeStatusReasonOptionalHint')}
                </p>
              </div>
              {newStatus && CONFIRM_REQUIRED_STATUSES.has(newStatus) && (
                <p className="text-sm text-status-danger">{t('platform.sales.leadProfile.changeStatusConfirmWarning')}</p>
              )}
              {statusChangeError && <p role="alert" className="text-sm text-status-danger">{statusChangeError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setStatusDialogOpen(false)}>{t('common.cancel')}</Button>
                <Button
                  variant={newStatus && CONFIRM_REQUIRED_STATUSES.has(newStatus) ? 'destructive' : 'default'}
                  disabled={
                    !newStatus ||
                    (REASON_REQUIRED_STATUSES.has(newStatus) && !statusReason.trim()) ||
                    changeStatusMutation.isPending
                  }
                  onClick={() => changeStatusMutation.mutate()}
                >
                  {changeStatusMutation.isPending ? t('platform.sales.leadProfile.changeStatusSaving') : t('platform.sales.leadProfile.changeStatusSave')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {scheduleDemoOpen && (
        <Dialog open onOpenChange={(open) => { if (!open) setScheduleDemoOpen(false) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('platform.sales.leadProfile.demoScheduleTitle')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <FormLabel htmlFor="demo-schedule-at">{t('platform.sales.leadProfile.demoScheduleDateLabel')}</FormLabel>
                <input
                  id="demo-schedule-at"
                  type="datetime-local"
                  className="w-full rounded-md border border-border-subtle p-2 text-sm"
                  value={demoScheduledAt}
                  onChange={(e) => setDemoScheduledAt(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <FormLabel htmlFor="demo-schedule-notes">{t('platform.sales.leadProfile.demoScheduleNotesLabel')}</FormLabel>
                <textarea
                  id="demo-schedule-notes"
                  className="min-h-16 w-full rounded-md border border-border-subtle p-2 text-sm"
                  value={demoScheduleNotes}
                  onChange={(e) => setDemoScheduleNotes(e.target.value)}
                />
              </div>
              {demoScheduleError && <p role="alert" className="text-sm text-status-danger">{demoScheduleError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setScheduleDemoOpen(false)}>{t('common.cancel')}</Button>
                <Button disabled={!demoScheduledAt || scheduleDemoMutation.isPending} onClick={() => scheduleDemoMutation.mutate()}>
                  {scheduleDemoMutation.isPending ? t('platform.sales.leadProfile.demoScheduleSaving') : t('platform.sales.leadProfile.demoScheduleSave')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {completeDemoOpen && (
        <Dialog open onOpenChange={(open) => { if (!open) setCompleteDemoOpen(false) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('platform.sales.leadProfile.demoCompleteTitle')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <FormLabel htmlFor="demo-complete-outcome">{t('platform.sales.leadProfile.demoCompleteOutcomeLabel')}</FormLabel>
                <Select value={demoOutcome} onValueChange={setDemoOutcome}>
                  <SelectTrigger id="demo-complete-outcome"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {DEMO_OUTCOMES.map((o) => (
                      <SelectItem key={o} value={o}>{t(`platform.sales.leadProfile.demoOutcome.${o}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex flex-col gap-1">
                <FormLabel htmlFor="demo-complete-notes">{t('platform.sales.leadProfile.demoCompleteNotesLabel')}</FormLabel>
                <textarea
                  id="demo-complete-notes"
                  className="min-h-16 w-full rounded-md border border-border-subtle p-2 text-sm"
                  value={demoCompleteNotes}
                  onChange={(e) => setDemoCompleteNotes(e.target.value)}
                />
              </div>
              {demoCompleteError && <p role="alert" className="text-sm text-status-danger">{demoCompleteError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setCompleteDemoOpen(false)}>{t('common.cancel')}</Button>
                <Button disabled={!demoOutcome || completeDemoMutation.isPending} onClick={() => completeDemoMutation.mutate()}>
                  {completeDemoMutation.isPending ? t('platform.sales.leadProfile.demoCompleteSaving') : t('platform.sales.leadProfile.demoCompleteSave')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {rejectDialogFor && (
        <Dialog open onOpenChange={(open) => { if (!open) setRejectDialogFor(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('platform.sales.leadProfile.outreachRejectTitle')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1">
                <FormLabel htmlFor="reject-reason">{t('platform.sales.leadProfile.outreachRejectReasonLabel')}</FormLabel>
                <Input id="reject-reason" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
              </div>
              {rejectError && <p role="alert" className="text-sm text-status-danger">{rejectError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setRejectDialogFor(null)}>{t('common.cancel')}</Button>
                <Button variant="destructive" disabled={rejectMessageMutation.isPending} onClick={() => rejectMessageMutation.mutate()}>
                  {rejectMessageMutation.isPending ? t('platform.sales.leadProfile.outreachRejecting') : t('platform.sales.leadProfile.outreachRejectButton')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {editDialogFor && (() => {
        // Independent UX review finding (P2), fixed: the dialog
        // previously showed only the effective (possibly-already-
        // edited) text, with no way to see what the AI originally
        // wrote once an edit exists -- the backend already preserves
        // both (edited_body is additive, body is never overwritten,
        // 20260910110000_sales_whatsapp_message_channel_and_edit_
        // tracking.sql), this just surfaces that to the owner too.
        const editingMessage = outreach_messages.find((om) => om.id === editDialogFor)
        const hasPriorEdit = !!editingMessage?.edited_body
        return (
        <Dialog open onOpenChange={(open) => { if (!open) setEditDialogFor(null) }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('platform.sales.leadProfile.outreachEditTitle')}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {hasPriorEdit && editingMessage && (
                <details className="rounded-md border border-border-subtle p-2 text-sm">
                  <summary className="cursor-pointer text-text-secondary">
                    {t('platform.sales.leadProfile.outreachEditShowOriginal')}
                  </summary>
                  <p className="mt-2 whitespace-pre-wrap text-text-secondary">{editingMessage.body}</p>
                </details>
              )}
              <div className="flex flex-col gap-1">
                <FormLabel htmlFor="edit-outreach-body">{t('platform.sales.leadProfile.outreachEditBodyLabel')}</FormLabel>
                <textarea
                  id="edit-outreach-body"
                  className="min-h-40 w-full rounded-md border border-border-subtle p-2 text-sm"
                  value={editBody}
                  onChange={(e) => setEditBody(e.target.value)}
                />
              </div>
              {editError && <p role="alert" className="text-sm text-status-danger">{editError}</p>}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEditDialogFor(null)}>{t('common.cancel')}</Button>
                <Button
                  disabled={!editBody.trim() || editMessageMutation.isPending}
                  onClick={() => editMessageMutation.mutate()}
                >
                  {editMessageMutation.isPending ? t('platform.sales.leadProfile.outreachEditSaving') : t('platform.sales.leadProfile.outreachEditSave')}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
        )
      })()}
    </div>
  )
}
