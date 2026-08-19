import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

// IA restructuring (Phase 8): the one genuinely NEW screen in the
// WhatsApp module -- the data already existed in notification_queue
// (every booking confirmation, payment receipt, refund notice, etc.
// that has ever been queued for this club), but there was no read-only
// view of it anywhere. Confirmed in the audit as a real gap: staff
// could see aggregate counts (MessagingSafetyCard's diagnostics --
// "6 sent, 1 failed") but never *which* message went to *which*
// customer, or *why* a specific send failed. This tab is that missing
// per-message log -- read-only, no new backend logic, channel fixed to
// 'whatsapp' since this module is WhatsApp-specific.
//
// HIGH-ROI UX PASS 01, Priority 1 + 2 (design audit findings):
// "Failed permanently: N" was a passive number with no drill-down, and
// the Recipient column always showed "—" because notification_queue's
// own recipient_phone column is genuinely never populated in the real
// send flow (confirmed live via direct SQL) -- the real phone/name
// only exist one join away via recipient_customer_id -> customers.
// For the 'failed' status specifically, this tab now calls
// get_whatsapp_failed_messages() (a new RPC, see migration
// 20260819240000) which does that join server-side and also carries
// the linked booking/payment reference for a "view booking" action and
// a real, idempotency-safe retry action
// (retry_failed_whatsapp_message()). Every other status keeps using
// the original direct notification_queue read -- unchanged, lower risk.
interface ActivityRow {
  id: string
  templateKey: string
  status: string
  recipientPhone: string | null
  recipientName: string | null
  createdAt: string
  scheduledAt: string
  lastAttemptAt: string | null
  lastError: string | null
  attempts: number
  referenceType: string | null
}

// Template/status label text lives in i18n resources under
// whatsapp.page.activityTab.templateLabels / .statusLabels (see
// WhatsAppActivityTab render below) -- these keys are the lookup keys,
// not the display text.
const TEMPLATE_LABEL_KEYS = [
  'booking-created',
  'booking-confirmed',
  // Duplicate-message fix (2026-08-18): the merged booking+payment
  // message queued by _create_booking_internal() when a payment is
  // recorded in the same transaction as booking creation -- see
  // whatsapp-connector/src/templates.ts's 'booking-confirmed-paid'.
  'booking-confirmed-paid',
  'booking-cancelled',
  'payment-received',
  'payment-refunded',
  'invoice-created',
] as const

const STATUS_LABEL_KEYS = ['pending', 'retrying', 'sent', 'failed', 'expired', 'cancelled'] as const

const STATUS_LABEL_KEYS_WITH_ALL = ['all', ...STATUS_LABEL_KEYS] as const

const STATUS_TONE: Record<string, StatusTone> = {
  pending: 'neutral',
  retrying: 'warning',
  sent: 'success',
  failed: 'danger',
  expired: 'danger',
  cancelled: 'neutral',
}

async function fetchActivity(clubId: string, status: string): Promise<ActivityRow[]> {
  let query = supabase
    .from('notification_queue')
    .select('id, template_key, status, recipient_phone, created_at, scheduled_at, last_attempt_at, last_error, attempts')
    .eq('club_id', clubId)
    .eq('channel', 'whatsapp')
    .order('created_at', { ascending: false })
    .limit(100)
  if (status !== 'all') {
    query = query.eq('status', status)
  }
  const { data, error } = await query
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    templateKey: r.template_key,
    status: r.status,
    recipientPhone: r.recipient_phone,
    recipientName: null,
    createdAt: r.created_at,
    scheduledAt: r.scheduled_at,
    lastAttemptAt: r.last_attempt_at,
    lastError: r.last_error,
    attempts: r.attempts,
    referenceType: null,
  }))
}

async function fetchFailedActivity(clubId: string): Promise<ActivityRow[]> {
  const { data, error } = await supabase.rpc('get_whatsapp_failed_messages', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    templateKey: r.template_key,
    status: r.status,
    recipientPhone: r.recipient_phone,
    recipientName: r.recipient_name,
    createdAt: r.created_at,
    scheduledAt: r.created_at,
    lastAttemptAt: r.last_attempt_at,
    lastError: r.last_error,
    attempts: r.attempts,
    referenceType: r.reference_type,
  }))
}

