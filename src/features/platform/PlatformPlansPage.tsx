import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { MoneyDisplay } from '@/components/ui/money-display'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'

interface PlanRow {
  id: string
  name_ar: string
  billing_interval: string
  billing_interval_count: number
  price: number
  currency: string
  is_public: boolean
  display_order: number
}

async function fetchPlans(): Promise<PlanRow[]> {
  const { data, error } = await supabase.from('platform_plans').select('*').order('display_order')
  if (error) throw error
  return data ?? []
}

const INTERVAL_LABEL: Record<string, string> = { month: 'شهر', year: 'سنة' }

export function PlatformPlansPage() {
  const queryClient = useQueryClient()
  const { data: plans = [], isLoading } = useQuery({ queryKey: ['platform-plans-all'], queryFn: fetchPlans })

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isPublic }: { id: string; isPublic: boolean }) => {
      const { error } = await supabase.rpc('set_plan_publish_status', { p_plan_id: id, p_is_public: !isPublic })
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-plans-all'] }),
  })

  const columns: DataTableColumn<PlanRow>[] = [
    { key: 'name', header: 'الخطة', render: (p) => p.name_ar },
    {
      key: 'interval',
      header: 'المدة',
      render: (p) => `${p.billing_interval_count} ${INTERVAL_LABEL[p.billing_interval] ?? p.billing_interval}`,
    },
    { key: 'price', header: 'السعر', render: (p) => <MoneyDisplay amount={Number(p.price)} currency={p.currency} size="sm" /> },
    {
      key: 'public',
      header: 'النشر',
      render: (p) => (p.is_public ? <StatusBadge tone="success" label="منشورة" /> : <StatusBadge tone="neutral" label="غير منشورة" />),
    },
    {
      key: 'actions',
      header: '',
      render: (p) => (
        <Button size="sm" variant="outline" onClick={() => toggleMutation.mutate({ id: p.id, isPublic: p.is_public })}>
          {p.is_public ? 'إلغاء النشر' : 'نشر'}
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader title="الخطط" description="إدارة خطط اشتراك المنصة" />
      <DataTable columns={columns} rows={plans} rowKey={(p) => p.id} isLoading={isLoading} emptyTitle="لا توجد خطط" />
    </div>
  )
}
