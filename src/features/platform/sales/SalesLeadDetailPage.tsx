// SalesLeadDetailPage -- Sales Intelligence Phase 8 (ADR-054). The rich
// lead profile: overview, contact, location, facility signals with
// source evidence, score explanation, activity timeline, notes,
// outreach history, follow-up schedule, demo status, and conversion
// status. "Convert to Tenant" is deliberately disabled with a
// CONFIGURATION_BLOCKED explanation, per ADR-054's TRUE STOP on the
// identity/ownership model.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { ErrorState } from '@/components/ui/error-state'
import { translateSupabaseError } from '@/lib/errors'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
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
  }
  signals: Array<{ id: string; signal_key: string; confidence: string; evidence: Record<string, unknown>; source_url: string | null; retrieved_at: string }>
  latest_score: { score: number; score_band: string; dimension_breakdown: Record<string, number>; explanation_en: string; explanation_ar: string } | null
  notes: Array<{ id: string; note: string; created_at: string }>
  activities: Array<{ id: string; activity_type: string; detail: Record<string, unknown>; created_at: string }>
  outreach_messages: Array<{ id: string; channel: string; message_type: string; language: string; subject: string | null; body: string; status: string; created_at: string }>
  followups: Array<{ id: string; reason: string; scheduled_at: string; status: string }>
  status_history: Array<{ from_status: string | null; to_status: string; reason: string | null; changed_at: string }>
  possible_duplicates: Array<{ id: string; lead_id_a: string; lead_id_b: string; confidence: string }>
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

  const profileQuery = useQuery({
    queryKey: ['sales-lead-profile', leadId],
    queryFn: () => fetchProfile(leadId!),
    enabled: !!leadId,
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['sales-lead-profile', leadId] })

  const scoreMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_compute_lead_score', { p_lead_id: leadId! })
      if (error) throw error
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

  if (profileQuery.isError) {
    return <ErrorState message={translateSupabaseError(profileQuery.error, t('platform.sales.leadProfile.loadError'))} onRetry={() => profileQuery.refetch()} />
  }

  if (profileQuery.isLoading || !profileQuery.data) {
    return <p className="text-sm text-text-secondary">{t('common.loading')}</p>
  }

  const { lead, signals, latest_score, notes, activities, outreach_messages, followups, possible_duplicates } = profileQuery.data

  return (
    <div className="space-y-6">
      <PageHeader
        title={lead.business_name}
        description={[lead.business_type, lead.city, lead.country].filter(Boolean).join(' · ')}
        actions={
          lead.status !== 'do_not_contact' && lead.status !== 'won' ? (
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
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('platform.sales.leadProfile.signals')}</CardTitle>
        </CardHeader>
        <CardContent>
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
                  {m.subject && <p className="font-medium">{m.subject}</p>}
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

      <Card className="border-status-warning">
        <CardHeader><CardTitle>{t('platform.sales.leadProfile.convertButton')}</CardTitle></CardHeader>
        <CardContent>
          {lead.converted_club_id ? (
            <StatusBadge tone="success" label={t('platform.sales.dashboard.won')} />
          ) : (
            <>
              <Button disabled title={t('platform.sales.leadProfile.convertBlocked')}>
                {t('platform.sales.leadProfile.convertButton')}
              </Button>
              <p className="mt-2 text-sm text-status-warning">{t('platform.sales.leadProfile.convertBlocked')}</p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
