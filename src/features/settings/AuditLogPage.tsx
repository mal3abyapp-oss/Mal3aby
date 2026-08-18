import { useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { formatMoney } from '@/lib/domain/billing'
import { actionLabel, entityLabel } from '@/lib/domain/audit'
import { useDirection } from '@/app/providers/DirectionProvider'

// Gate 13 #60: this screen used to show the raw machine action string
// ("booking.discount.apply"), the raw table name as "الكيان" ("booking"),
// and a raw JSON before/after diff -- unreadable to a non-technical club
// owner, and actor_id was fetched but never even displayed. This maps
// every real write_audit_log() action (enumerated from every migration
// that calls it) to a human sentence, and resolves actor_id to a name.
// Raw JSON is kept, but demoted to an optional "تفاصيل تقنية" section in
// the detail dialog for anyone who still wants it.
//
// IA restructuring (Phase 3): the action/entity label maps moved to
// src/lib/domain/audit.ts so the Platform Owner tier's audit screens
// (previously showing these values completely raw -- see
// MAL3ABY_INFORMATION_ARCHITECTURE_AUDIT.md) share the exact same
// vocabulary instead of a second, independently-maintained map.

function describeAuditLog(
  r: AuditLogRow,
  locale: 'ar' | 'en' = 'ar',
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  const label = actionLabel(r.action, locale)
  const entity = entityLabel(r.entityType, locale)

  // A few actions carry enough in before/after to say something more
  // specific than just the action label -- worth the extra detail since
  // this is exactly the kind of line a suspicious owner reads closely.
  const after = (r.after ?? {}) as Record<string, unknown>
  if (r.action === 'booking.discount.apply' && typeof after.discount_amount === 'number') {
    return t('auditLog.describe.withAmount', { label, amount: formatMoney(after.discount_amount, 'EGP', locale) })
  }
  if ((r.action === 'create_refund' || r.action === 'payment.refund') && typeof after.amount === 'number') {
    return t('auditLog.describe.withAmount', { label, amount: formatMoney(after.amount, 'EGP', locale) })
  }
  if (r.action === 'payment.record' && typeof after.amount === 'number') {
    return t('auditLog.describe.withAmount', { label, amount: formatMoney(after.amount, 'EGP', locale) })
  }
  if (r.action === 'cash_shift.close' && typeof after.variance === 'number') {
    const variance = after.variance
    if (variance === 0) return t('auditLog.describe.exactMatch', { label })
    return t('auditLog.describe.variance', {
      label,
      sign: variance > 0 ? '+' : '',
      amount: formatMoney(variance, 'EGP', locale),
    })
  }

  return t('auditLog.describe.withEntity', { label, entity })
}

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
  actorName: string | null
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

  // actor_id was already selected but never resolved to a name --
  // profiles_select_same_club_staff RLS already allows reading a fellow
  // staff member's profile in the same club (same pattern used for
  // payment-collector attribution in Gate 13 #57).
  const actorIds = [...new Set((data ?? []).map((r) => r.actor_id).filter((id): id is string => !!id))]
  const namesById = new Map<string, string>()
  if (actorIds.length > 0) {
    const { data: actors } = await supabase.from('profiles').select('user_id, full_name').in('user_id', actorIds)
    for (const a of actors ?? []) if (a.full_name) namesById.set(a.user_id, a.full_name)
  }

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
    actorName: r.actor_id ? (namesById.get(r.actor_id) ?? null) : null,
  }))
}

// P1-7 (critical usability fix pass, 2026-08-16): extracted the page
// body into AuditLogSection so SettingsPage can embed it directly under
// a "الأمان وسجل التدقيق" heading instead of duplicating the query/table/
// detail-dialog logic. AuditLogPage stays as a thin standalone wrapper.
export function AuditLogSection() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { locale } = useDirection()
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
      header: t('auditLog.columns.time'),
      render: (r) => <span className="tabular-nums">{new Date(r.createdAt).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}</span>,
    },
    {
      key: 'action',
      header: t('auditLog.columns.action'),
      render: (r) => (
        <button className="text-accent-foreground hover:underline" onClick={() => setSelected(r)}>
          {describeAuditLog(r, locale, t)}
        </button>
      ),
    },
    { key: 'actor', header: t('auditLog.columns.actor'), render: (r) => r.actorName ?? '—' },
    { key: 'reason', header: t('auditLog.columns.reason'), render: (r) => r.reason ?? '—' },
  ]

  return (
    <div>
      <div className="mb-4">
        <Input placeholder={t('auditLog.searchPlaceholder')} value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
      </div>

      <DataTable
        columns={columns}
        rows={logs}
        rowKey={(r) => r.id}
        isLoading={isLoading}
        emptyTitle={t('auditLog.emptyTitle')}
        emptyDescription={t('auditLog.emptyDescription')}
      />

      <Dialog open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected ? describeAuditLog(selected, locale, t) : ''}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="flex flex-col gap-4 text-sm">
              <p className="text-text-secondary">
                {selected.actorName ?? t('auditLog.unknownUser')} — {new Date(selected.createdAt).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}
              </p>
              {selected.reason && <p>{t('auditLog.reasonPrefix')} {selected.reason}</p>}
              <details>
                <summary className="cursor-pointer text-sm text-text-secondary">{t('auditLog.technicalDetails')}</summary>
                <div className="mt-3 grid grid-cols-2 gap-4">
                  <div>
                    <p className="mb-1 font-medium text-text-secondary">{t('auditLog.before')}</p>
                    <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-2 text-xs" dir="ltr">
                      {selected.before ? JSON.stringify(selected.before, null, 2) : '—'}
                    </pre>
                  </div>
                  <div>
                    <p className="mb-1 font-medium text-text-secondary">{t('auditLog.after')}</p>
                    <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 p-2 text-xs" dir="ltr">
                      {selected.after ? JSON.stringify(selected.after, null, 2) : '—'}
                    </pre>
                  </div>
                </div>
              </details>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

export function AuditLogPage() {
  const { t } = useTranslation()
  return (
    <div>
      <PageHeader title={t('auditLog.title')} description={t('auditLog.description')} />
      <AuditLogSection />
    </div>
  )
}
