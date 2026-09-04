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
import { SALES_DISPLAY_TIMEZONE } from './salesTimeZone'

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
  }>
  followups: Array<{ id: string; reason: string; scheduled_at: string; status: string }>
  status_history: Array<{ from_status: string | null; to_status: string; reason: string | null; changed_at: string }>
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

  const doNotContactMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_change_lead_status', {
        p_lead_id: leadId!,
        p_new_status: 'do_not_contact',
        p_reason: 'marked by platform staff',
      })
      if (error) throw error
    },
    onSuccess: invalidate,
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

  const { lead, signals, latest_score, notes, activities, outreach_messages, followups, possible_duplicates, activation_invite } = profileQuery.data

  return (
    <div className="space-y-6">
      <PageHeader
        title={lead.business_name}
        description={[lead.business_type, lead.city, lead.country].filter(Boolean).join(' · ')}
        actions={
          !['do_not_contact', 'won', 'awaiting_owner_activation', 'tenant_activated'].includes(lead.status) ? (
            <Button variant="outline" onClick={() => doNotContactMutation.mutate()} disabled={doNotContactMutation.isPending}>
              {t('platform.sales.leadProfile.markDoNotContact')}
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
        <CardHeader><CardTitle>{t('platform.sales.leadProfile.outreach')}</CardTitle></CardHeader>
        <CardContent>
          {outreach_messages.length === 0 ? (
            <p className="text-sm text-text-secondary">—</p>
          ) : (
            <ul className="space-y-2">
              {outreach_messages.map((m) => (
                <li key={m.id} className="rounded-md border border-border-subtle p-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span>{m.channel} · {m.message_type}</span>
                    <StatusBadge tone={m.status === 'sent' ? 'success' : m.status === 'failed' || m.status === 'rejected' ? 'danger' : 'info'} label={m.status} />
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
                  <p className="text-text-secondary">{m.body.slice(0, 200)}</p>
                </li>
              ))}
            </ul>
          )}
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
    </div>
  )
}