function formatDateTime(iso: string | null, locale: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

// Translates a subset of known raw error strings into operational
// language, per the directive's explicit instruction not to invent a
// failure-classification taxonomy the data doesn't support. Anything
// not recognized falls back to showing the raw reason plainly labeled
// -- never a silent generic "failed" with no explanation, but also
// never a fabricated category.
function describeFailure(lastError: string | null, t: (key: string, opts?: Record<string, unknown>) => string): string {
  if (!lastError) return t('whatsapp.page.activityTab.failureReason.generic', { reason: '—' })
  if (/timed out/i.test(lastError)) return t('whatsapp.page.activityTab.failureReason.timeout')
  if (/unknown.*template/i.test(lastError)) return t('whatsapp.page.activityTab.failureReason.unknownTemplate')
  return t('whatsapp.page.activityTab.failureReason.generic', { reason: lastError })
}

export function WhatsAppActivityTab({
  initialStatusFilter,
  onStatusFilterConsumed,
}: {
  initialStatusFilter?: string | null
  onStatusFilterConsumed?: () => void
}) {
  const { t, i18n } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [statusFilter, setStatusFilter] = useState(initialStatusFilter ?? 'all')
  const [retryError, setRetryError] = useState<string | null>(null)

  useEffect(() => {
    if (initialStatusFilter) {
      setStatusFilter(initialStatusFilter)
      onStatusFilterConsumed?.()
    }
    // Only react to a genuine external request to switch filters (e.g.
    // the Overview tab's "review failures" card) -- onStatusFilterConsumed
    // is intentionally excluded from deps so this doesn't re-fire on
    // every parent re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialStatusFilter])

  const isFailedView = statusFilter === 'failed'

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['whatsapp-activity', currentClubId, statusFilter],
    queryFn: () => (isFailedView ? fetchFailedActivity(currentClubId!) : fetchActivity(currentClubId!, statusFilter)),
    enabled: !!currentClubId,
    refetchInterval: 15000,
  })

  const retryMutation = useMutation({
    mutationFn: async (queueId: string) => {
      const { error } = await supabase.rpc('retry_failed_whatsapp_message', { p_queue_id: queueId })
      if (error) throw error
    },
    onSuccess: () => {
      setRetryError(null)
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-activity', currentClubId] })
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-quick-health', currentClubId] })
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : ''
      setRetryError(
        message.includes('no longer valid')
          ? t('whatsapp.page.activityTab.actions.retryInvalidSource')
          : t('whatsapp.page.activityTab.actions.retryError'),
      )
    },
  })

  return (
    <div className="flex flex-col gap-4">
      <div className="w-48">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {STATUS_LABEL_KEYS_WITH_ALL.map((key) => (
              <SelectItem key={key} value={key}>
                {t(`whatsapp.page.activityTab.statusLabels.${key}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {retryError && <p role="alert" className="text-sm text-status-danger">{retryError}</p>}

      {isLoading && <p className="text-sm text-text-secondary">{t('common.loading')}</p>}
      {!isLoading && rows.length === 0 && (
        <p className="text-sm text-text-secondary">
          {isFailedView ? t('whatsapp.page.activityTab.emptyFailed') : t('whatsapp.page.activityTab.emptyTitle')}
        </p>
      )}
      {!isLoading && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-sm">
            <thead>
              <tr className="border-b border-border text-text-secondary">
                <th className="p-2 text-start">{t('whatsapp.page.activityTab.columns.message')}</th>
                <th className="p-2 text-start">{t('whatsapp.page.activityTab.columns.recipient')}</th>
                <th className="p-2 text-start">{t('whatsapp.page.activityTab.columns.status')}</th>
                <th className="p-2 text-start">{t('whatsapp.page.activityTab.columns.timing')}</th>
                <th className="p-2 text-start">{t('whatsapp.page.activityTab.columns.lastAttempt')}</th>
                {isFailedView && <th className="p-2 text-start">{t('whatsapp.page.activityTab.actions.retry')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const templateLabel = (TEMPLATE_LABEL_KEYS as readonly string[]).includes(r.templateKey)
                  ? t(`whatsapp.page.activityTab.templateLabels.${r.templateKey}`)
                  : r.templateKey
                const statusLabel = (STATUS_LABEL_KEYS as readonly string[]).includes(r.status)
                  ? t(`whatsapp.page.activityTab.statusLabels.${r.status}`)
                  : r.status
                const isRetryingThis = retryMutation.isPending && retryMutation.variables === r.id
                return (
                  <tr key={r.id} className="border-b border-border align-top">
                    <td className="p-2 font-medium">{templateLabel}</td>
                    <td className="p-2">
                      {isFailedView ? (
                        <div className="flex flex-col">
                          <span>{r.recipientName ?? t('whatsapp.page.activityTab.unknownCustomer')}</span>
                          <span dir="ltr" className="text-xs tabular-nums text-text-secondary">
                            {r.recipientPhone ?? t('whatsapp.page.activityTab.noPhone')}
                          </span>
                        </div>
                      ) : (
                        <span className="tabular-nums">{r.recipientPhone ?? '—'}</span>
                      )}
                    </td>
                    <td className="p-2">
                      <StatusBadge tone={STATUS_TONE[r.status] ?? 'neutral'} label={statusLabel} />
                      {r.status === 'failed' && r.lastError && (
                        <p className="mt-1 max-w-xs text-xs text-status-danger">{describeFailure(r.lastError, t)}</p>
                      )}
                    </td>
                    <td className="p-2 text-xs text-text-secondary">{formatDateTime(r.scheduledAt, i18n.language)}</td>
                    <td className="p-2 text-xs text-text-secondary">
                      {r.lastAttemptAt
                        ? `${formatDateTime(r.lastAttemptAt, i18n.language)} (${t('whatsapp.page.activityTab.attemptsLabel', { count: r.attempts })})`
                        : '—'}
                    </td>
                    {isFailedView && (
                      <td className="p-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={retryMutation.isPending}
                            onClick={() => retryMutation.mutate(r.id)}
                          >
                            {isRetryingThis ? t('whatsapp.page.activityTab.actions.retrying') : t('whatsapp.page.activityTab.actions.retry')}
                          </Button>
                          {r.referenceType === 'booking' && (
                            <Button size="sm" variant="ghost" asChild>
                              <Link to="/app/bookings">{t('whatsapp.page.activityTab.actions.viewBooking')}</Link>
                            </Button>
                          )}
                          {r.recipientName && (
                            <Button size="sm" variant="ghost" asChild>
                              <Link to="/app/customers">{t('whatsapp.page.activityTab.actions.viewCustomer')}</Link>
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
