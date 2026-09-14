import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { translateSupabaseError } from '@/lib/errors'

interface LeadRow {
  id: string
  name: string
  phone: string
  email: string | null
  business_name: string | null
  message: string | null
  status: string
  created_at: string
}

// P3 fix: this had no LIMIT at all, so it was silently truncated at
// PostgREST's own default max_rows=1000 with no way to tell. Full
// server-side pagination (à la PlatformClubsPage's search_platform_clubs
// RPC) is a larger change than this fix warrants for what has always
// been a small, internal contact-request inbox; instead this adds an
// explicit high limit plus truncation detection (fetch LEADS_LIMIT + 1
// rows, and if more than LEADS_LIMIT come back, the list is known-
// truncated and the extra row is dropped before returning).
const LEADS_LIMIT = 1000

async function fetchLeads(): Promise<{ rows: LeadRow[]; truncated: boolean }> {
  const { data, error } = await supabase
    .from('contact_requests')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(LEADS_LIMIT + 1)
  if (error) throw error
  const rows = data ?? []
  const truncated = rows.length > LEADS_LIMIT
  return { rows: truncated ? rows.slice(0, LEADS_LIMIT) : rows, truncated }
}

const STATUS_TONE: Record<string, 'info' | 'warning' | 'success' | 'neutral'> = {
  new: 'info',
  contacted: 'warning',
  converted: 'success',
  closed: 'neutral',
}

export function PlatformLeadsPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const queryClient = useQueryClient()
  // Finding H-2 (frozen production audit): this list previously
  // destructured only `data = [], isLoading` -- a failed fetch silently
  // rendered as "no leads" via DataTable's own empty state,
  // indistinguishable from a genuinely empty inbox. isError/error/
  // refetch are now surfaced so a fetch failure shows an explicit
  // error.
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ['platform-leads'], queryFn: fetchLeads })
  const leads = data?.rows ?? []
  const truncated = data?.truncated ?? false
  // Acceptance-sweep fix (2026-08-30): this mutation had no onError at
  // all -- a failed status update (RLS rejection, network blip) left
  // the Select silently reverting to the stale server value on the
  // next refetch with zero indication anything went wrong, the sole
  // mutation on this page (and one of very few in the whole Platform
  // Owner console) with no error surfacing.
  const [statusError, setStatusError] = useState<string | null>(null)

  const statusLabel: Record<string, string> = {
    new: t('platform.leadsPage.statusLabels.new'),
    contacted: t('platform.leadsPage.statusLabels.contacted'),
    converted: t('platform.leadsPage.statusLabels.converted'),
    closed: t('platform.leadsPage.statusLabels.closed'),
  }

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase.from('contact_requests').update({ status }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => {
      setStatusError(null)
      void queryClient.invalidateQueries({ queryKey: ['platform-leads'] })
    },
    onError: () => setStatusError(t('platform.leadsPage.statusUpdateError')),
  })

  const columns: DataTableColumn<LeadRow>[] = [
    { key: 'name', header: t('platform.leadsPage.columns.name'), render: (l) => l.name },
    { key: 'phone', header: t('platform.leadsPage.columns.phone'), render: (l) => <bdi>{l.phone}</bdi> },
    // Master IA/UX audit (Platform Owner phase, Audit 5): email and
    // message were fetched via `select('*')` but never rendered in any
    // column -- a lead's actual inquiry text was invisible here, only
    // reachable by querying the DB directly. Message is shown truncated
    // with the full text in a native title tooltip (no expandable-row
    // component exists yet in this DataTable, and building one is out
    // of scope for this fix).
    { key: 'email', header: t('platform.leadsPage.columns.email'), render: (l) => (l.email ? <bdi>{l.email}</bdi> : '—') },
    { key: 'business', header: t('platform.leadsPage.columns.business'), render: (l) => l.business_name ?? '—' },
    {
      key: 'message',
      header: t('platform.leadsPage.columns.message'),
      render: (l) =>
        l.message ? (
          <span className="block max-w-[16rem] truncate" title={l.message}>
            {l.message}
          </span>
        ) : (
          '—'
        ),
    },
    { key: 'date', header: t('platform.leadsPage.columns.date'), render: (l) => new Date(l.created_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
    {
      key: 'status',
      header: t('platform.leadsPage.columns.status'),
      render: (l) => (
        <div className="flex items-center gap-2">
          <StatusBadge tone={STATUS_TONE[l.status] ?? 'neutral'} label={statusLabel[l.status] ?? l.status} />
          <Select value={l.status} onValueChange={(status) => { setStatusError(null); updateStatusMutation.mutate({ id: l.id, status }) }}>
            <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(statusLabel).map(([key, label]) => (
                <SelectItem key={key} value={key}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ),
    },
  ]

  return (
    <div>
      <PageHeader title={t('platform.leadsPage.title')} description={t('platform.leadsPage.description')} />
      {truncated && (
        <p className="mb-3 rounded-md bg-status-warning/10 p-2 text-sm text-status-warning">
          {t('platform.leadsPage.truncatedWarning', { count: LEADS_LIMIT })}
        </p>
      )}
      {statusError && <p role="alert" className="mb-3 text-sm text-status-danger">{statusError}</p>}
      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('platform.leadsPage.loadError'))} onRetry={() => void refetch()} />
      ) : (
        <DataTable columns={columns} rows={leads} rowKey={(l) => l.id} isLoading={isLoading} emptyTitle={t('platform.leadsPage.emptyTitle')} />
      )}
    </div>
  )
}
