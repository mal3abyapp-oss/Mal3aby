import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Button } from '@/components/ui/button'
import { actionLabel, entityLabel } from '@/lib/domain/audit'

// IA restructuring (Phase 3): two real findings from
// MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md fixed here --
// (1) r.action/r.entity_type were rendered completely raw
// ("platform_suspend_club", "clubs") instead of through a label map,
// unlike every other enum-bearing column in the Platform Owner tier;
// (2) club name was plain text, not a link, inconsistent with every
// sibling screen (Clubs/Owners/Alerts) which link into
// PlatformClubDetailPage -- this was flagged as a dead-end gap.

// Master IA/UX audit (Platform Owner phase, Audit 5): same
// silent-cutoff-at-a-hard-limit issue as PlatformClubsPage -- worse
// here, since this is the security-sensitive audit trail, and a
// hard `.limit(200)` meant the 201st+ sensitive action was
// invisible with no indication anything was cut off. Same
// offset-based "load more" fix.
const PAGE_SIZE = 200

interface AuditRow {
  id: string
  club_id: string | null
  club_name: string | null
  action: string
  entity_type: string
  reason: string | null
  created_at: string
}

async function fetchAudit(offset: number): Promise<{ rows: AuditRow[]; hasMore: boolean }> {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('id, club_id, action, entity_type, reason, created_at, clubs(name_ar)')
    .order('created_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1)

  if (error) throw error
  const rows = (data ?? []).map((row) => ({
    id: row.id,
    club_id: row.club_id,
    club_name: (row.clubs as unknown as { name_ar: string } | null)?.name_ar ?? null,
    action: row.action,
    entity_type: row.entity_type,
    reason: row.reason,
    created_at: row.created_at,
  }))
  return { rows, hasMore: rows.length === PAGE_SIZE }
}

export function PlatformAuditPage() {
  const [pages, setPages] = useState(1)
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['platform-audit', pages],
    queryFn: async () => {
      const results = await Promise.all(Array.from({ length: pages }, (_, i) => fetchAudit(i * PAGE_SIZE)))
      const lastPage = results.at(-1)
      return { rows: results.flatMap((r) => r.rows), hasMore: lastPage?.hasMore ?? false }
    },
  })
  const rows = data?.rows ?? []

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
      <PageHeader title="سجل التدقيق" description="سجل غير قابل للتعديل لكل إجراء حساس على مستوى المنصة" />
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} isLoading={isLoading} emptyTitle="لا يوجد سجل تدقيق بعد" />
      {data?.hasMore && (
        <div className="mt-4 flex justify-center">
          <Button variant="outline" onClick={() => setPages((p) => p + 1)} disabled={isFetching}>
            {isFetching ? 'جارٍ التحميل...' : 'تحميل المزيد'}
          </Button>
        </div>
      )}
    </div>
  )
}
