import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
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

const STATUS_LABEL: Record<string, string> = { new: 'جديد', contacted: 'تم التواصل', converted: 'تم التحويل', closed: 'مغلق' }
const STATUS_TONE: Record<string, 'info' | 'warning' | 'success' | 'neutral'> = {
  new: 'info',
  contacted: 'warning',
  converted: 'success',
  closed: 'neutral',
}

export function PlatformLeadsPage() {
  const queryClient = useQueryClient()
  const { data: leads = [], isLoading } = useQuery({ queryKey: ['platform-leads'], queryFn: fetchLeads })

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const { error } = await supabase.from('contact_requests').update({ status }).eq('id', id)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-leads'] }),
  })

  const columns: DataTableColumn<LeadRow>[] = [
    { key: 'name', header: 'الاسم', render: (l) => l.name },
    { key: 'phone', header: 'الهاتف', render: (l) => <bdi>{l.phone}</bdi> },
    // Master IA/UX audit (Platform Owner phase, Audit 5): email and
    // message were fetched via `select('*')` but never rendered in any
    // column -- a lead's actual inquiry text was invisible here, only
    // reachable by querying the DB directly. Message is shown truncated
    // with the full text in a native title tooltip (no expandable-row
    // component exists yet in this DataTable, and building one is out
    // of scope for this fix).
    { key: 'email', header: 'البريد الإلكتروني', render: (l) => (l.email ? <bdi>{l.email}</bdi> : '—') },
    { key: 'business', header: 'النشاط', render: (l) => l.business_name ?? '—' },
    {
      key: 'message',
      header: 'الرسالة',
      render: (l) =>
        l.message ? (
          <span className="block max-w-[16rem] truncate" title={l.message}>
            {l.message}
          </span>
        ) : (
          '—'
        ),
    },
    { key: 'date', header: 'التاريخ', render: (l) => new Date(l.created_at).toLocaleDateString('ar-EG') },
    {
      key: 'status',
      header: 'الحالة',
      render: (l) => (
        <div className="flex items-center gap-2">
          <StatusBadge tone={STATUS_TONE[l.status] ?? 'neutral'} label={STATUS_LABEL[l.status] ?? l.status} />
          <Select value={l.status} onValueChange={(status) => updateStatusMutation.mutate({ id: l.id, status })}>
            <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {Object.entries(STATUS_LABEL).map(([key, label]) => (
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
      <PageHeader title="طلبات التواصل" description="العملاء المحتملون من موقع ملعبي العام" />
      <DataTable columns={columns} rows={leads} rowKey={(l) => l.id} isLoading={isLoading} emptyTitle="لا توجد طلبات تواصل بعد" />
    </div>
  )
}
