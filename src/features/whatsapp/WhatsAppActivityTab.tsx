import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
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
interface ActivityRow {
  id: string
  templateKey: string
  status: string
  recipientPhone: string | null
  createdAt: string
  scheduledAt: string
  lastAttemptAt: string | null
  lastError: string | null
  attempts: number
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
    createdAt: r.created_at,
    scheduledAt: r.scheduled_at,
    lastAttemptAt: r.last_attempt_at,
    lastError: r.last_error,
    attempts: r.attempts,
  }))
}

function formatDateTime(iso: string | null, locale: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' })
}

export function WhatsAppActivityTab() {
  const { t, i18n } = useTranslation()
  const { currentClubId } = useAuth()
  const [statusFilter, setStatusFilter] = useState('all')

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['whatsapp-activity', currentClubId, statusFilter],
    queryFn: () => fetchActivity(currentClubId!, statusFilter),
    enabled: !!currentClubId,
    refetchInterval: 15000,
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

      {isLoading && <p className="text-sm text-text-secondary">{t('common.loading')}</p>}
      {!isLoading && rows.length === 0 && (
        <p className="text-sm text-text-secondary">{t('whatsapp.page.activityTab.emptyTitle')}</p>
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
                return (
                  <tr key={r.id} className="border-b border-border">
                    <td className="p-2 font-medium">{templateLabel}</td>
                    <td className="p-2 tabular-nums">{r.recipientPhone ?? '—'}</td>
                    <td className="p-2">
                      <StatusBadge tone={STATUS_TONE[r.status] ?? 'neutral'} label={statusLabel} />
                      {r.status === 'failed' && r.lastError && (
                        <p className="mt-1 text-xs text-status-danger">{r.lastError}</p>
                      )}
                    </td>
                    <td className="p-2 text-xs text-text-secondary">{formatDateTime(r.scheduledAt, i18n.language)}</td>
                    <td className="p-2 text-xs text-text-secondary">
                      {r.lastAttemptAt ? `${formatDateTime(r.lastAttemptAt, i18n.language)} (${r.attempts})` : '—'}
                    </td>
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
