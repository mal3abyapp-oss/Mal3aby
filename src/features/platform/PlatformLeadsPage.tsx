import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useDirection } from '@/app/providers/DirectionProvider'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

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

async function fetchLeads(): Promise<LeadRow[]> {
  const { data, error } = await supabase.from('contact_requests').select('*').order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
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
  const { data: leads = [], isLoading } = useQuery({ queryKey: ['platform-leads'], queryFn: fetchLeads })

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
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-leads'] }),
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
          <Select value={l.status} onValueChange={(status) => updateStatusMutation.mutate({ id: l.id, status })}>
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
      <DataTable columns={columns} rows={leads} rowKey={(l) => l.id} isLoading={isLoading} emptyTitle={t('platform.leadsPage.emptyTitle')} />
    </div>
  )
}
