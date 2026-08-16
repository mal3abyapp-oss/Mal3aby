import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { MoneyDisplay } from '@/components/ui/money-display'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

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

  // V1 Implementation Gap Audit (2026-08-16): platform_plans has full
  // CRUD RLS for platform_owner (platform_plans_platform_owner_full_access,
  // cmd=ALL) but the UI only ever offered a publish/unpublish toggle --
  // no way to actually change a plan's price or name without the
  // Supabase dashboard, despite the table's own DB comment describing
  // editing as an expected operation ("editing never retroactively
  // changes an already-created platform_subscriptions row").
  const [editingPlan, setEditingPlan] = useState<PlanRow | null>(null)
  const [editName, setEditName] = useState('')
  const [editPrice, setEditPrice] = useState('')

  const toggleMutation = useMutation({
    mutationFn: async ({ id, isPublic }: { id: string; isPublic: boolean }) => {
      const { error } = await supabase.rpc('set_plan_publish_status', { p_plan_id: id, p_is_public: !isPublic })
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-plans-all'] }),
  })

  const updatePlanMutation = useMutation({
    mutationFn: async () => {
      if (!editingPlan) throw new Error('no plan selected')
      const { error } = await supabase
        .from('platform_plans')
        .update({ name_ar: editName, price: Number(editPrice) })
        .eq('id', editingPlan.id)
      if (error) throw error
    },
    onSuccess: () => {
      setEditingPlan(null)
      void queryClient.invalidateQueries({ queryKey: ['platform-plans-all'] })
    },
  })

  const columns: DataTableColumn<PlanRow>[] = [
    {
      key: 'name',
      header: 'الخطة',
      render: (p) => (
        <button
          className="text-accent-foreground hover:underline"
          onClick={() => {
            setEditingPlan(p)
            setEditName(p.name_ar)
            setEditPrice(String(p.price))
          }}
        >
          {p.name_ar}
        </button>
      ),
    },
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

      <Dialog open={!!editingPlan} onOpenChange={(open) => !open && setEditingPlan(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>تعديل خطة {editingPlan?.name_ar}</DialogTitle></DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">اسم الخطة</label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-sm font-medium text-text-secondary">السعر ({editingPlan?.currency})</label>
              <Input type="number" min="0" step="0.01" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} />
            </div>
            <p className="text-xs text-text-secondary">
              تعديل السعر لا يغيّر أي اشتراك تم إنشاؤه بالفعل بالسعر السابق — يُطبَّق فقط على الاشتراكات الجديدة.
            </p>
            <Button disabled={!editName.trim() || !editPrice || Number(editPrice) <= 0 || updatePlanMutation.isPending} onClick={() => updatePlanMutation.mutate()}>
              {updatePlanMutation.isPending ? 'جارٍ الحفظ...' : 'حفظ'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
