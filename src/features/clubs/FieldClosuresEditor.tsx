import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { StatusBadge } from '@/components/ui/status-badge'
import { translateSupabaseError } from '@/lib/errors'
import { toInstant, fromInstant, formatInstant } from '@/lib/domain/time'
import { useDirection } from '@/app/providers/DirectionProvider'
import { useClubTimezone } from '@/features/bookings/useFieldPricing'
import { useAuth } from '@/app/providers/AuthProvider'

// BOOKINGS/FIELDS PRODUCTION ACCEPTANCE, D8 / Section 32 gap closure:
// create_field_block (and the new delete_field_block) have been fully
// implemented, permission/module/branch-gated, and audited server-side
// since an earlier phase -- but had zero UI anywhere in the product.
// A club genuinely could not close a field for maintenance, weather,
// a private event, or a holiday through the actual app. This editor
// mirrors PricingEditor.tsx's exact structure (list existing rows with
// delete, a form to add a new one) since it's the closest existing
// pattern for "manage a list of dated field-scoped records."
//
// Deliberately NOT built: recurring/repeating closures, a calendar
// picker UI, or any new backend capability beyond the one small
// delete RPC this phase also added -- matches the directive's "only
// obvious, bounded, low-risk" scope for a Section 32 gap.

const BLOCK_TYPES = ['maintenance', 'weather', 'private_event', 'manual', 'holiday'] as const

interface FieldBlockRow {
  id: string
  startAt: string
  endAt: string
  type: (typeof BLOCK_TYPES)[number]
  reason: string | null
}

async function fetchFieldBlocks(fieldId: string): Promise<FieldBlockRow[]> {
  const { data, error } = await supabase
    .from('field_blocks')
    .select('id, start_at, end_at, type, reason')
    .eq('field_id', fieldId)
    .order('start_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    startAt: r.start_at,
    endAt: r.end_at,
    type: r.type as FieldBlockRow['type'],
    reason: r.reason,
  }))
}

