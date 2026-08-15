import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'

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
    { key: 'club', header: 'النادي', render: (r) => r.club_name ?? 'مستوى المنصة' },
    { key: 'action', header: 'الإجراء', render: (r) => r.action },
    { key: 'entity', header: 'الكيان', render: (r) => r.entity_type },
    { key: 'reason', header: 'السبب', render: (r) => r.reason ?? '—' },
  ]

  return (
    <div>
      <PageHeader title="سجل التدقيق" description="آخر 200 إجراء حساس على مستوى المنصة (سجل غير قابل للتعديل)" />
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} isLoading={isLoading} emptyTitle="لا يوجد سجل تدقيق بعد" />
    </div>
  )
}
