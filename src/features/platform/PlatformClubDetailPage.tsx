import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LIFECYCLE_STATUS_LABELS, SUBSCRIPTION_KIND_LABELS, ACCESS_TONE, ACCESS_LABEL } from './labels'
import { actionLabel, entityLabel } from '@/lib/domain/audit'

// Per-club detail: Overview / Current Subscription / History / Payment
// History / Access Status / Audit, plus the Actions panel wired to every
// Phase 3b/3c RPC. This is the single highest-surface-area screen in the
// Platform Owner console.

const LIMIT_TYPE_LABELS: Record<string, string> = {
  branch_limit: 'الفروع',
  field_limit: 'الملاعب',
  academy_limit: 'برامج الأكاديمية',
}

const REQUEST_STATUS_LABELS: Record<string, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  pending: { label: 'قيد المراجعة', tone: 'warning' },
  reviewed: { label: 'تمت المراجعة', tone: 'neutral' },
  approved: { label: 'تمت الموافقة', tone: 'success' },
  dismissed: { label: 'مرفوض', tone: 'danger' },
}

// See labels.ts: subscription_kind/lifecycle_status were rendered as
// raw enum values in three places on this page (owner-level review
// finding, P2) -- fixed via the shared label maps there.

async function fetchClub(clubId: string) {
  const { data, error } = await supabase.from('clubs').select('*').eq('id', clubId).single()
  if (error) throw error
  return data
}

