import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { MoneyDisplay } from '@/components/ui/money-display'
import { StatusBadge } from '@/components/ui/status-badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LIFECYCLE_STATUS_LABELS } from './labels'

// Five report types per IMPLEMENTATION_PLAN.md Phase 3c: Subscription,
// Revenue, Renewal, Growth, Usage. All read live from Phase 3b/2 tables --
// no stored aggregate, no mock data.

interface SubRow {
  club_id: string
  club_name: string
  plan_name_snapshot: string | null
  lifecycle_status: string
  start_at: string
  end_at: string
  price_snapshot: number
}

async function fetchSubscriptionReport(): Promise<SubRow[]> {
  const { data, error } = await supabase
    .from('platform_subscriptions')
    .select('club_id, plan_name_snapshot, lifecycle_status, start_at, end_at, price_snapshot, clubs(name_ar)')
    .order('start_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => ({
    club_id: r.club_id,
    club_name: (r.clubs as unknown as { name_ar: string } | null)?.name_ar ?? '—',
    plan_name_snapshot: r.plan_name_snapshot,
    lifecycle_status: r.lifecycle_status,
    start_at: r.start_at,
    end_at: r.end_at,
    price_snapshot: Number(r.price_snapshot),
  }))
}

interface RevenueRow {
  month: string
  method: string
  amount: number
}

async function fetchRevenueReport(): Promise<RevenueRow[]> {
  const { data, error } = await supabase
    .from('platform_payments')
    .select('amount, method, recorded_at')
    .is('reversed_at', null)
    .order('recorded_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => ({
    month: new Date(r.recorded_at).toLocaleDateString('ar-EG', { year: 'numeric', month: 'long' }),
    method: r.method,
    amount: Number(r.amount),
  }))
}

