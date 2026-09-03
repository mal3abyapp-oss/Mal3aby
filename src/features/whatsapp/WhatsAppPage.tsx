import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LayoutDashboard, Activity, Wifi, Settings as SettingsIcon, ArrowLeft, ArrowRight } from 'lucide-react'
import { useDirection } from '@/app/providers/DirectionProvider'
import { WhatsAppConnectionCard } from './WhatsAppConnectionCard'
import { MessagingSafetyCard } from './MessagingSafetyCard'
import { WhatsAppActivityTab } from './WhatsAppActivityTab'

// IA restructuring (Phase 8): WhatsApp becomes an independent top-level
// module -- per the directive's explicit instruction ("WhatsApp يجب أن
// يصبح Module مستقل بذاته على المستوى الأعلى") and confirmed in the
// audit as a real problem: connection setup, safety controls, and
// (previously nonexistent) message activity were either buried inside
// Settings' "الإشعارات" section or not visible anywhere at all. Module
// has 4 tabs per target IA §2:
//   - نظرة عامة (Overview): connection health at a glance + queue
//     summary -- the "is everything OK" glance a manager checks daily
//   - النشاط (Activity): NEW -- per-message log (WhatsAppActivityTab)
//   - الاتصال (Connection): WhatsAppConnectionCard, moved from Settings
//   - الإعدادات (Settings): MessagingSafetyCard, moved from Settings
// "Independent but connected": full management lives only here; other
// screens (BookingDetailSheet, CustomerDetailDialog) get small
// contextual "sent ✓ / view activity" summaries instead of duplicating
// this module's controls -- WhatsApp reacts to booking/payment events
// as a connected channel, not a silo.
//
// HIGH-ROI UX PASS 01, Priority 1 (design audit finding: "Failed
// permanently: N" was a passive, unexplained number with zero path to
// investigate or act). Tabs state is now lifted here (was an
// uncontrolled Radix Tabs with defaultValue) so the Overview tab's
// failed-count card can jump straight to Activity pre-filtered to
// 'failed' -- turning a dead-end number into a real operational
// exception with a one-click path to the actual messages.

interface QuickHealth {
  status: string
  pendingCount: number
  failedCount: number
}

const STATUS_TONE: Record<string, StatusTone> = {
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

async function fetchQuickHealth(clubId: string): Promise<QuickHealth> {
  const [{ data: statusRows, error: statusError }, { data: diag, error: diagError }] = await Promise.all([
    supabase.rpc('get_whatsapp_status', { p_club_id: clubId }),
    supabase
      .from('whatsapp_queue_diagnostics')
      .select('pending_count, failed_count')
      .eq('club_id', clubId)
      .maybeSingle(),
  ])
  if (statusError) throw statusError
  if (diagError) throw diagError
  return {
    status: statusRows?.[0]?.status ?? 'disconnected',
    pendingCount: diag?.pending_count ?? 0,
    failedCount: diag?.failed_count ?? 0,
  }
}

function OverviewTab({ onReviewFailures }: { onReviewFailures: () => void }) {
  const { t } = useTranslation()
  const { direction } = useDirection()
  const STATUS_LABELS: Record<string, string> = {
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
  // Finding H-2 (frozen production audit): this dashboard card
  // previously destructured only `data, isLoading` -- a failed fetch
  // silently rendered as "Disconnected / 0 pending / 0 failed" (the
  // same fallback values as a genuinely healthy idle queue), the wrong
  // failure mode for the one card meant to show whether WhatsApp is
  // actually working. isError is now surfaced as a compact inline
  // notice in place of the status card's normal content.
  const { data, isLoading, isError } = useQuery({
    queryKey: ['whatsapp-quick-health', currentClubId],
    queryFn: () => fetchQuickHealth(currentClubId!),
    enabled: !!currentClubId,
    refetchInterval: 15000,
  })

  const ArrowIcon = direction === 'rtl' ? ArrowLeft : ArrowRight
  const failedCount = data?.failedCount ?? 0

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('whatsapp.page.overviewTab.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-text-secondary">{t('whatsapp.page.overviewTab.loading')}</p>
        ) : isError ? (
          <p className="text-sm text-status-danger">{t('whatsapp.page.overviewTab.loadError')}</p>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-text-secondary">{t('whatsapp.page.overviewTab.connectionLabel')}</span>
              <StatusBadge
                tone={STATUS_TONE[data?.status ?? 'disconnected'] ?? 'neutral'}
                label={STATUS_LABELS[data?.status ?? 'disconnected'] ?? data?.status ?? '—'}
              />
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-md border border-border p-3">
                <p className="text-xs text-text-secondary">{t('whatsapp.page.overviewTab.pending')}</p>
                <p className="font-medium">{data?.pendingCount ?? 0}</p>
              </div>
              {failedCount > 0 ? (
                <button
                  type="button"
                  onClick={onReviewFailures}
                  className="flex flex-col items-start gap-1 rounded-md border border-status-danger/40 bg-status-danger/5 p-3 text-start transition hover:bg-status-danger/10"
                >
                  <p className="text-xs text-text-secondary">{t('whatsapp.page.overviewTab.failedFinal')}</p>
                  <p className="font-medium text-status-danger">{failedCount}</p>
                  <span className="flex items-center gap-1 text-xs font-medium text-status-danger">
                    {t('whatsapp.page.overviewTab.failedFinalCta')}
                    <ArrowIcon className="size-3" />
                  </span>
                </button>
              ) : (
                <div className="rounded-md border border-border p-3">
                  <p className="text-xs text-text-secondary">{t('whatsapp.page.overviewTab.failedFinal')}</p>
                  <p className="font-medium">0</p>
                </div>
              )}
            </div>
            <p className="text-xs text-text-secondary">
              {t('whatsapp.page.overviewTab.footerHint')}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function WhatsAppPage() {
  const { t } = useTranslation()
  const [tab, setTab] = useState('overview')
  const [activityStatusFilter, setActivityStatusFilter] = useState<string | null>(null)

  function reviewFailures() {
    setActivityStatusFilter('failed')
    setTab('activity')
  }

  return (
    <div>
      <PageHeader title={t('whatsapp.page.title')} description={t('whatsapp.page.description')} />
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="overview">
            <LayoutDashboard className="me-1 size-4" />
            {t('whatsapp.page.tabs.overview')}
          </TabsTrigger>
          <TabsTrigger value="activity">
            <Activity className="me-1 size-4" />
            {t('whatsapp.page.tabs.activity')}
          </TabsTrigger>
          <TabsTrigger value="connection">
            <Wifi className="me-1 size-4" />
            {t('whatsapp.page.tabs.connection')}
          </TabsTrigger>
          <TabsTrigger value="settings">
            <SettingsIcon className="me-1 size-4" />
            {t('whatsapp.page.tabs.settings')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview"><OverviewTab onReviewFailures={reviewFailures} /></TabsContent>
        <TabsContent value="activity">
          <WhatsAppActivityTab initialStatusFilter={activityStatusFilter} onStatusFilterConsumed={() => setActivityStatusFilter(null)} />
        </TabsContent>
        <TabsContent value="connection"><WhatsAppConnectionCard /></TabsContent>
        <TabsContent value="settings"><MessagingSafetyCard /></TabsContent>
      </Tabs>
    </div>
  )
}