async function fetchSubscriptions(clubId: string) {
  const { data, error } = await supabase
    .from('platform_subscriptions')
    .select('*')
    .eq('club_id', clubId)
    .order('start_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

async function fetchInvoices(clubId: string) {
  const { data, error } = await supabase
    .from('platform_invoices')
    .select('*, platform_payments(*)')
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

async function fetchClubAudit(clubId: string) {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('*')
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return data ?? []
}

async function fetchPlans() {
  const { data, error } = await supabase.from('platform_plans').select('*').eq('status', 'active').order('display_order')
  if (error) throw error
  return data ?? []
}

async function fetchEntitlements(clubId: string) {
  const { data, error } = await supabase.from('commercial_entitlements').select('*').eq('club_id', clubId).maybeSingle()
  if (error) throw error
  return data
}

async function fetchUsage(clubId: string) {
  const { data, error } = await supabase.from('commercial_entitlements_usage').select('*').eq('club_id', clubId).maybeSingle()
  if (error) throw error
  return data
}

async function fetchUpgradeRequests(clubId: string) {
  const { data, error } = await supabase
    .from('commercial_upgrade_requests')
    .select('*')
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export function PlatformClubDetailPage() {
  const { clubId } = useParams<{ clubId: string }>()
  const queryClient = useQueryClient()
  const [reasonDialogAction, setReasonDialogAction] = useState<null | 'cancel' | 'reverse' | 'suspend'>(null)
  const [reasonTarget, setReasonTarget] = useState<string | null>(null)
  const [reasonText, setReasonText] = useState('')
  const [selectedPlanId, setSelectedPlanId] = useState<string>('')
  const [actionError, setActionError] = useState<string | null>(null)
  const [editingLimits, setEditingLimits] = useState(false)
  const [branchLimitInput, setBranchLimitInput] = useState('')
  const [fieldLimitInput, setFieldLimitInput] = useState('')
  const [academyLimitInput, setAcademyLimitInput] = useState('')

  const { data: club } = useQuery({ queryKey: ['platform-club', clubId], queryFn: () => fetchClub(clubId!), enabled: !!clubId })
  const { data: access } = useQuery({
    queryKey: ['platform-club-access', clubId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_club_platform_access', { p_club_id: clubId! })
      if (error) throw error
      return data
    },
    enabled: !!clubId,
  })
  const { data: subscriptions = [] } = useQuery({
    queryKey: ['platform-club-subs', clubId],
    queryFn: () => fetchSubscriptions(clubId!),
    enabled: !!clubId,
  })
  const { data: invoices = [] } = useQuery({
    queryKey: ['platform-club-invoices', clubId],
    queryFn: () => fetchInvoices(clubId!),
    enabled: !!clubId,
  })
  const { data: auditRows = [] } = useQuery({
    queryKey: ['platform-club-audit', clubId],
    queryFn: () => fetchClubAudit(clubId!),
    enabled: !!clubId,
  })
  const { data: plans = [] } = useQuery({ queryKey: ['platform-plans-active'], queryFn: fetchPlans })
  const { data: entitlements } = useQuery({
    queryKey: ['platform-club-entitlements', clubId],
    queryFn: () => fetchEntitlements(clubId!),
    enabled: !!clubId,
  })
  const { data: usage } = useQuery({
    queryKey: ['platform-club-usage', clubId],
    queryFn: () => fetchUsage(clubId!),
    enabled: !!clubId,
  })
  const { data: upgradeRequests = [] } = useQuery({
    queryKey: ['platform-club-upgrade-requests', clubId],
    queryFn: () => fetchUpgradeRequests(clubId!),
    enabled: !!clubId,
  })

  const currentSub = subscriptions.find((s) => s.lifecycle_status !== 'cancelled')
  const pendingRequests = upgradeRequests.filter((r) => r.status === 'pending')

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ['platform-club-access', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-subs', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-invoices', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-audit', clubId] })
  }

  function invalidateEntitlements() {
    void queryClient.invalidateQueries({ queryKey: ['platform-club-entitlements', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-usage', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-upgrade-requests', clubId] })
  }

  const startTrialMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('create_platform_subscription', {
        p_club_id: clubId!,
        p_subscription_kind: 'trial',
        p_trial_origin: 'manual',
      })
      if (error) throw error
    },
    onSuccess: invalidateAll,
    onError: () => setActionError('تعذّر بدء التجربة المجانية.'),
  })

  const activateMutation = useMutation({
    mutationFn: async () => {
      if (!selectedPlanId) throw new Error('no plan selected')
      const { error } = await supabase.rpc('create_platform_subscription', {
        p_club_id: clubId!,
        p_subscription_kind: 'paid',
        p_plan_id: selectedPlanId,
      })
      if (error) throw error
    },
    onSuccess: invalidateAll,
    onError: () => setActionError('تعذّر التفعيل — تأكد من اختيار خطة.'),
  })

  const renewMutation = useMutation({
    mutationFn: async () => {
      if (!currentSub) throw new Error('no current subscription')
      const { error } = await supabase.rpc('renew_platform_subscription', {
        p_previous_subscription_id: currentSub.id,
      })
      if (error) throw error
    },
    onSuccess: invalidateAll,
    onError: () => setActionError('تعذّر التجديد.'),
  })

  const changePlanMutation = useMutation({
    mutationFn: async () => {
      if (!currentSub || !selectedPlanId) throw new Error('missing input')
      const { error } = await supabase.rpc('change_platform_plan', {
        p_current_subscription_id: currentSub.id,
        p_new_plan_id: selectedPlanId,
        p_reason: 'plan change via platform console',
      })
      if (error) throw error
    },
    onSuccess: invalidateAll,
    onError: () => setActionError('تعذّر تغيير الخطة.'),
  })

  const extendGraceMutation = useMutation({
    mutationFn: async (days: number) => {
      if (!currentSub) throw new Error('no current subscription')
      const { error } = await supabase.rpc('extend_grace_period', {
        p_subscription_id: currentSub.id,
        p_grace_period_days: days,
      })
      if (error) throw error
    },
    onSuccess: invalidateAll,
    onError: () => setActionError('تعذّر تمديد فترة السماح.'),
  })

  const suspendMutation = useMutation({
    mutationFn: async (reason: string) => {
      const { error } = await supabase.rpc('platform_suspend_club', { p_club_id: clubId!, p_reason: reason })
      if (error) throw error
    },
    onSuccess: () => {
      setReasonDialogAction(null)
      setReasonText('')
      void queryClient.invalidateQueries({ queryKey: ['platform-club', clubId] })
    },
    onError: () => setActionError('تعذّر إيقاف النادي.'),
  })

  const reactivateMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('platform_reactivate_club', { p_club_id: clubId! })
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-club', clubId] }),
    onError: () => setActionError('تعذّر إعادة تفعيل النادي.'),
  })

  const cancelMutation = useMutation({
    mutationFn: async (reason: string) => {
      if (!currentSub) throw new Error('no current subscription')
      const { error } = await supabase.rpc('cancel_platform_subscription', {
        p_subscription_id: currentSub.id,
        p_reason: reason,
      })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateAll()
      setReasonDialogAction(null)
      setReasonText('')
    },
    onError: () => setActionError('تعذّر الإلغاء.'),
  })

  const recordPaymentMutation = useMutation({
    mutationFn: async (invoiceId: string) => {
      const invoice = invoices.find((i) => i.id === invoiceId)
      if (!invoice) throw new Error('invoice not found')
      const { error } = await supabase.rpc('record_platform_payment', {
        p_invoice_id: invoiceId,
        p_amount: invoice.amount,
        p_method: 'bank_transfer',
      })
      if (error) throw error
    },
    onSuccess: invalidateAll,
    onError: () => setActionError('تعذّر تسجيل الدفعة.'),
  })

  const reverseMutation = useMutation({
    mutationFn: async ({ paymentId, reason }: { paymentId: string; reason: string }) => {
      const { error } = await supabase.rpc('reverse_platform_payment', { p_payment_id: paymentId, p_reason: reason })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateAll()
      setReasonDialogAction(null)
      setReasonText('')
    },
    onError: () => setActionError('تعذّر عكس الدفعة.'),
  })

  // Task #54: commercial_entitlements/commercial_upgrade_requests both
  // already grant platform owners full RLS write access (verified via
  // direct policy inspection before building this) -- no new RPC
  // needed, direct table writes match this page's existing pattern
  // (club suspend/reactivate already do this). An empty input clears
  // the limit back to unlimited (null), matching the column's own
  // semantics.
  const saveLimitsMutation = useMutation({
    mutationFn: async () => {
      const toLimit = (v: string) => (v.trim() === '' ? null : Number(v))
      const { error } = await supabase
        .from('commercial_entitlements')
        .upsert({
          club_id: clubId!,
          branch_limit: toLimit(branchLimitInput),
          field_limit: toLimit(fieldLimitInput),
          academy_limit: toLimit(academyLimitInput),
        })
      if (error) throw error
    },
    onSuccess: () => {
      invalidateEntitlements()
      setEditingLimits(false)
    },
    onError: () => setActionError('تعذّر حفظ الحدود التجارية.'),
  })

  const resolveUpgradeRequestMutation = useMutation({
    mutationFn: async ({ requestId, status }: { requestId: string; status: 'approved' | 'dismissed' }) => {
      const { data: userData } = await supabase.auth.getUser()
      const { error } = await supabase
        .from('commercial_upgrade_requests')
        .update({ status, reviewed_at: new Date().toISOString(), reviewed_by: userData.user?.id })
        .eq('id', requestId)
      if (error) throw error
    },
    onSuccess: invalidateEntitlements,
    onError: () => setActionError('تعذّر تحديث حالة الطلب.'),
  })

  const invoiceColumns: DataTableColumn<(typeof invoices)[number]>[] = [
    { key: 'number', header: 'رقم الفاتورة', render: (i) => i.invoice_number },
    { key: 'amount', header: 'المبلغ', render: (i) => <MoneyDisplay amount={Number(i.amount)} size="sm" /> },
    { key: 'due', header: 'الاستحقاق', render: (i) => new Date(i.due_date).toLocaleDateString('ar-EG') },
    {
      key: 'status',
      header: 'الحالة',
      render: (i) => (
        <StatusBadge
          tone={i.status === 'paid' ? 'success' : i.status === 'void' ? 'neutral' : 'warning'}
          label={i.status === 'paid' ? 'مدفوعة' : i.status === 'void' ? 'ملغاة' : 'قيد الانتظار'}
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      render: (i) => {
        const payments = (i.platform_payments ?? []) as Array<{ id: string; reversed_at: string | null }>
        const activePayment = payments.find((p) => !p.reversed_at)
        if (i.status === 'pending') {
          return (
            <Button size="sm" variant="outline" onClick={() => recordPaymentMutation.mutate(i.id)}>
              تسجيل دفعة
            </Button>
          )
        }
        if (i.status === 'paid' && activePayment) {
          return (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setReasonDialogAction('reverse')
                setReasonTarget(activePayment.id)
              }}
            >
              عكس الدفعة
            </Button>
          )
        }
        return null
      },
    },
  ]

  return (
    <div>
      <PageHeader
        title={club?.name_ar ?? '...'}
        description={club?.club_code}
        actions={club && <StatusBadge tone={club.status === 'active' ? 'success' : 'danger'} label={club.status === 'active' ? 'نشط' : 'موقوف'} />}
      />

      {actionError && (
        <p role="alert" className="mb-3 text-sm text-status-danger">
          {actionError}
        </p>
      )}

      <div className="mb-4 grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">حالة الاشتراك</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <StatusBadge
              tone={ACCESS_TONE[access ?? 'blocked'] ?? 'danger'}
              label={ACCESS_LABEL[access ?? 'blocked'] ?? 'موقوف'}
            />
            {currentSub && (
              <>
                <p>النوع: {SUBSCRIPTION_KIND_LABELS[currentSub.subscription_kind] ?? currentSub.subscription_kind}</p>
                <p>ينتهي: {new Date(currentSub.end_at).toLocaleDateString('ar-EG')}</p>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">إجراءات</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {!currentSub && (
              <>
                <Button size="sm" onClick={() => startTrialMutation.mutate()} disabled={startTrialMutation.isPending}>
                  بدء تجربة مجانية
                </Button>
                <div className="flex items-center gap-2">
                  <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
                    <SelectTrigger className="w-40"><SelectValue placeholder="اختر خطة" /></SelectTrigger>
                    <SelectContent>
                      {plans.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name_ar}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" onClick={() => activateMutation.mutate()} disabled={activateMutation.isPending}>
                    تفعيل
                  </Button>
                </div>
              </>
            )}
            {currentSub && (
              <>
                <Button size="sm" variant="outline" onClick={() => renewMutation.mutate()} disabled={renewMutation.isPending}>
                  تجديد
                </Button>
                <div className="flex items-center gap-2">
                  <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
                    <SelectTrigger className="w-40"><SelectValue placeholder="خطة جديدة" /></SelectTrigger>
                    <SelectContent>
                      {plans.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{p.name_ar}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button size="sm" variant="outline" onClick={() => changePlanMutation.mutate()} disabled={changePlanMutation.isPending}>
                    تغيير الخطة
                  </Button>
                </div>
                <Button size="sm" variant="outline" onClick={() => extendGraceMutation.mutate(14)} disabled={extendGraceMutation.isPending}>
                  تمديد فترة السماح (14 يوم)
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setReasonDialogAction('cancel')
                    setReasonTarget(currentSub.id)
                  }}
                >
                  إلغاء الاشتراك
                </Button>
              </>
            )}
            {club?.status === 'active' ? (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setReasonDialogAction('suspend')
                  setReasonTarget(clubId ?? null)
                }}
                disabled={suspendMutation.isPending}
              >
                إيقاف النادي
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={() => reactivateMutation.mutate()} disabled={reactivateMutation.isPending}>
                إعادة تفعيل النادي
              </Button>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mb-4">
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">الحدود التجارية</CardTitle>
          {!editingLimits && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setBranchLimitInput(entitlements?.branch_limit?.toString() ?? '')
                setFieldLimitInput(entitlements?.field_limit?.toString() ?? '')
                setAcademyLimitInput(entitlements?.academy_limit?.toString() ?? '')
                setEditingLimits(true)
              }}
            >
              تعديل الحدود
            </Button>
          )}
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {editingLimits ? (
            <div className="flex flex-col gap-3">
              <p className="text-xs text-text-secondary">اترك الحقل فارغًا لجعل الحد بلا نهاية.</p>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">حد الفروع</label>
                  <Input type="number" min="0" value={branchLimitInput} onChange={(e) => setBranchLimitInput(e.target.value)} placeholder="بلا حد" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">حد الملاعب</label>
                  <Input type="number" min="0" value={fieldLimitInput} onChange={(e) => setFieldLimitInput(e.target.value)} placeholder="بلا حد" />
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">حد برامج الأكاديمية</label>
                  <Input type="number" min="0" value={academyLimitInput} onChange={(e) => setAcademyLimitInput(e.target.value)} placeholder="بلا حد" />
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => saveLimitsMutation.mutate()} disabled={saveLimitsMutation.isPending}>
                  {saveLimitsMutation.isPending ? 'جارٍ الحفظ...' : 'حفظ الحدود'}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setEditingLimits(false)}>إلغاء</Button>
              </div>
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-3">
              {(['branch_limit', 'field_limit', 'academy_limit'] as const).map((key) => {
                const usedKey = key === 'branch_limit' ? 'branches_used' : key === 'field_limit' ? 'fields_used' : 'academy_used'
                const limit = usage?.[key] ?? null
                const used = usage?.[usedKey] ?? 0
                return (
                  <div key={key} className="rounded-lg border border-border p-3">
                    <p className="text-sm font-medium">{LIMIT_TYPE_LABELS[key]}</p>
                    <p className="text-sm text-text-secondary tabular-nums">{used} {limit === null ? '(بلا حد)' : `/ ${limit}`}</p>
                  </div>
                )
              })}
            </div>
          )}

          {pendingRequests.length > 0 && (
            <div className="flex flex-col gap-2 rounded-lg border border-status-warning/40 bg-status-warning/10 p-3">
              <p className="text-sm font-medium text-status-warning">طلبات ترقية قيد المراجعة ({pendingRequests.length})</p>
              {pendingRequests.map((r) => (
                <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface p-2 text-sm">
                  <span>
                    {LIMIT_TYPE_LABELS[r.limit_type] ?? r.limit_type} — الحد الحالي {r.current_limit ?? 'بلا حد'} / الاستخدام {r.current_usage}
                    {r.note && <span className="text-text-secondary"> — {r.note}</span>}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => resolveUpgradeRequestMutation.mutate({ requestId: r.id, status: 'approved' })}
                      disabled={resolveUpgradeRequestMutation.isPending}
                    >
                      موافقة
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => resolveUpgradeRequestMutation.mutate({ requestId: r.id, status: 'dismissed' })}
                      disabled={resolveUpgradeRequestMutation.isPending}
                    >
                      رفض
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="history">
        <TabsList>
          <TabsTrigger value="history">سجل الاشتراكات</TabsTrigger>
          <TabsTrigger value="invoices">الفواتير والمدفوعات</TabsTrigger>
          <TabsTrigger value="requests">طلبات الترقية</TabsTrigger>
          <TabsTrigger value="audit">سجل التدقيق</TabsTrigger>
        </TabsList>
        <TabsContent value="history">
          <DataTable
            columns={[
              { key: 'kind', header: 'النوع', render: (s: (typeof subscriptions)[number]) => SUBSCRIPTION_KIND_LABELS[s.subscription_kind] ?? s.subscription_kind },
              { key: 'plan', header: 'الخطة', render: (s: (typeof subscriptions)[number]) => s.plan_name_snapshot ?? '—' },
              { key: 'start', header: 'البداية', render: (s: (typeof subscriptions)[number]) => new Date(s.start_at).toLocaleDateString('ar-EG') },
              { key: 'end', header: 'النهاية', render: (s: (typeof subscriptions)[number]) => new Date(s.end_at).toLocaleDateString('ar-EG') },
              { key: 'status', header: 'الحالة', render: (s: (typeof subscriptions)[number]) => LIFECYCLE_STATUS_LABELS[s.lifecycle_status] ?? s.lifecycle_status },
            ]}
            rows={subscriptions}
            rowKey={(s) => s.id}
            emptyTitle="لا يوجد سجل اشتراكات"
          />
        </TabsContent>
        <TabsContent value="invoices">
          <DataTable columns={invoiceColumns} rows={invoices} rowKey={(i) => i.id} emptyTitle="لا توجد فواتير" />
        </TabsContent>
        <TabsContent value="requests">
          <DataTable
            columns={[
              { key: 'type', header: 'النوع', render: (r: (typeof upgradeRequests)[number]) => LIMIT_TYPE_LABELS[r.limit_type] ?? r.limit_type },
              { key: 'limit', header: 'الحد وقت الطلب', render: (r: (typeof upgradeRequests)[number]) => r.current_limit ?? 'بلا حد' },
              { key: 'usage', header: 'الاستخدام وقت الطلب', render: (r: (typeof upgradeRequests)[number]) => r.current_usage },
              { key: 'note', header: 'ملاحظة', render: (r: (typeof upgradeRequests)[number]) => r.note ?? '—' },
              { key: 'created', header: 'تاريخ الطلب', render: (r: (typeof upgradeRequests)[number]) => new Date(r.created_at).toLocaleDateString('ar-EG') },
              {
                key: 'status',
                header: 'الحالة',
                render: (r: (typeof upgradeRequests)[number]) => (
                  <StatusBadge
                    tone={REQUEST_STATUS_LABELS[r.status]?.tone ?? 'neutral'}
                    label={REQUEST_STATUS_LABELS[r.status]?.label ?? r.status}
                  />
                ),
              },
            ]}
            rows={upgradeRequests}
            rowKey={(r) => r.id}
            emptyTitle="لا توجد طلبات ترقية"
          />
        </TabsContent>
        <TabsContent value="audit">
          <DataTable
            columns={[
              { key: 'action', header: 'الإجراء', render: (a: (typeof auditRows)[number]) => actionLabel(a.action) },
              { key: 'entity', header: 'الكيان', render: (a: (typeof auditRows)[number]) => entityLabel(a.entity_type) },
              { key: 'time', header: 'الوقت', render: (a: (typeof auditRows)[number]) => new Date(a.created_at).toLocaleString('ar-EG') },
              { key: 'reason', header: 'السبب', render: (a: (typeof auditRows)[number]) => a.reason ?? '—' },
            ]}
            rows={auditRows}
            rowKey={(a) => a.id}
            emptyTitle="لا يوجد سجل تدقيق"
          />
        </TabsContent>
      </Tabs>

      <Dialog open={reasonDialogAction !== null} onOpenChange={(open) => !open && setReasonDialogAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reasonDialogAction === 'cancel' ? 'سبب الإلغاء' : reasonDialogAction === 'suspend' ? 'سبب إيقاف النادي' : 'سبب عكس الدفعة'}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            {reasonDialogAction === 'suspend' && (
              <p className="text-sm text-status-danger">
                سيتم إيقاف النادي بالكامل عن العمل على المنصة فورًا. هذا إجراء حساس يُسجَّل في سجل التدقيق.
              </p>
            )}
            <Input value={reasonText} onChange={(e) => setReasonText(e.target.value)} placeholder="السبب مطلوب" />
            <Button
              variant={reasonDialogAction === 'suspend' ? 'destructive' : 'default'}
              disabled={!reasonText.trim() || cancelMutation.isPending || reverseMutation.isPending || suspendMutation.isPending}
              onClick={() => {
                if (!reasonTarget) return
                if (reasonDialogAction === 'cancel') cancelMutation.mutate(reasonText)
                else if (reasonDialogAction === 'suspend') suspendMutation.mutate(reasonText)
                else reverseMutation.mutate({ paymentId: reasonTarget, reason: reasonText })
              }}
            >
              {reasonDialogAction === 'suspend' ? 'تأكيد الإيقاف' : 'تأكيد'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
