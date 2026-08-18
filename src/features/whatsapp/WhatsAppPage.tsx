import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LayoutDashboard, Activity, Wifi, Settings as SettingsIcon } from 'lucide-react'
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

function OverviewTab() {
  const { t } = useTranslation()
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
  const { data, isLoading } = useQuery({
    queryKey: ['whatsapp-quick-health', currentClubId],
    queryFn: () => fetchQuickHealth(currentClubId!),
    enabled: !!currentClubId,
    refetchInterval: 15000,
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('whatsapp.page.overviewTab.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-text-secondary">{t('whatsapp.page.overviewTab.loading')}</p>
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
              <div className="rounded-md border border-border p-3">
                <p className="text-xs text-text-secondary">{t('whatsapp.page.overviewTab.failedFinal')}</p>
                <p className={`font-medium ${(data?.failedCount ?? 0) > 0 ? 'text-status-danger' : ''}`}>{data?.failedCount ?? 0}</p>
              </div>
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
  return (
    <div>
      <PageHeader title={t('whatsapp.page.title')} description={t('whatsapp.page.description')} />
      <Tabs defaultValue="overview">
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
        <TabsContent value="overview"><OverviewTab /></TabsContent>
        <TabsContent value="activity"><WhatsAppActivityTab /></TabsContent>
        <TabsContent value="connection"><WhatsAppConnectionCard /></TabsContent>
        <TabsContent value="settings"><MessagingSafetyCard /></TabsContent>
      </Tabs>
    </div>
  )
}
