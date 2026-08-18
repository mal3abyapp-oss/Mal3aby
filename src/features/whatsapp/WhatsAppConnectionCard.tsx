import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
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

// Safe Messaging directive Part M: full account health state set,
// widened to match whatsapp_accounts_status_check (migration
// 20260818050000) -- 'degraded'/'restricted'/'failed' added alongside
// the original 7 states (including 'error', kept for backward
// compatibility with BaileysProvider's existing reconnect-exhausted
// reporting).
type WhatsAppStatus =
  | 'disconnected'
  | 'qr_required'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'degraded'
  | 'logged_out'
  | 'restricted'
  | 'failed'
  | 'error'

interface StatusData {
  status: WhatsAppStatus
  connectedPhoneNumber: string | null
  connectedAt: string | null
  lastSeenAt: string | null
  lastError: string | null
  qrExpiresAt: string | null
}

const STATUS_TONE: Record<WhatsAppStatus, StatusTone> = {
  disconnected: 'neutral',
  qr_required: 'warning',
  connecting: 'warning',
  connected: 'success',
  reconnecting: 'warning',
  degraded: 'warning',
  logged_out: 'danger',
  restricted: 'danger',
  failed: 'danger',
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

function formatDateTime(iso: string | null, locale: 'ar' | 'en'): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG', { dateStyle: 'medium', timeStyle: 'short' })
}

// How long we tolerate "connecting/qr_required with no QR yet" before
// treating it as a real failure rather than a transient wait. This is
// the fix for a real bug found live: the card previously had no
// timeout at all, so if the local whatsapp-connector service is not
// running (or can't reach Supabase), the UI stayed on "جارٍ توليد رمز
// QR..." forever with no way out except a full page reload. The
// connector's own QR TTL is ~60s and its poll interval is a few
// seconds, so a healthy connector reaches qr_required well within this
// window -- 20s is a generous margin, not a race against the real
// pairing flow.
const QR_WAIT_TIMEOUT_MS = 20000