export function FieldClosuresEditor({ fieldId }: { fieldId: string }) {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const queryClient = useQueryClient()
  const { currentClubId } = useAuth()
  // Fetched here (not threaded down as a prop from FieldsManagement) --
  // this component only mounts when the Closures tab is actually
  // selected, so the query only runs when genuinely needed.
  const { data: clubTimezone } = useClubTimezone(currentClubId)

  const { data: blocks = [], isLoading } = useQuery({
    queryKey: ['field-blocks', fieldId],
    queryFn: () => fetchFieldBlocks(fieldId),
  })

  // BOOKINGS/FIELDS ACCEPTANCE, real defect found + fixed this phase:
  // clubTimezone loads asynchronously (a separate useQuery), so it is
  // `undefined` on the very first render or two. An earlier version of
  // this component computed `todayLocal` from it and called
  // `useState`/`useMutation` AFTER an `if (!clubTimezone) return ...`
  // early return -- a real Rules-of-Hooks violation (the hook COUNT
  // differs between the "still loading" render and the "resolved"
  // render). React's own hook-order mismatch detection throws in that
  // exact situation; live-reproduced this session as a genuine,
  // intermittent, unexplained navigation away from /app/fields
  // shortly after the timezone query resolved -- traced all the way
  // down to this exact bug via an isolated A/B code-revert test
  // before finding it here. Fixed: every hook call now happens
  // unconditionally, in the same order, every render; the "still
  // loading the club timezone" case is handled by falling back to a
  // safe default (UTC) for the one date computation that needs it,
  // never by skipping a hook.
  const todayLocal = fromInstant(new Date(), clubTimezone ?? 'UTC').date
  const [date, setDate] = useState(todayLocal)
  const [startTime, setStartTime] = useState('08:00')
  const [endTime, setEndTime] = useState('23:00')
  const [type, setType] = useState<(typeof BLOCK_TYPES)[number]>('maintenance')
  const [reason, setReason] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [conflictNotice, setConflictNotice] = useState<number | null>(null)

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!clubTimezone) throw new Error('club timezone not loaded yet')
      const startAt = toInstant(date, startTime, clubTimezone)
      const endAt = toInstant(date, endTime, clubTimezone)
      const { data, error } = await supabase.rpc('create_field_block', {
        p_field_id: fieldId,
        p_start_at: startAt,
        p_end_at: endAt,
        p_type: type,
        p_reason: reason.trim() || undefined,
      })
      if (error) throw error
      return data?.[0]
    },
    onSuccess: (data) => {
      setFormError(null)
      setReason('')
      setConflictNotice(data?.conflicting_booking_ids?.length ?? 0)
      void queryClient.invalidateQueries({ queryKey: ['field-blocks', fieldId] })
      void queryClient.invalidateQueries({ queryKey: ['fields-active-blocks'] })
    },
    onError: (error) => setFormError(translateSupabaseError(error, t('clubs.fieldClosures.addError'))),
  })

  const deleteMutation = useMutation({
    mutationFn: async (blockId: string) => {
      const { error } = await supabase.rpc('delete_field_block', { p_block_id: blockId, p_reason: 'Closure removed' })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['field-blocks', fieldId] })
      void queryClient.invalidateQueries({ queryKey: ['fields-active-blocks'] })
    },
  })

  const now = new Date()

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-secondary">{t('clubs.fieldClosures.hint')}</p>

      {(isLoading || !clubTimezone) && <p className="text-sm text-text-secondary">{t('clubs.fieldClosures.loading')}</p>}

      {!isLoading && clubTimezone && blocks.length === 0 && (
        <p className="rounded-md bg-muted/50 p-2 text-sm text-text-secondary">{t('clubs.fieldClosures.empty')}</p>
      )}

      {clubTimezone && blocks.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-sm">
          {blocks.map((b) => {
            const isPast = new Date(b.endAt) < now
            return (
              <div key={b.id} className="flex items-center justify-between gap-2 border-b border-border py-1.5 last:border-0 last:pb-0">
                <div className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t(`clubs.fieldClosures.types.${b.type}`)}</span>
                    {isPast && <StatusBadge tone="neutral" label={t('clubs.fieldClosures.past')} />}
                  </div>
                  <span dir="ltr" className="text-xs tabular-nums text-text-secondary">
                    {formatInstant(b.startAt, clubTimezone, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }, locale)}
                    {' — '}
                    {formatInstant(b.endAt, clubTimezone, { hour: '2-digit', minute: '2-digit' }, locale)}
                  </span>
                  {b.reason && <span className="text-xs text-text-secondary">{b.reason}</span>}
                </div>
                <button
                  type="button"
                  className="shrink-0 text-xs text-status-danger hover:underline"
                  onClick={() => deleteMutation.mutate(b.id)}
                  disabled={deleteMutation.isPending}
                >
                  {t('clubs.fieldClosures.delete')}
                </button>
              </div>
            )
          })}
        </div>
      )}

      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <label className="text-sm font-medium text-text-secondary">{t('clubs.fieldClosures.addLabel')}</label>
        <Input type="date" value={date} min={todayLocal} onChange={(e) => { setDate(e.target.value); setFormError(null); setConflictNotice(null) }} />
        <div className="flex gap-2">
          <Input type="time" value={startTime} onChange={(e) => { setStartTime(e.target.value); setFormError(null) }} />
          <Input type="time" value={endTime} onChange={(e) => { setEndTime(e.target.value); setFormError(null) }} />
        </div>
        <Select value={type} onValueChange={(v) => setType(v as (typeof BLOCK_TYPES)[number])}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {BLOCK_TYPES.map((bt) => (
              <SelectItem key={bt} value={bt}>{t(`clubs.fieldClosures.types.${bt}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder={t('clubs.fieldClosures.reasonPlaceholder')}
          value={reason}
          onChange={(e) => { setReason(e.target.value); setFormError(null) }}
        />
        <Button
          size="sm"
          disabled={!date || startTime >= endTime || !clubTimezone || createMutation.isPending}
          onClick={() => createMutation.mutate()}
        >
          {createMutation.isPending ? t('clubs.fieldClosures.adding') : t('clubs.fieldClosures.add')}
        </Button>
        {startTime >= endTime && <p role="alert" className="text-xs text-status-danger">{t('clubs.fieldClosures.startBeforeEndError')}</p>}
        {formError && <p role="alert" className="text-sm text-status-danger">{formError}</p>}
        {conflictNotice != null && conflictNotice > 0 && (
          <p role="alert" className="rounded-md bg-status-warning/10 p-2 text-xs text-status-warning">
            {t('clubs.fieldClosures.conflictWarning', { count: conflictNotice })}
          </p>
        )}
      </div>
    </div>
  )
}
