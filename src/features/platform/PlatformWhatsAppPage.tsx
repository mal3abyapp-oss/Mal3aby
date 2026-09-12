import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormLabel } from '@/components/ui/form-label'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { ErrorState } from '@/components/ui/error-state'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { translateSupabaseError } from '@/lib/errors'
import { MessageCircle } from 'lucide-react'
import { PlatformWhatsAppSafetyCard } from './PlatformWhatsAppSafetyCard'

// PLATFORM OWNER OPERATIONAL GAP CLOSURE -- Architecture correction:
// Mal3aby's own WhatsApp connection ("PLATFORM WHATSAPP"), strictly
// separate from every club's own whatsapp_accounts row -- see
// supabase/migrations/20260909200000_platform_whatsapp_domain.sql for
// the full schema rationale. This page is deliberately a close mirror
// of WhatsAppConnectionCard.tsx's (club-owner-facing) and
// PlatformClubDetailPage.tsx's PlatformWhatsAppCard (tenant-scoped,
// platform-owner-facing) polling/QR/dialog pattern -- same UX, same
// timeout behavior, same reason-required-disconnect shape -- just
// calling the new parameterless platform_*_own_* RPCs instead of a
// p_club_id-scoped one, since there is exactly one platform account,
// never ambiguous which one.

type PlatformWhatsAppStatus =
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

interface PlatformWhatsAppStatusData {
  status: PlatformWhatsAppStatus
  connectedPhoneNumber: string | null
  connectedAt: string | null
  lastSeenAt: string | null
  lastError: string | null
  qrExpiresAt: string | null
  circuitBreakerOpenUntil: string | null
  lastSuccessfulSendAt: string | null
  restrictionSignalDetectedAt: string | null
  restrictionSignalDetail: string | null
}

