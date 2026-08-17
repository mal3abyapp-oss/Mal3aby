import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'

interface TrialRow {
  id: string
  club_id: string
  club_name: string
  start_at: string
  end_at: string
  trial_origin: string | null
  lifecycle_status: string
}

async function fetchTrials(): Promise<TrialRow[]> {
  const { data, error } = await supabase
    .from('platform_subscriptions')
    .select('id, club_id, start_at, end_at, trial_origin, lifecycle_status, clubs(name_ar)')
    .eq('subscription_kind', 'trial')
    .order('start_at', { ascending: false })

  if (error) throw error
  return (data ?? []).map((row) => ({
    id: row.id,
    club_id: row.club_id,
    club_name: (row.clubs as unknown as { name_ar: string } | null)?.name_ar ?? '—',
    start_at: row.start_at,
    end_at: row.end_at,
    trial_origin: row.trial_origin,
    lifecycle_status: row.lifecycle_status,
  }))
}

export function PlatformTrialsPage() {
  const { data: trials = [], isLoading } = useQuery({ queryKey: ['platform-trials'], queryFn: fetchTrials })

  const now = new Date()
  const active = trials.filter((t) => t.lifecycle_status !== 'cancelled' && new Date(t.end_at) > now)
  const expired = trials.filter((t) => t.lifecycle_status !== 'cancelled' && new Date(t.end_at) <= now)
  const cancelled = trials.filter((t) => t.lifecycle_status === 'cancelled')

  const columns: DataTableColumn<TrialRow>[] = [
    {
      key: 'club',
      header: 'النادي',
      // IA restructuring (Phase 3): club name was plain text here,
      // inconsistent with every sibling screen (Clubs/Owners/Alerts)
      // which link into PlatformClubDetailPage -- confirmed dead-end
      // in MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md.
      render: (t) => (
        <Link to={`/platform/clubs/${t.club_id}`} className="text-accent-foreground hover:underline">
          {t.club_name}
        </Link>
      ),
    },
    { key: 'origin', header: 'المصدر', render: (t) => (t.trial_origin === 'automatic' ? 'تلقائي' : 'يدوي') },
    { key: 'start', header: 'البداية', render: (t) => new Date(t.start_at).toLocaleDateString('ar-EG') },
    { key: 'end', header: 'النهاية', render: (t) => new Date(t.end_at).toLocaleDateString('ar-EG') },
    {
      key: 'status',
      header: 'الحالة',
      render: (t) => {
        if (t.lifecycle_status === 'cancelled') return <StatusBadge tone="neutral" label="ملغاة" />
        if (new Date(t.end_at) > now) return <StatusBadge tone="success" label="نشطة" />
        return <StatusBadge tone="danger" label="منتهية" />
      },
    },
  ]

  return (
    <div>
      <PageHeader title="التجارب المجانية" description="جميع التجارب المجانية بدأت على المنصة" />
      <div className="mb-4 grid grid-cols-3 gap-4">
        <StatCard label="نشطة" value={String(active.length)} />
        <StatCard label="منتهية" value={String(expired.length)} />
        <StatCard label="ملغاة" value={String(cancelled.length)} />
      </div>
      <DataTable columns={columns} rows={trials} rowKey={(t) => t.id} isLoading={isLoading} emptyTitle="لا توجد تجارب مجانية بعد" />
    </div>
  )
}
