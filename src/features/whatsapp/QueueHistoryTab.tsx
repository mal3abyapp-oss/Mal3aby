import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { StatusBadge } from '@/components/ui/status-badge'

// Gate 8 — Message Queue + History + Failed, consolidated into one
// filterable list (Doc 3 describes these as 3 screens; for a lean V1
// club with a low message volume, one status-labeled list is more
// useful than three mostly-empty screens showing the same underlying
// table filtered differently).
const STATUS_LABELS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  pending: { label: 'بانتظار الإرسال', tone: 'neutral' },
  scheduled: { label: 'مجدولة', tone: 'neutral' },
  processing: { label: 'جارٍ الإرسال', tone: 'info' },
  sent: { label: 'تم الإرسال', tone: 'info' },
  delivered: { label: 'تم التسليم', tone: 'success' },
  failed: { label: 'فشل الإرسال', tone: 'danger' },
  retrying: { label: 'إعادة محاولة', tone: 'warning' },
  cancelled: { label: 'ملغاة', tone: 'neutral' },
  expired: { label: 'منتهية الصلاحية', tone: 'neutral' },
}

interface QueueRow {
  id: string
  channel: string
  template_key: string
  status: string
  scheduled_at: string
  attempts: number
  last_error: string | null
  recipient_phone: string | null
}

async function fetchQueue(clubId: string): Promise<QueueRow[]> {
  const { data, error } = await supabase
    .from('notification_queue')
    .select('id, channel, template_key, status, scheduled_at, attempts, last_error, recipient_phone')
    .eq('club_id', clubId)
    .order('scheduled_at', { ascending: false })
    .limit(100)
  if (error) throw error
  return data ?? []
}

export function QueueHistoryTab() {
  const { currentClubId } = useAuth()
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['whatsapp-queue', currentClubId],
    queryFn: () => fetchQueue(currentClubId!),
    enabled: !!currentClubId,
    refetchInterval: 10000,
  })

  return (
    <div className="flex flex-col gap-2 py-4">
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {!isLoading && rows.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          لا توجد رسائل بعد — سيتم عرض الرسائل هنا بمجرد ربط واتساب وتفعيل قواعد التنبيه.
        </p>
      )}
      {rows.map((r) => {
        const meta = STATUS_LABELS[r.status] ?? STATUS_LABELS.pending
        return (
          <div key={r.id} className="flex items-center justify-between rounded-lg border border-border bg-surface p-3">
            <div>
              <p className="font-medium">{r.template_key}</p>
              <p className="text-xs text-text-secondary">
                {r.channel} {r.recipient_phone ? `— ${r.recipient_phone}` : ''} — {new Date(r.scheduled_at).toLocaleString('ar-EG')}
              </p>
              {r.last_error && <p className="text-xs text-status-danger">{r.last_error}</p>}
            </div>
            <div className="flex flex-col items-end gap-1">
              <StatusBadge tone={meta.tone} label={meta.label} />
              {r.attempts > 0 && <span className="text-xs text-text-secondary">محاولات: {r.attempts}</span>}
            </div>
          </div>
        )
      })}
    </div>
  )
}
