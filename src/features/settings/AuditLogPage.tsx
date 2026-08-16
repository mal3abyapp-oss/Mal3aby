import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// Audit Log Viewer -- RLS already restricts visibility to club_owner/
// club_manager (own club) and branch_manager (own branch), per
// RLS_MATRIX.md -- this screen adds no additional client-side filtering
// of *which* rows are visible, only search/sort over what RLS already
// returned. See docs/DECISIONS.md ADR-020 (immutable, no edit UI exists
// here by design).
interface AuditLogRow {
  id: string
  action: string
  entityType: string
  entityId: string | null
  before: unknown
  after: unknown
  reason: string | null
  createdAt: string
  actorId: string | null
}

async function fetchAuditLogs(clubId: string, search: string) {
  let query = supabase
    .from('audit_logs')
    .select('id, action, entity_type, entity_id, before, after, reason, created_at, actor_id')
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })
    .limit(100)

  if (search.trim()) {
    query = query.ilike('action', `%${search}%`)
  }

  const { data, error } = await query
  if (error) throw error
  return (data ?? []).map<AuditLogRow>((r) => ({
    id: r.id,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    before: r.before,
    after: r.after,
    reason: r.reason,
    createdAt: r.created_at,
    actorId: r.actor_id,
  }))
}

// P1-7 (critical usability fix pass, 2026-08-16): extracted the page
// body into AuditLogSection so SettingsPage can embed it directly under
// a "الأمان وسجل التدقيق" heading instead of duplicating the query/table/
// detail-dialog logic. AuditLogPage stays as a thin standalone wrapper.
export function AuditLogSection() {
  const { currentClubId } = useAuth()
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<AuditLogRow | null>(null)

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['audit-logs', currentClubId, search],
    queryFn: () => fetchAuditLogs(currentClubId!, search),
    enabled: !!currentClubId,
  })

  const columns: DataTableColumn<AuditLogRow>[] = [
    {
      key: 'time',
      header: 'الوقت',
      render: (r) => <span className="tabular-nums">{new Date(r.createdAt).toLocaleString('ar-EG')}</span>,
    },
    {
      key: 'action',
      header: 'الإجراء',
      render: (r) => (
        <button className="text-accent-foreground hover:underline" onClick={() => setSelected(r)}>
          {r.action}
        </button>
      ),
    },
    { key: 'entity', header: 'الكيان', render: (r) => r.entityType },
    { key: 'reason', header: 'السبب', render: (r) => r.reason ?? '—' },
  ]

  return (
    <div>
      <div className="mb-4">
        <Input placeholder="بحث بنوع الإجراء" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
      </div>

      <DataTable
        columns={columns}
        rows={logs}
        rowKey={(r) => r.id}
        isLoading={isLoading}
        emptyTitle="لا يوجد سجلات"
        emptyDescription="ستظهر الإجراءات الحساسة هنا فور حدوثها"
      />

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.action}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="flex flex-col gap-4 text-sm">
              <p className="text-text-secondary">
                {selected.entityType} — {new Date(selected.createdAt).toLocaleString('ar-EG')}
              </p>
              {selected.reason && <p>السبب: {selected.reason}</p>}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="mb-1 font-medium text-text-secondary">قبل</p>
                  <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-2 text-xs" dir="ltr">
                    {selected.before ? JSON.stringify(selected.before, null, 2) : '—'}
                  </pre>
                </div>
                <div>
                  <p className="mb-1 font-medium text-text-secondary">بعد</p>
                  <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-2 text-xs" dir="ltr">
                    {selected.after ? JSON.stringify(selected.after, null, 2) : '—'}
                  </pre>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function AuditLogPage() {
  return (
    <div>
      <PageHeader title="سجل التدقيق" description="سجل غير قابل للتعديل لكل الإجراءات الحساسة" />
      <AuditLogSection />
    </div>
  )
}
