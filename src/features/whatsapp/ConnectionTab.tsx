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

  // Gate 8 (per the WhatsApp QR Connector directive): the real QR comes
  // from the connector service's actual Baileys socket, reached via the
  // whatsapp-bridge Edge Function -- never from a value invented in the
  // browser or in Postgres. start_whatsapp_pairing() (an RPC) only
  // records the *attempt* + authorization check; the bridge is what
  // actually starts the connector's real WebSocket connection and
  // fetches the real QR payload it received back from WhatsApp.
  const pairMutation = useMutation({
    mutationFn: async () => {
      const { error: rpcError } = await supabase.rpc('start_whatsapp_pairing', { p_club_id: currentClubId as string })
      if (rpcError) throw rpcError

      const { data: connectData, error: connectError } = await supabase.functions.invoke('whatsapp-bridge', {
        body: { clubId: currentClubId, action: 'connect' },
      })
      if (connectError) throw connectError
      if (connectData?.error === 'connector_not_configured') {
        throw new Error('CONNECTOR_NOT_CONFIGURED')
      }

      // Poll the bridge for the real QR the connector received from
      // WhatsApp -- generation is asynchronous on the connector side
      // (it needs to open the socket and wait for WhatsApp's own QR
      // event), so this is a short poll, not a single fetch.
      for (let attempt = 0; attempt < 15; attempt++) {
        const { data: qrData } = await supabase.functions.invoke('whatsapp-bridge', {
          body: { clubId: currentClubId, action: 'qr' },
        })
        if (qrData?.qr) return qrData.qr as string
        await new Promise((r) => setTimeout(r, 1000))
      }
      throw new Error('QR_TIMEOUT')
    },
    onSuccess: async (rawQr) => {
      setActionError(null)
      const url = await QRCode.toDataURL(rawQr, { width: 240, margin: 1 })
      setQrDataUrl(url)
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-connection', currentClubId] })
    },
    onError: (error) => {
      if (error instanceof Error && error.message === 'CONNECTOR_NOT_CONFIGURED') {
        setActionError('خدمة الاتصال بواتساب غير مُفعّلة على هذا الخادم بعد. راجع دليل whatsapp-connector للنشر.')
        return
      }
      if (error instanceof Error && error.message === 'QR_TIMEOUT') {
        setActionError('انتهت مهلة انتظار رمز QR — حاول مرة أخرى.')
        return
      }
      setActionError(translateSupabaseError(error, 'تعذّر بدء الاتصال.'))
    },
  })

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const { error: rpcError } = await supabase.rpc('disconnect_whatsapp', { p_club_id: currentClubId as string })
      if (rpcError) throw rpcError
      // Best-effort: also tell the connector service to actually log
      // out the real session. If the connector isn't reachable, the DB
      // side is still correctly marked disconnected (rpc above), so
      // this failing doesn't leave the UI lying about connection state.
      await supabase.functions.invoke('whatsapp-bridge', { body: { clubId: currentClubId, action: 'disconnect' } }).catch(() => null)
    },
    onSuccess: () => {
      setQrDataUrl(null)
      setActionError(null)
      void queryClient.invalidateQueries({ queryKey: ['whatsapp-connection', currentClubId] })
    },
    onError: (error) => setActionError(translateSupabaseError(error, 'تعذّر قطع الاتصال.')),
  })

  const status = connection?.status ?? 'disconnected'
  const statusMeta = STATUS_LABELS[status] ?? { label: status, tone: 'neutral' as const }

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
        ملاحظة: يستخدم هذا الاتصال خدمة ربط واتساب حقيقية (WhatsApp Multi-Device عبر Baileys) — الرمز المعروض أعلاه، عند ظهوره، هو رمز QR فعلي صادر من خوادم واتساب. يتطلب نشر خدمة الربط (whatsapp-connector) على خادم دائم وربطها بهذه الدالة قبل ظهور الرمز في بيئة الإنتاج.
      </div>
    </div>
  )
}
