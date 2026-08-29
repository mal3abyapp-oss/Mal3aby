import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import { useDirection } from '@/app/providers/DirectionProvider'

// PLATFORM OWNER AUTONOMOUS COMPLETION -- Phase E (2026-08-29): directive
// Section 22 -- "if backend data exists, build a practical read-only
// screen (support user, club, access level, reason, start, expiry, end,
// status)". platform_support_sessions already had every field named;
// only the read RPC and this screen were missing. Never weakens
// support-session isolation or authorization -- purely a read view over
// get_platform_support_session_history(), which is gated server-side the
// same way every other platform-tier read RPC is.

interface SupportSessionRow {
  id: string
  platform_owner_id: string
  platform_owner_email: string | null
  club_id: string
  club_name: string | null
  mode: string
  reason: string | null
  started_at: string
  expires_at: string
  ended_at: string | null
  status: 'active' | 'expired' | 'ended' | string
}

async function fetchSupportHistory(): Promise<SupportSessionRow[]> {
  const { data, error } = await supabase.rpc('get_platform_support_session_history', {})
  if (error) throw error
  return (data ?? []) as SupportSessionRow[]
}

export function PlatformSupportHistoryPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['platform-support-session-history'],
    queryFn: fetchSupportHistory,
  })

  const modeLabel = (mode: string) =>
    mode === 'manage'
      ? t('platform.supportHistoryPage.modeManage')
      : mode === 'view'
        ? t('platform.supportHistoryPage.modeView')
        : mode

  const statusTone = (status: string): 'success' | 'warning' | 'neutral' =>
    status === 'active' ? 'success' : status === 'expired' ? 'warning' : 'neutral'
  const statusLabel = (status: string) =>
    status === 'active'
      ? t('platform.supportHistoryPage.statusActive')
      : status === 'expired'
        ? t('platform.supportHistoryPage.statusExpired')
        : t('platform.supportHistoryPage.statusEnded')

  const columns: DataTableColumn<SupportSessionRow>[] = [
    {
      key: 'supportUser',
      header: t('platform.supportHistoryPage.supportUser'),
      render: (r) => r.platform_owner_email ?? '—',
    },
    {
      key: 'club',
      header: t('platform.supportHistoryPage.club'),
      render: (r) => (
        <Link to={`/platform/clubs/${r.club_id}`} className="text-accent-foreground hover:underline">
          {r.club_name ?? t('platform.supportHistoryPage.clubFallback')}
        </Link>
      ),
    },
    { key: 'mode', header: t('platform.supportHistoryPage.accessLevel'), render: (r) => modeLabel(r.mode) },
    { key: 'reason', header: t('platform.supportHistoryPage.reason'), render: (r) => r.reason ?? '—' },
    {
      key: 'started',
      header: t('platform.supportHistoryPage.started'),
      render: (r) => new Date(r.started_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG'),
    },
    {
      key: 'expires',
      header: t('platform.supportHistoryPage.expires'),
      render: (r) => new Date(r.expires_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG'),
    },
    {
      key: 'ended',
      header: t('platform.supportHistoryPage.ended'),
      render: (r) => (r.ended_at ? new Date(r.ended_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG') : '—'),
    },
    {
      key: 'status',
      header: t('platform.supportHistoryPage.status'),
      render: (r) => <StatusBadge tone={statusTone(r.status)} label={statusLabel(r.status)} />,
    },
  ]

  return (
    <div>
      <PageHeader title={t('platform.supportHistoryPage.title')} description={t('platform.supportHistoryPage.description')} />
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        isLoading={isLoading}
        emptyTitle={t('platform.supportHistoryPage.emptyTitle')}
      />
    </div>
  )
}