const STATUS_TONE: Record<PlatformWhatsAppStatus, StatusTone> = {
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

const DATETIME_FSI = '⁦'
const DATETIME_PDI = '⁩'
function formatDateTime(iso: string | null, locale: 'ar' | 'en'): string {
  if (!iso) return '—'
  const formatted = new Date(iso).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG', { dateStyle: 'medium', timeStyle: 'short' })
  return `${DATETIME_FSI}${formatted}${DATETIME_PDI}`
}

// Same rationale/value as WhatsAppConnectionCard.tsx's own
// QR_WAIT_TIMEOUT_MS -- a healthy connector reaches qr_required well
// within this window; beyond it, show an honest failure state instead
// of an infinite spinner.
const QR_WAIT_TIMEOUT_MS = 20000

async function fetchStatus(): Promise<PlatformWhatsAppStatusData> {
  const { data, error } = await supabase.rpc('platform_get_whatsapp_status')
  if (error) throw error
  const row = data?.[0]
  return {
    status: (row?.status as PlatformWhatsAppStatus) ?? 'disconnected',
    connectedPhoneNumber: row?.connected_phone_number ?? null,
    connectedAt: row?.connected_at ?? null,
    lastSeenAt: row?.last_seen_at ?? null,
    lastError: row?.last_error ?? null,
    qrExpiresAt: row?.qr_expires_at ?? null,
    circuitBreakerOpenUntil: row?.circuit_breaker_open_until ?? null,
    lastSuccessfulSendAt: row?.last_successful_send_at ?? null,
    restrictionSignalDetectedAt: row?.restriction_signal_detected_at ?? null,
    restrictionSignalDetail: row?.restriction_signal_detail ?? null,
  }
}

async function fetchQr(): Promise<string | null> {
  const { data, error } = await supabase.rpc('platform_get_whatsapp_own_qr')
  if (error) throw error
  return data?.[0]?.qr_payload ?? null
}

interface RecentEvent {
  id: string
  event: string
  actor_id: string | null
  actor_name: string | null
  detail: { reason?: string; initiated_by?: string } | null
  created_at: string
}

async function fetchRecentEvents(): Promise<RecentEvent[]> {
  const { data, error } = await supabase.rpc('platform_get_whatsapp_own_recent_events', { p_limit: 10 })
  if (error) throw error
  return (data ?? []) as RecentEvent[]
}

export function PlatformWhatsAppPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const queryClient = useQueryClient()

  const STATUS_LABELS: Record<PlatformWhatsAppStatus, string> = {
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

  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [qrWaitStartedAt, setQrWaitStartedAt] = useState<number | null>(null)
  const [qrTimedOut, setQrTimedOut] = useState(false)
  const [disconnectReason, setDisconnectReason] = useState('')
  const [showDisconnectDialog, setShowDisconnectDialog] = useState(false)
  const [showEvents, setShowEvents] = useState(false)

  const { data: status, isLoading, isError: statusIsError, error: statusError, refetch: refetchStatus } = useQuery({
    queryKey: ['platform-whatsapp-own-status'],
    queryFn: fetchStatus,
    refetchInterval: 5000,
  })

  const currentStatus = status?.status ?? 'disconnected'
  const isQrPending = currentStatus === 'qr_required'
  const isWaitingForConnector = currentStatus === 'connecting' || currentStatus === 'qr_required'

  const { data: qrPayload } = useQuery({
    queryKey: ['platform-whatsapp-own-qr'],
    queryFn: fetchQr,
    enabled: isQrPending && !qrTimedOut,
    refetchInterval: 3000,
  })

  const { data: recentEvents, isLoading: eventsLoading } = useQuery({
    queryKey: ['platform-whatsapp-own-events'],
    queryFn: fetchRecentEvents,
    enabled: showEvents,
  })

  useEffect(() => {
    if (!isWaitingForConnector) {
      setQrWaitStartedAt(null)
      setQrTimedOut(false)
      return
    }
    if (qrDataUrl) {
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
      const { error } = await supabase.rpc('platform_start_whatsapp_own_pairing', {})
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      setQrTimedOut(false)
      setQrWaitStartedAt(Date.now())
      void queryClient.invalidateQueries({ queryKey: ['platform-whatsapp-own-status'] })
    },
    onError: (err) => setActionError(translateSupabaseError(err, t('platform.whatsappPage.startError'))),
  })

  const retryMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('platform_retry_whatsapp_own_connection', {})
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      setQrTimedOut(false)
      setQrWaitStartedAt(Date.now())
      void queryClient.invalidateQueries({ queryKey: ['platform-whatsapp-own-status'] })
      void queryClient.invalidateQueries({ queryKey: ['platform-whatsapp-own-qr'] })
    },
    onError: (err) => setActionError(translateSupabaseError(err, t('platform.whatsappPage.retryError'))),
  })

  const disconnectMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await supabase.rpc('platform_disconnect_whatsapp_own', { p_reason: reason.trim() })
      if (error) throw error
    },
    onSuccess: () => {
      setActionError(null)
      setShowDisconnectDialog(false)
      setDisconnectReason('')
      void queryClient.invalidateQueries({ queryKey: ['platform-whatsapp-own-status'] })
    },
    onError: (err) => setActionError(translateSupabaseError(err, t('platform.whatsappPage.disconnectError'))),
  })

  const testConnectionMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('platform_flag_whatsapp_own_test_connection', { p_reason: 'manual test from Platform WhatsApp page' })
      if (error) throw error
    },
    onSuccess: () => setActionError(null),
    onError: (err) => setActionError(translateSupabaseError(err, t('platform.whatsappPage.testConnectionError'))),
  })

  const canConnect = ['disconnected', 'logged_out', 'failed', 'error', 'restricted'].includes(currentStatus)
  const canRetry = ['failed', 'error'].includes(currentStatus) || qrTimedOut
  const canDisconnect = ['connected', 'reconnecting', 'degraded'].includes(currentStatus)
  const canTest = currentStatus === 'connected'

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('platform.whatsappPage.title')}
        description={t('platform.whatsappPage.description')}
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageCircle className="size-4 text-status-success" />
            {t('platform.whatsappPage.cardTitle')}
          </CardTitle>
          {!isLoading && <StatusBadge tone={STATUS_TONE[currentStatus]} label={STATUS_LABELS[currentStatus]} />}
        </CardHeader>
        <CardContent className="space-y-4">
          {statusIsError && (
            <ErrorState
              message={translateSupabaseError(statusError, t('platform.whatsappPage.loadError'))}
              onRetry={() => void refetchStatus()}
            />
          )}

          {!statusIsError && (
            <>
              <div className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
                <div>
                  <p className="text-text-secondary">{t('platform.whatsappPage.connectedNumber')}</p>
                  <p className="font-medium">
                    <bdi>{status?.connectedPhoneNumber ?? '—'}</bdi>
                  </p>
                </div>
                <div>
                  <p className="text-text-secondary">{t('platform.whatsappPage.connectedSince')}</p>
                  <p className="font-medium">{formatDateTime(status?.connectedAt ?? null, locale)}</p>
                </div>
                <div>
                  <p className="text-text-secondary">{t('platform.whatsappPage.lastSeen')}</p>
                  <p className="font-medium">{formatDateTime(status?.lastSeenAt ?? null, locale)}</p>
                </div>
                <div>
                  <p className="text-text-secondary">{t('platform.whatsappPage.lastSuccessfulSend')}</p>
                  <p className="font-medium">{formatDateTime(status?.lastSuccessfulSendAt ?? null, locale)}</p>
                </div>
              </div>

              {status?.lastError && currentStatus !== 'connected' && (
                <p className="text-sm text-status-danger">
                  {t('platform.whatsappPage.lastErrorLabel')}: {status.lastError}
                </p>
              )}

              {status?.circuitBreakerOpenUntil && new Date(status.circuitBreakerOpenUntil) > new Date() && (
                <p className="text-sm text-status-warning">
                  {t('platform.whatsappPage.circuitBreakerOpen', { until: formatDateTime(status.circuitBreakerOpenUntil, locale) })}
                </p>
              )}

              {/* Ban-protection hardening (2026-09-12): a genuine
                  WhatsApp-side restriction signal was observed (a
                  repeated 403/forbidden disconnect pattern, or a
                  known-shape system-JID risk notice) -- see
                  RestrictionSignalDetector.ts's own doc comment for the
                  evidence bar. This is distinct from the circuit-breaker
                  banner above (which reacts to OUR OWN send-failure
                  rate) -- shown whenever restrictionSignalDetectedAt is
                  set, regardless of current status, since the account
                  may have since been manually reconnected while the
                  evidence is still worth surfacing to the owner. */}
              {status?.restrictionSignalDetectedAt && (
                <p role="alert" className="text-sm text-status-danger">
                  {t('platform.whatsappPage.restrictionSignalDetected', {
                    date: formatDateTime(status.restrictionSignalDetectedAt, locale),
                    detail: status.restrictionSignalDetail ?? '',
                  })}
                </p>
              )}

              {isQrPending && (
                <div className="flex flex-col items-center gap-3 rounded-md border border-border-subtle p-4">
                  {qrDataUrl ? (
                    <img src={qrDataUrl} alt={t('platform.whatsappPage.qrAlt')} className="size-60" />
                  ) : qrTimedOut ? (
                    <p className="text-sm text-status-danger">{t('platform.whatsappPage.qrTimeout')}</p>
                  ) : (
                    <p className="text-sm text-text-secondary">{t('platform.whatsappPage.qrLoading')}</p>
                  )}
                  <p className="text-center text-xs text-text-secondary">{t('platform.whatsappPage.qrInstructions')}</p>
                </div>
              )}

              {actionError && <p role="alert" className="text-sm text-status-danger">{actionError}</p>}

              <div className="flex flex-wrap gap-2">
                {canConnect && (
                  <Button onClick={() => connectMutation.mutate()} disabled={connectMutation.isPending}>
                    {t('platform.whatsappPage.connect')}
                  </Button>
                )}
                {canRetry && (
                  <Button variant="secondary" onClick={() => retryMutation.mutate()} disabled={retryMutation.isPending}>
                    {t('platform.whatsappPage.retry')}
                  </Button>
                )}
                {canTest && (
                  <Button variant="secondary" onClick={() => testConnectionMutation.mutate()} disabled={testConnectionMutation.isPending}>
                    {t('platform.whatsappPage.testConnection')}
                  </Button>
                )}
                {canDisconnect && (
                  <Button
                    variant="destructive"
                    onClick={() => { setActionError(null); setDisconnectReason(''); setShowDisconnectDialog(true) }}
                  >
                    {t('platform.whatsappPage.disconnect')}
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <button
            type="button"
            className="flex w-full items-center justify-between text-start text-sm font-medium"
            onClick={() => setShowEvents((v) => !v)}
            aria-expanded={showEvents}
            aria-controls="platform-whatsapp-recent-events"
          >
            {t('platform.whatsappPage.recentEvents')}
            <span className="text-text-secondary">{showEvents ? '−' : '+'}</span>
          </button>
        </CardHeader>
        {showEvents && (
          <CardContent id="platform-whatsapp-recent-events">
            {eventsLoading && <p className="text-sm text-text-secondary">{t('platform.whatsappPage.eventsLoading')}</p>}
            {!eventsLoading && (recentEvents?.length ?? 0) === 0 && (
              <p className="text-sm text-text-secondary">{t('platform.whatsappPage.noEvents')}</p>
            )}
            {!eventsLoading && recentEvents && recentEvents.length > 0 && (
              <ul className="space-y-2 text-sm">
                {recentEvents.map((ev) => (
                  <li key={ev.id} className="flex items-center justify-between gap-3 border-b border-border-subtle pb-2 last:border-0">
                    <div className="min-w-0">
                      <p className="font-medium">{ev.event}</p>
                      {ev.detail?.reason && <p className="truncate text-xs text-text-secondary">{ev.detail.reason}</p>}
                      {ev.actor_name && <p className="text-xs text-text-secondary">{ev.actor_name}</p>}
                    </div>
                    <span className="shrink-0 text-xs text-text-secondary">{formatDateTime(ev.created_at, locale)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        )}
      </Card>

      <PlatformWhatsAppSafetyCard />

      <Dialog open={showDisconnectDialog} onOpenChange={(open) => { if (!open) setShowDisconnectDialog(false) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('platform.whatsappPage.disconnectDialogTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">{t('platform.whatsappPage.disconnectDialogWarning')}</p>
            <div>
              <FormLabel htmlFor="platform-whatsapp-disconnect-reason">{t('platform.whatsappPage.reasonLabel')}</FormLabel>
              <Input
                id="platform-whatsapp-disconnect-reason"
                value={disconnectReason}
                onChange={(e) => setDisconnectReason(e.target.value)}
                placeholder={t('platform.clubDetailPage.reasonDialog.reasonPlaceholder')}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowDisconnectDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={!disconnectReason.trim() || disconnectMutation.isPending}
              onClick={() => disconnectMutation.mutate(disconnectReason)}
            >
              {t('platform.whatsappPage.confirmDisconnect')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
