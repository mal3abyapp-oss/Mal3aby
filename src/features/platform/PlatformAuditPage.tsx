import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { actionLabel, entityLabel } from '@/lib/domain/audit'

// IA restructuring (Phase 3): two real findings from
// MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md fixed here --
// (1) r.action/r.entity_type were rendered completely raw
// ("platform_suspend_club", "clubs") instead of through a label map,
// unlike every other enum-bearing column in the Platform Owner tier;
// (2) club name was plain text, not a link, inconsistent with every
// sibling screen (Clubs/Owners/Alerts) which link into
// PlatformClubDetailPage -- this was flagged as a dead-end gap.

interface AuditRow {
  id: string
  club_id: string | null
  club_name: string | null
  action: string
  entity_type: string
  reason: string | null
  created_at: string
}

async function fetchAudit(): Promise<AuditRow[]> {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('id, club_id, action, entity_type, reason, created_at, clubs(name_ar)')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) throw error
  return (data ?? []).map((row) => ({
    id: row.id,
    club_id: row.club_id,
    club_name: (row.clubs as unknown as { name_ar: string } | null)?.name_ar ?? null,
    action: row.action,
    entity_type: row.entity_type,
    reason: row.reason,
    created_at: row.created_at,
  }))
}

export function PlatformAuditPage() {
  const { data: rows = [], isLoading } = useQuery({ queryKey: ['platform-audit'], queryFn: fetchAudit })

  const columns: DataTableColumn<AuditRow>[] = [
    { key: 'time', header: 'الوقت', render: (r) => new Date(r.created_at).toLocaleString('ar-EG') },
    {
      key: 'club',
      header: 'النادي',
      render: (r) =>
        r.club_id ? (
          <Link to={`/platform/clubs/${r.club_id}`} className="text-accent-foreground hover:underline">
            {r.club_name ?? 'نادٍ'}
          </Link>
        ) : (
          'مستوى المنصة'
        ),
    },
    { key: 'action', header: 'الإجراء', render: (r) => actionLabel(r.action) },
    { key: 'entity', header: 'الكيان', render: (r) => entityLabel(r.entity_type) },
    { key: 'reason', header: 'السبب', render: (r) => r.reason ?? '—' },
  ]

  return (
    <div>
      <PageHeader title="سجل التدقيق" description="آخر 200 إجراء حساس على مستوى المنصة (سجل غير قابل للتعديل)" />
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} isLoading={isLoading} emptyTitle="لا يوجد سجل تدقيق بعد" />
    </div>
  )
}