async function fetchRenewalReport() {
  const { data, error } = await supabase
    .from('platform_subscriptions')
    .select('club_id, end_at, grace_period_days_snapshot, lifecycle_status, clubs(name_ar)')
    .neq('lifecycle_status', 'cancelled')
    .order('end_at')
  if (error) throw error
  const now = new Date()
  return (data ?? []).map((r) => {
    const end = new Date(r.end_at)
    const daysLeft = Math.ceil((end.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
    return {
      club_id: r.club_id,
      club_name: (r.clubs as unknown as { name_ar: string } | null)?.name_ar ?? '—',
      end_at: r.end_at,
      daysLeft,
    }
  })
}

async function fetchGrowthReport() {
  const { data, error } = await supabase.from('clubs').select('id, name_ar, status, created_at').order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

async function fetchUsageReport() {
  const [{ data: clubs, error: clubsError }, { data: branches, error: branchesError }, { data: memberships, error: membershipsError }] =
    await Promise.all([
      supabase.from('clubs').select('id, name_ar'),
      supabase.from('branches').select('id, club_id'),
      supabase.from('club_memberships').select('id, club_id').eq('status', 'active'),
    ])
  if (clubsError) throw clubsError
  if (branchesError) throw branchesError
  if (membershipsError) throw membershipsError

  return (clubs ?? []).map((c) => ({
    club_id: c.id,
    club_name: c.name_ar,
    branchCount: branches?.filter((b) => b.club_id === c.id).length ?? 0,
    staffCount: memberships?.filter((m) => m.club_id === c.id).length ?? 0,
  }))
}

export function PlatformReportsPage() {
  const { data: subReport = [] } = useQuery({ queryKey: ['report-subscriptions'], queryFn: fetchSubscriptionReport })
  const { data: revenueReport = [] } = useQuery({ queryKey: ['report-revenue'], queryFn: fetchRevenueReport })
  const { data: renewalReport = [] } = useQuery({ queryKey: ['report-renewals'], queryFn: fetchRenewalReport })
  const { data: growthReport = [] } = useQuery({ queryKey: ['report-growth'], queryFn: fetchGrowthReport })
  const { data: usageReport = [] } = useQuery({ queryKey: ['report-usage'], queryFn: fetchUsageReport })

  const subColumns: DataTableColumn<SubRow>[] = [
    { key: 'club', header: 'النادي', render: (r) => r.club_name },
    { key: 'plan', header: 'الخطة', render: (r) => r.plan_name_snapshot ?? '—' },
    { key: 'status', header: 'الحالة', render: (r) => LIFECYCLE_STATUS_LABELS[r.lifecycle_status] ?? r.lifecycle_status },
    { key: 'start', header: 'البداية', render: (r) => new Date(r.start_at).toLocaleDateString('ar-EG') },
    { key: 'end', header: 'النهاية', render: (r) => new Date(r.end_at).toLocaleDateString('ar-EG') },
    { key: 'price', header: 'السعر', render: (r) => <MoneyDisplay amount={r.price_snapshot} size="sm" /> },
  ]

  const revenueColumns: DataTableColumn<RevenueRow>[] = [
    { key: 'month', header: 'الشهر', render: (r) => r.month },
    { key: 'method', header: 'طريقة الدفع', render: (r) => r.method },
    { key: 'amount', header: 'المبلغ', render: (r) => <MoneyDisplay amount={r.amount} size="sm" /> },
  ]

  const renewalColumns: DataTableColumn<(typeof renewalReport)[number]>[] = [
    { key: 'club', header: 'النادي', render: (r) => r.club_name },
    { key: 'end', header: 'تاريخ الانتهاء', render: (r) => new Date(r.end_at).toLocaleDateString('ar-EG') },
    {
      key: 'status',
      header: 'الحالة',
      render: (r) =>
        r.daysLeft < 0 ? (
          <StatusBadge tone="danger" label="منتهٍ" />
        ) : r.daysLeft <= 7 ? (
          <StatusBadge tone="warning" label={`${r.daysLeft} أيام متبقية`} />
        ) : (
          <StatusBadge tone="success" label={`${r.daysLeft} يوم متبقٍ`} />
        ),
    },
  ]

  const growthColumns: DataTableColumn<(typeof growthReport)[number]>[] = [
    { key: 'club', header: 'النادي', render: (r) => r.name_ar },
    { key: 'status', header: 'الحالة', render: (r) => r.status },
    { key: 'created', header: 'تاريخ الإنشاء', render: (r) => new Date(r.created_at).toLocaleDateString('ar-EG') },
  ]

  const usageColumns: DataTableColumn<(typeof usageReport)[number]>[] = [
    { key: 'club', header: 'النادي', render: (r) => r.club_name },
    { key: 'branches', header: 'الفروع', render: (r) => r.branchCount },
    { key: 'staff', header: 'الموظفون', render: (r) => r.staffCount },
  ]

  return (
    <div>
      <PageHeader title="التقارير" description="تقارير المنصة الخمسة" />
      <Tabs defaultValue="subscription">
        <TabsList>
          <TabsTrigger value="subscription">الاشتراكات</TabsTrigger>
          <TabsTrigger value="revenue">الإيرادات</TabsTrigger>
          <TabsTrigger value="renewal">التجديدات</TabsTrigger>
          <TabsTrigger value="growth">النمو</TabsTrigger>
          <TabsTrigger value="usage">الاستخدام</TabsTrigger>
        </TabsList>
        <TabsContent value="subscription">
          <DataTable columns={subColumns} rows={subReport} rowKey={(r) => `${r.club_id}-${r.start_at}`} emptyTitle="لا توجد بيانات" />
        </TabsContent>
        <TabsContent value="revenue">
          <DataTable
            columns={revenueColumns}
            rows={revenueReport}
            rowKey={(r) => `${r.month}-${r.method}-${r.amount}`}
            emptyTitle="لا توجد بيانات"
          />
        </TabsContent>
        <TabsContent value="renewal">
          <DataTable columns={renewalColumns} rows={renewalReport} rowKey={(r) => `${r.club_id}-${r.end_at}`} emptyTitle="لا توجد بيانات" />
        </TabsContent>
        <TabsContent value="growth">
          <DataTable columns={growthColumns} rows={growthReport} rowKey={(r) => r.id} emptyTitle="لا توجد بيانات" />
        </TabsContent>
        <TabsContent value="usage">
          <DataTable columns={usageColumns} rows={usageReport} rowKey={(r) => r.club_id} emptyTitle="لا توجد بيانات" />
        </TabsContent>
      </Tabs>
    </div>
  )
}