export function WhatsAppConnectionCard() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const STATUS_LABELS: Record<WhatsAppStatus, string> = {
    disconnected: t('whatsapp.statusLabels.disconnected'),
    qr_required: t('whatsapp.statusLabels.qr_required'),
    connecting: t('whatsapp.statusLabels.connecting'),
    connected: t('whatsapp.statusLabels.connected'),
    reconnecting: t('whatsapp.statusLabels.reconnecting'),
    degraded: t('whatsapp.statusLabels.degraded'),
    logged_out: t('whatsapp.statusLabels.logged_out'),
    restricted: t('whatsapp.statusLabels.restricted'),
    failed: t('whatsapp.statusLabels.failed'),
    error: t('whatsapp.statusLabels.error'),
  }
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // Set the moment we start waiting for a real QR (connect click, or a
  // retry). Cleared once a QR actually arrives or the user cancels.
  // Compared against the clock on every status poll tick to decide
  // whether we've waited too long for the connector to respond.
  const [qrWaitStartedAt, setQrWaitStartedAt] = useState<number | null>(null)
  const [qrTimedOut, setQrTimedOut] = useState(false)

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
  const isWaitingForConnector = status?.status === 'connecting' || status?.status === 'qr_required'

  const { data: qrPayload } = useQuery({
    queryKey: ['whatsapp-qr', currentClubId],
    queryFn: () => fetchQr(currentClubId!),
    enabled: !!currentClubId && isQrPending && !qrTimedOut,
    // The QR itself rotates/expires frequently while waiting for a
    // scan (connector-side ~60s TTL) -- poll faster than the general
    // status query specifically while in this state.
    refetchInterval: 3000,
  })

  // Start/stop the wait-timeout clock as we enter/leave the
  // connecting/qr_required states, and re-check on every render tick
  // (driven by the 5s status poll) whether we've exceeded the timeout
  // without ever receiving a real QR payload from the connector.
  useEffect(() => {
    if (!isWaitingForConnector) {
      setQrWaitStartedAt(null)
      setQrTimedOut(false)
      return
    }
    if (qrDataUrl) {
      // A real QR arrived -- no longer "stuck", cancel any pending timeout.
      setQrTimedOut(false)
      return
    }
    if (qrWaitStartedAt === null) {
      setQrWaitStartedAt(Date.now())
      return
    }
    const elapsed = Date.now() - qrWaitStartedAt
    if (elapsed >= QR_WAIT_TIMEOUT_MS) {
      setQrTimedOut(true)
    } else {
      const timer = setTimeout(() => setQrTimedOut(true), QR_WAIT_TIMEOUT_MS - elapsed)
      return () => clearTimeout(timer)
    }
  }, [isWaitingForConnector, qrDataUrl, qrWaitStartedAt])

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
      setQrTimedOut(false)
      setQrWaitStartedAt(Date.now())
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status', currentClubId] })
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : translateSupabaseError(err, t('whatsapp.connectionCard.startError'))),
  })

  // "إعادة المحاولة" after a timeout re-sends the same pairing intent
  // (start_whatsapp_pairing is idempotent -- it just re-flips the row
  // to connecting) and resets the wait clock, rather than requiring a
  // full page reload.
  const retryMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('start_whatsapp_pairing', { p_club_id: currentClubId! })
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      setQrTimedOut(false)
      setQrWaitStartedAt(Date.now())
      queryClient.invalidateQueries({ queryKey: ['whatsapp-status', currentClubId] })
      queryClient.invalidateQueries({ queryKey: ['whatsapp-qr', currentClubId] })
    },
    onError: (err) => setActionError(err instanceof Error ? err.message : translateSupabaseError(err, t('whatsapp.connectionCard.retryError'))),
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
    onError: (err) => setActionError(err instanceof Error ? err.message : translateSupabaseError(err, t('whatsapp.connectionCard.disconnectError'))),
  })

  const currentStatus = status?.status ?? 'disconnected'

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircle className="size-4 text-status-success" />
          {t('whatsapp.connectionCard.title')}
        </CardTitle>
        {!isLoading && <StatusBadge tone={STATUS_TONE[currentStatus]} label={STATUS_LABELS[currentStatus]} />}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading && <p className="text-sm text-text-secondary">{t('whatsapp.connectionCard.loading')}</p>}
        {actionError && <p className="text-sm text-status-danger">{actionError}</p>}
        {!isLoading && status?.lastError && (currentStatus === 'error' || currentStatus === 'failed' || currentStatus === 'restricted' || currentStatus === 'degraded') && (
          <p className="text-sm text-status-danger">{status.lastError}</p>
        )}

        {!isLoading && currentStatus === 'connected' && (
          <div className="flex flex-col gap-3">
            <div className="rounded-md border border-border p-3 text-sm">
              {/* Master IA/UX audit (RTL phase): phone numbers are
                  Latin-digit values embedded directly beside Arabic
                  label text -- <bdi> isolates them from the
                  surrounding bidi context so they can't visually
                  reorder. */}
              <p className="font-medium">{t('whatsapp.connectionCard.connectedNumberPrefix')} <bdi>{status?.connectedPhoneNumber ?? '—'}</bdi></p>
              <p className="text-xs text-text-secondary">{t('whatsapp.connectionCard.connectedSincePrefix')} {formatDateTime(status?.connectedAt ?? null, locale)}</p>
              <p className="text-xs text-text-secondary">{t('whatsapp.connectionCard.lastSeenPrefix')} {formatDateTime(status?.lastSeenAt ?? null, locale)}</p>
            </div>
            <p className="text-sm text-text-secondary">
              {t('whatsapp.connectionCard.autoSendHint')}
            </p>
            <Button variant="outline" size="sm" className="self-start" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
              {t('whatsapp.connectionCard.disconnect')}
            </Button>
          </div>
        )}

        {!isLoading && (currentStatus === 'qr_required' || currentStatus === 'connecting') && (
          <div className="flex flex-col items-center gap-3 text-center">
            {qrDataUrl ? (
              <>
                <img src={qrDataUrl} alt={t('whatsapp.connectionCard.qrAlt')} className="size-60 rounded-md border border-border" />
                <p className="text-sm text-text-secondary">
                  {t('whatsapp.connectionCard.qrInstructions')}
                </p>
                <p className="text-xs text-text-secondary">{t('whatsapp.connectionCard.qrExpiryHint')}</p>
                <Button variant="outline" size="sm" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
                  {t('whatsapp.connectionCard.cancel')}
                </Button>
              </>
            ) : qrTimedOut ? (
              // Honest failure state -- never leave the UI stuck on
              // "generating QR..." forever. This means either the
              // local whatsapp-connector service is not running, or it
              // cannot reach Supabase -- both are real operational
              // problems the connector's own logs must be checked for,
              // not something this screen can fix on its own.
              <>
                <p className="text-sm text-status-danger">
                  {t('whatsapp.connectionCard.timeoutMessage')}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => retryMutation.mutate()} disabled={retryMutation.isPending}>
                    {t('whatsapp.connectionCard.retry')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
                    {t('whatsapp.connectionCard.cancel')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-text-secondary">{t('whatsapp.connectionCard.generatingQr')}</p>
                <Button variant="outline" size="sm" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
                  {t('whatsapp.connectionCard.cancel')}
                </Button>
              </>
            )}
          </div>
        )}

        {!isLoading &&
          (currentStatus === 'disconnected' ||
            currentStatus === 'logged_out' ||
            currentStatus === 'error' ||
            currentStatus === 'failed' ||
            currentStatus === 'restricted') && (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-secondary">
                {currentStatus === 'restricted'
                  ? t('whatsapp.connectionCard.restrictedHint')
                  : t('whatsapp.connectionCard.connectHint')}
              </p>
              <Button size="sm" className="self-start" onClick={() => connectMutation.mutate()} disabled={connectMutation.isPending}>
                {t('whatsapp.connectionCard.connect')}
              </Button>
            </div>
          )}

        {!isLoading && currentStatus === 'reconnecting' && (
          <p className="text-sm text-text-secondary">{t('whatsapp.connectionCard.reconnecting')}</p>
        )}

        {!isLoading && currentStatus === 'degraded' && (
          <p className="text-sm text-text-secondary">{t('whatsapp.connectionCard.degraded')}</p>
        )}
      </CardContent>
    </Card>
  )
}
