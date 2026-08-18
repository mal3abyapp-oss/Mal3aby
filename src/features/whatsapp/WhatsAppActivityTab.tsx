import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
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

const TEMPLATE_LABELS: Record<string, string> = {
  'booking-created': 'إنشاء حجز',
  'booking-confirmed': 'تأكيد حجز',
  // Duplicate-message fix (2026-08-18): the merged booking+payment
  // message queued by _create_booking_internal() when a payment is
  // recorded in the same transaction as booking creation -- see
  // whatsapp-connector/src/templates.ts's 'booking-confirmed-paid'.
  'booking-confirmed-paid': 'تأكيد حجز مع الدفع',
  'booking-cancelled': 'إلغاء حجز',
  'payment-received': 'استلام دفعة',
  'payment-refunded': 'استرداد دفعة',
  'invoice-created': 'إصدار فاتورة',
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'قيد الانتظار',
  retrying: 'إعادة محاولة',
  sent: 'أُرسلت',
  failed: 'فشلت نهائيًا',
  expired: 'منتهية الصلاحية',
  cancelled: 'أُلغيت',
}

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

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' })
}

export function WhatsAppActivityTab() {
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
            <SelectItem value="all">كل الحالات</SelectItem>
            <SelectItem value="sent">أُرسلت</SelectItem>
            <SelectItem value="pending">قيد الانتظار</SelectItem>
            <SelectItem value="retrying">إعادة محاولة</SelectItem>
            <SelectItem value="failed">فشلت نهائيًا</SelectItem>
            <SelectItem value="expired">منتهية الصلاحية</SelectItem>
            <SelectItem value="cancelled">أُلغيت</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {!isLoading && rows.length === 0 && (
        <p className="text-sm text-text-secondary">لا توجد رسائل واتساب في هذا النطاق بعد.</p>
      )}
      {!isLoading && rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-start text-sm">
            <thead>
              <tr className="border-b border-border text-text-secondary">
                <th className="p-2 text-start">الرسالة</th>
                <th className="p-2 text-start">المستلم</th>
                <th className="p-2 text-start">الحالة</th>
                <th className="p-2 text-start">التوقيت</th>
                <th className="p-2 text-start">آخر محاولة</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border">
                  <td className="p-2 font-medium">{TEMPLATE_LABELS[r.templateKey] ?? r.templateKey}</td>
                  <td className="p-2 tabular-nums">{r.recipientPhone ?? '—'}</td>
                  <td className="p-2">
                    <StatusBadge tone={STATUS_TONE[r.status] ?? 'neutral'} label={STATUS_LABELS[r.status] ?? r.status} />
                    {r.status === 'failed' && r.lastError && (
                      <p className="mt-1 text-xs text-status-danger">{r.lastError}</p>
                    )}
                  </td>
                  <td className="p-2 text-xs text-text-secondary">{formatDateTime(r.scheduledAt)}</td>
                  <td className="p-2 text-xs text-text-secondary">
                    {r.lastAttemptAt ? `${formatDateTime(r.lastAttemptAt)} (${r.attempts})` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
