import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { translateSupabaseError } from '@/lib/errors'
import { MessageCircle } from 'lucide-react'

// WhatsApp re-integration directive, Section 8 ("WhatsApp tab/page in
// the admin area"): disconnected (connect button + instructions),
// qr_pending (with regeneration on expiry), connected (phone number,
// last-seen, disconnect). Reuses the exact QR pattern already used for
// booking check-in QR (PortalQrPage.tsx) -- a raw payload from a
// Supabase RPC rendered client-side via QRCode.toDataURL(), never a
// server-rendered image.
//
// This card only ever writes INTENT (start_whatsapp_pairing() /
// disconnect_whatsapp()) -- the actual Baileys connection is driven by
// the separate local connector service (whatsapp-connector/, task
// #94), which polls for that intent and reports real state back via
// whatsapp_connector_report_status(). This card polls the resulting
// status/QR RPCs to reflect that real state, never simulates it.

type WhatsAppStatus = 'disconnected' | 'qr_required' | 'connecting' | 'connected' | 'reconnecting' | 'logged_out' | 'error'

interface StatusData {
  status: WhatsAppStatus
  connectedPhoneNumber: string | null
  connectedAt: string | null
  lastSeenAt: string | null
  lastError: string | null
  qrExpiresAt: string | null
}

const STATUS_LABELS: Record<WhatsAppStatus, string> = {
  disconnected: 'غير متصل',
  qr_required: 'بانتظار مسح الرمز',
  connecting: 'جارٍ الاتصال...',
  connected: 'متصل',
  reconnecting: 'جارٍ إعادة الاتصال...',
  logged_out: 'تم تسجيل الخروج من الهاتف',
  error: 'حدث خطأ',
}

const STATUS_TONE: Record<WhatsAppStatus, StatusTone> = {
  disconnected: 'neutral',
  qr_required: 'warning',
  connecting: 'warning',
  connected: 'success',
  reconnecting: 'warning',
  logged_out: 'danger',
  error: 'danger',
}

async function fetchStatus(clubId: string): Promise<StatusData> {
  const { data, error } = await supabase.rpc('get_whatsapp_status', { p_club_id: clubId })
  if (error) throw error
  const row = data?.[0]
  return {
    status: (row?.status as WhatsAppStatus) ?? 'disconnected',
    connectedPhoneNumber: row?.connected_phone_number ?? null,
    connectedAt: row?.connected_at ?? null,
    lastSeenAt: row?.last_seen_at ?? null,
    lastError: row?.last_error ?? null,
    qrExpiresAt: row?.qr_expires_at ?? null,
  }
}

async function fetchQr(clubId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('get_whatsapp_qr', { p_club_id: clubId })
  if (error) throw error
  return data?.[0]?.qr_payload ?? null
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('ar-EG', { dateStyle: 'medium', timeStyle: 'short' })
}

export function WhatsAppConnectionCard() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const { data: status, isLoading } = useQuery({
    queryKey: ['whatsapp-status', currentClubId],
    queryFn: () => fetchStatus(currentClubId!),
    enabled: !!currentClubId,
    // Status can change from real WhatsApp-side events (reconnect,
    // logout from phone) that no one in this tab triggered -- poll
    // while the tab is open, same cadence class as other live-state
    // polls in this app.
    refetchInterval: 5000,
  })

  const isQrPending = status?.status === 'qr_required'

  const { data: qrPayload } = useQuery({
    queryKey: ['whatsapp-qr', currentClubId],
    queryFn: () => fetchQr(currentClubId!),
    enabled: !!currentClubId && isQrPending,
    // The QR itself rotates/expires frequently while waiting for a
    // scan (connector-side ~60s TTL) -- poll faster than the general
    // status query specifically while in this state.
    refetchInterval: 3000,
  })

  useEffect(() => {
    if (!qrPayload) {
      setQrDataUrl(null)
      return
    }
    let cancelled = false
    QRCode.toDataURL(qrPayload, { width: 240, margin: 1 }).then((url) => {
      if (!cancelled) setQrDataUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [qrPayload])

  const connectMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('start_whatsapp_pairing', { p_club_id: currentClubId! })
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status', currentClubId] })
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : translateSupabaseError(err, 'تعذّر بدء الاتصال')),
  })

  const disconnectMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('disconnect_whatsapp', { p_club_id: currentClubId! })
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status', currentClubId] })
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : translateSupabaseError(err, 'تعذّر قطع الاتصال')),
  })

  const currentStatus = status?.status ?? 'disconnected'

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircle className="size-4 text-status-success" />
          واتساب
        </CardTitle>
        {!isLoading && <StatusBadge tone={STATUS_TONE[currentStatus]} label={STATUS_LABELS[currentStatus]} />}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
        {actionError && <p className="text-sm text-status-danger">{actionError}</p>}
        {!isLoading && status?.lastError && currentStatus === 'error' && (
          <p className="text-sm text-status-danger">{status.lastError}</p>
        )}

        {!isLoading && currentStatus === 'connected' && (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-border p-3 text-sm">
              <p className="font-medium">الرقم المتصل: {status?.connectedPhoneNumber ?? '—'}</p>
              <p className="text-xs text-text-secondary">متصل منذ: {formatDateTime(status?.connectedAt ?? null)}</p>
              <p className="text-xs text-text-secondary">آخر ظهور: {formatDateTime(status?.lastSeenAt ?? null)}</p>
            </div>
            <p className="text-sm text-text-secondary">
              سيتم إرسال رسائل تأكيد الحجز والدفع تلقائيًا عبر هذا الرقم حسب إعدادات إشعارات واتساب.
            </p>
            <Button variant="outline" size="sm" className="self-start" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
              قطع الاتصال
            </Button>
          </div>
        )}

        {!isLoading && (currentStatus === 'qr_required' || currentStatus === 'connecting') && (
          <div className="flex flex-col items-center gap-3 text-center">
            {qrDataUrl ? (
              <>
                <img src={qrDataUrl} alt="رمز QR لربط واتساب" className="size-60 rounded-md border border-border" />
                <p className="text-sm text-text-secondary">
                  افتح واتساب على هاتفك ← الإعدادات ← الأجهزة المرتبطة ← ربط جهاز، ثم امسح هذا الرمز.
                </p>
                <p className="text-xs text-text-secondary">ينتهي الرمز خلال دقيقة وسيتم تحديثه تلقائيًا.</p>
              </>
            ) : (
              <p className="text-sm text-text-secondary">جارٍ توليد رمز QR...</p>
            )}
            <Button variant="outline" size="sm" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
              إلغاء
            </Button>
          </div>
        )}

        {!isLoading && (currentStatus === 'disconnected' || currentStatus === 'logged_out' || currentStatus === 'error') && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-text-secondary">
              اربط رقم واتساب الخاص بالنادي لإرسال تأكيدات الحجز والدفع والفواتير تلقائيًا للعملاء.
            </p>
            <Button size="sm" className="self-start" onClick={() => connectMutation.mutate()} disabled={connectMutation.isPending}>
              ربط واتساب
            </Button>
          </div>
        )}

        {!isLoading && currentStatus === 'reconnecting' && (
          <p className="text-sm text-text-secondary">انقطع الاتصال مؤقتًا، جارٍ إعادة المحاولة...</p>
        )}
      </CardContent>
    </Card>
  )
}
