// SalesFollowupsPage -- Sales Intelligence Phase 13 (ADR-054). All
// pending follow-ups across every lead, with a Complete action.
//
// SNOOZE FIX (2026-09-18/19, live-verified audit): "Complete" was the
// ONLY action available, and it REQUIRES a real description of what
// was actually done -- there was no honest way to just push a
// follow-up's date out when no real action has happened yet ("call
// back next week"). Confirmed live: every visible follow-up sat
// permanently marked overdue with no way to defer it. sales_snooze_followup()
// (new RPC, migration 20260919000000) moves scheduled_at forward
// without touching status/last_action -- this is not a completion.
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { ErrorState } from '@/components/ui/error-state'
import { EmptyState } from '@/components/ui/empty-state'
import { translateSupabaseError } from '@/lib/errors'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import { FormattedDate } from '@/components/ui/formatted-date'
import { SALES_DISPLAY_TIMEZONE } from './salesTimeZone'
import { Input } from '@/components/ui/input'
import { CalendarCheck } from 'lucide-react'
import { ListLoadingSkeleton } from './ListLoadingSkeleton'

interface Followup {
  followup_id: string
  lead_id: string
  business_name: string
  reason: string
  scheduled_at: string
  is_overdue: boolean
}

async function fetchFollowups(): Promise<Followup[]> {
  const { data, error } = await supabase.rpc('get_pending_followups', { p_limit: 100 })
  if (error) throw error
  return data ?? []
}

function FollowupRow({ followup }: { followup: Followup }) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [lastAction, setLastAction] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [snoozing, setSnoozing] = useState(false)
  const [snoozeDate, setSnoozeDate] = useState('')

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['sales-followups-all'] })

  const completeMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_complete_followup', { p_followup_id: followup.followup_id, p_last_action: lastAction })
      if (error) throw error
    },
    onSuccess: () => {
      setConfirming(false)
      invalidate()
    },
  })

  const snoozeMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('sales_snooze_followup', {
        p_followup_id: followup.followup_id,
        p_new_scheduled_at: new Date(snoozeDate).toISOString(),
      })
      if (error) throw error
    },
    onSuccess: () => {
      setSnoozing(false)
      setSnoozeDate('')
      invalidate()
    },
  })

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link to={`/platform/sales/leads/${followup.lead_id}`} className="font-medium text-accent-foreground hover:underline">
            {followup.business_name}
          </Link>
          <p className="text-sm text-text-secondary">{followup.reason}</p>
        </div>
        <div className="flex items-center gap-2">
          <FormattedDate value={followup.scheduled_at} timeZone={SALES_DISPLAY_TIMEZONE} className="text-sm" />
          {followup.is_overdue && <StatusBadge tone="danger" label={t('platform.sales.dashboard.overdue')} />}
          {confirming ? (
            <div className="flex items-center gap-2">
              <Input
                className="w-40"
                placeholder={t('platform.sales.followups.lastActionLabel')}
                value={lastAction}
                onChange={(e) => setLastAction(e.target.value)}
              />
              <Button size="sm" onClick={() => completeMutation.mutate()} disabled={!lastAction || completeMutation.isPending}>
                {t('common.confirm')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(false)}>{t('common.cancel')}</Button>
            </div>
          ) : snoozing ? (
            <div className="flex items-center gap-2">
              <input
                type="datetime-local"
                className="rounded-md border border-border-subtle p-2 text-sm"
                value={snoozeDate}
                onChange={(e) => setSnoozeDate(e.target.value)}
              />
              <Button size="sm" onClick={() => snoozeMutation.mutate()} disabled={!snoozeDate || snoozeMutation.isPending}>
                {t('common.confirm')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setSnoozing(false)}>{t('common.cancel')}</Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => setSnoozing(true)}>
                {t('platform.sales.followups.snoozeButton')}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>
                {t('platform.sales.followups.completeButton')}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export function SalesFollowupsPage() {
  const { t } = useTranslation()
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ['sales-followups-all'], queryFn: fetchFollowups })

  return (
    <div className="space-y-6">
      <PageHeader title={t('platform.sales.followups.title')} description={t('platform.sales.followups.description')} />

      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('platform.sales.followups.loadError'))} onRetry={() => refetch()} />
      ) : isLoading ? (
        <ListLoadingSkeleton />
      ) : (data ?? []).length === 0 ? (
        <EmptyState icon={CalendarCheck} title={t('platform.sales.followups.emptyTitle')} />
      ) : (
        <div className="space-y-3">
          {(data ?? []).map((f) => (
            <FollowupRow key={f.followup_id} followup={f} />
          ))}
        </div>
      )}
    </div>
  )
}
