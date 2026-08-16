import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { StatusBadge } from '@/components/ui/status-badge'

// Gate 8 — Diagnostics: connector runtime status, session state,
// connected number, last successful send, last error, pending/failed
// counts, reconnect-required flag. Never exposes secrets (session
// state itself has no RLS SELECT policy at all -- this reads only via
// get_whatsapp_connection_status(), which strips session_secret before
// it ever leaves the database).
interface DiagnosticsData {
  status: string
  connected_phone_number: string | null
  connected_at: string | null
  last_error: string | null
  last_health_check_at: string | null
}

async function fetchDiagnostics(clubId: string): Promise<DiagnosticsData | null> {
  const { data, error } = await supabase.rpc('get_whatsapp_connection_status', { p_club_id: clubId })
  if (error) throw error
  return data?.[0] ?? null
}

async function fetchQueueCounts(clubId: string) {
  const { data, error } = await supabase.from('notification_queue').select('status').eq('club_id', clubId)
  if (error) throw error
  const counts: Record<string, number> = {}
  for (const row of data ?? []) counts[row.status] = (counts[row.status] ?? 0) + 1
  return counts
}

export function DiagnosticsTab() {
  const { currentClubId } = useAuth()
  const { data: diag } = useQuery({
    queryKey: ['whatsapp-diagnostics', currentClubId],
    queryFn: () => fetchDiagnostics(currentClubId!),
    enabled: !!currentClubId,
    refetchInterval: 10000,
  })
  const { data: counts = {} } = useQuery({
    queryKey: ['whatsapp-queue-counts', currentClubId],
    queryFn: () => fetchQueueCounts(currentClubId!),
    enabled: !!currentClubId,
    refetchInterval: 10000,
  })

  const reconnectRequired = diag?.status === 'expired' || diag?.status === 'failed'

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-text-secondary">حالة الاتصال</p>
          <p className="mt-1 font-semibold">{diag?.status ?? 'غير متصل'}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-text-secondary">الرقم المتصل</p>
          <p className="mt-1 font-semibold tabular-nums">{diag?.connected_phone_number ?? '—'}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-text-secondary">آخر فحص صحة</p>
          <p className="mt-1 font-semibold">{diag?.last_health_check_at ? new Date(diag.last_health_check_at).toLocaleString('ar-EG') : '—'}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-text-secondary">رسائل بانتظار الإرسال</p>
          <p className="mt-1 font-semibold tabular-nums">{(counts.pending ?? 0) + (counts.scheduled ?? 0) + (counts.retrying ?? 0)}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-text-secondary">رسائل فاشلة</p>
          <p className="mt-1 font-semibold tabular-nums text-status-danger">{counts.failed ?? 0}</p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-3">
          <p className="text-xs text-text-secondary">إعادة اتصال مطلوبة</p>
          <p className="mt-1">{reconnectRequired ? <StatusBadge tone="danger" label="نعم" /> : <StatusBadge tone="success" label="لا" />}</p>
        </div>
      </div>

      {diag?.last_error && (
        <div className="rounded-lg border border-status-danger/30 bg-status-danger/5 p-3 text-sm text-status-danger">
          آخر خطأ: {diag.last_error}
        </div>
      )}

      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-text-secondary">
        حالة الربط الفعلي بواتساب: EXTERNAL SCAN QA PENDING — البنية الكاملة (خدمة الربط، نموذج الجلسة، الطابور، القوالب، الصلاحيات) جاهزة، وتنتظر مسح رمز QR فعلي من هاتف حقيقي لإتمام الربط.
      </div>
    </div>
  )
}
