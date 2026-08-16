import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import { translateSupabaseError } from '@/lib/errors'

// Gate 8 — Connection: QR-code scan pairing, matching real WhatsApp
// Web/Business API pairing patterns. State transitions:
// Disconnected -> Generating QR -> Waiting for Scan -> Authenticating
// -> Connected (or Failed/Expired/Reconnecting).
//
// Honest scope note (see the migration's own comment for the full
// version): this UI drives a REAL, fully-functional state machine and
// audit trail. It does not complete an actual handshake against a real
// WhatsApp account -- that requires external credentials/infrastructure
// (a Meta WhatsApp Business API account, or a self-hosted bridge
// requiring a persistent process and a real phone) that don't exist in
// this project. The "waiting_for_scan" state will not automatically
// advance to "connected" on its own; a real connector implementation
// is the next step once those external prerequisites are available.

interface ConnectionStatus {
  status: string
  connected_phone_number: string | null
  connected_at: string | null
  last_error: string | null
  last_health_check_at: string | null
  pairing_expires_at: string | null
}

const STATUS_LABELS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  disconnected: { label: 'غير متصل', tone: 'neutral' },
  generating_qr: { label: 'جارٍ إنشاء الرمز...', tone: 'warning' },
  waiting_for_scan: { label: 'بانتظار المسح', tone: 'warning' },
  authenticating: { label: 'جارٍ المصادقة...', tone: 'warning' },
  connected: { label: 'متصل', tone: 'success' },
  failed: { label: 'فشل الاتصال', tone: 'danger' },
  expired: { label: 'انتهت صلاحية الرمز', tone: 'danger' },
  reconnecting: { label: 'جارٍ إعادة الاتصال...', tone: 'warning' },
}

async function fetchConnectionStatus(clubId: string): Promise<ConnectionStatus | null> {
  const { data, error } = await supabase.rpc('get_whatsapp_connection_status', { p_club_id: clubId })
  if (error) throw error
  return data?.[0] ?? null
}

export function ConnectionTab() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const { data: connection, isLoading } = useQuery({
    queryKey: ['whatsapp-connection', currentClubId],
    queryFn: () => fetchConnectionStatus(currentClubId!),
    enabled: !!currentClubId,
    refetchInterval: 5000,
  })

  const pairMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('start_whatsapp_pairing', { p_club_id: currentClubId })
      if (error) throw error
      return data?.[0] as { pairing_token: string; expires_at: string } | undefined
    },
    onSuccess: async (row) => {
      setActionError(null)
      if (row?.pairing_token) {
        const url = await QRCode.toDataURL(row.pairing_token, { width: 240, margin: 1 })
        setQrDataUrl(url)
      }
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-connection', currentClubId] })
    },
    onError: (error) => setActionError(translateSupabaseError(error, 'تعذّر بدء الاتصال.')),
  })

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('disconnect_whatsapp', { p_club_id: currentClubId })
      if (error) throw error
    },
    onSuccess: () => {
      setQrDataUrl(null)
      setActionError(null)
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-connection', currentClubId] })
    },
    onError: (error) => setActionError(translateSupabaseError(error, 'تعذّر قطع الاتصال.')),
  })

  const status = connection?.status ?? 'disconnected'
  const statusMeta = STATUS_LABELS[status] ?? STATUS_LABELS.disconnected

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex items-center justify-between rounded-lg border border-border bg-surface p-4">
        <div>
          <p className="text-sm text-text-secondary">حالة الاتصال</p>
          <div className="mt-1"><StatusBadge tone={statusMeta.tone} label={statusMeta.label} /></div>
          {connection?.connected_phone_number && (
            <p className="mt-1 text-sm text-text-secondary tabular-nums">{connection.connected_phone_number}</p>
          )}
          {connection?.last_error && status === 'failed' && (
            <p className="mt-1 text-sm text-status-danger">{connection.last_error}</p>
          )}
        </div>
        {status === 'connected' ? (
          <Button variant="outline" disabled={disconnectMutation.isPending} onClick={() => disconnectMutation.mutate()}>
            {disconnectMutation.isPending ? 'جارٍ قطع الاتصال...' : 'قطع الاتصال'}
          </Button>
        ) : (
          <Button disabled={pairMutation.isPending || isLoading} onClick={() => pairMutation.mutate()}>
            {pairMutation.isPending ? 'جارٍ الإنشاء...' : 'ربط واتساب'}
          </Button>
        )}
      </div>

      {actionError && <p className="text-sm text-status-danger">{actionError}</p>}

      {qrDataUrl && status !== 'connected' && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-surface p-6">
          <img src={qrDataUrl} alt="رمز ربط واتساب" className="size-56" />
          <p className="text-center text-sm text-text-secondary">
            امسح هذا الرمز من تطبيق واتساب على هاتف النادي: الإعدادات ← الأجهزة المرتبطة ← ربط جهاز
          </p>
          <p className="text-xs text-text-secondary/70">صالح لمدة 60 ثانية — اضغط "ربط واتساب" مرة أخرى إذا انتهت صلاحيته</p>
        </div>
      )}

      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-text-secondary">
        ملاحظة: يتطلب إكمال الاتصال الفعلي بواتساب حساب واتساب بزنس API معتمد. تم بناء نموذج الحالة والصلاحيات وسجل التدقيق بالكامل — ربط مزود واتساب فعلي هو الخطوة التالية بعد توفر بيانات الاعتماد.
      </div>
    </div>
  )
}
