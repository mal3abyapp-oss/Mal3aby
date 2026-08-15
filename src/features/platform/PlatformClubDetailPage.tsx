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

// Per-club detail: Overview / Current Subscription / History / Payment
// History / Access Status / Audit, plus the Actions panel wired to every
// Phase 3b/3c RPC. This is the single highest-surface-area screen in the
// Platform Owner console.

const ACCESS_TONE: Record<string, 'success' | 'warning' | 'danger'> = {
  full: 'success',
  grace: 'warning',
  blocked: 'danger',
}
const ACCESS_LABEL: Record<string, string> = { full: 'كامل', grace: 'فترة سماح', blocked: 'موقوف' }

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

export function PlatformClubDetailPage() {
  const { clubId } = useParams<{ clubId: string }>()
  const queryClient = useQueryClient()
  const [reasonDialogAction, setReasonDialogAction] = useState<null | 'cancel' | 'reverse'>(null)
  const [reasonTarget, setReasonTarget] = useState<string | null>(null)
  const [reasonText, setReasonText] = useState('')
  const [selectedPlanId, setSelectedPlanId] = useState<string>('')
  const [actionError, setActionError] = useState<string | null>(null)

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

  const currentSub = subscriptions.find((s) => s.lifecycle_status !== 'cancelled')

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ['platform-club-access', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-subs', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-invoices', clubId] })
    void queryClient.invalidateQueries({ queryKey: ['platform-club-audit', clubId] })
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
    mutationFn: async () => {
      const { error } = await supabase.from('clubs').update({ status: 'suspended' }).eq('id', clubId!)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['platform-club', clubId] }),
    onError: () => setActionError('تعذّر إيقاف النادي.'),
  })

  const reactivateMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('clubs').update({ status: 'active' }).eq('id', clubId!)
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
                <p>النوع: {currentSub.subscription_kind}</p>
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
              <Button size="sm" variant="destructive" onClick={() => suspendMutation.mutate()} disabled={suspendMutation.isPending}>
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

      <Tabs defaultValue="history">
        <TabsList>
          <TabsTrigger value="history">سجل الاشتراكات</TabsTrigger>
          <TabsTrigger value="invoices">الفواتير والمدفوعات</TabsTrigger>
          <TabsTrigger value="audit">سجل التدقيق</TabsTrigger>
        </TabsList>
        <TabsContent value="history">
          <DataTable
            columns={[
              { key: 'kind', header: 'النوع', render: (s: (typeof subscriptions)[number]) => s.subscription_kind },
              { key: 'plan', header: 'الخطة', render: (s: (typeof subscriptions)[number]) => s.plan_name_snapshot ?? '—' },
              { key: 'start', header: 'البداية', render: (s: (typeof subscriptions)[number]) => new Date(s.start_at).toLocaleDateString('ar-EG') },
              { key: 'end', header: 'النهاية', render: (s: (typeof subscriptions)[number]) => new Date(s.end_at).toLocaleDateString('ar-EG') },
              { key: 'status', header: 'الحالة', render: (s: (typeof subscriptions)[number]) => s.lifecycle_status },
            ]}
            rows={subscriptions}
            rowKey={(s) => s.id}
            emptyTitle="لا يوجد سجل اشتراكات"
          />
        </TabsContent>
        <TabsContent value="invoices">
          <DataTable columns={invoiceColumns} rows={invoices} rowKey={(i) => i.id} emptyTitle="لا توجد فواتير" />
        </TabsContent>
        <TabsContent value="audit">
          <DataTable
            columns={[
              { key: 'action', header: 'الإجراء', render: (a: (typeof auditRows)[number]) => a.action },
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
            <DialogTitle>{reasonDialogAction === 'cancel' ? 'سبب الإلغاء' : 'سبب عكس الدفعة'}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <Input value={reasonText} onChange={(e) => setReasonText(e.target.value)} placeholder="السبب مطلوب" />
            <Button
              disabled={!reasonText.trim() || cancelMutation.isPending || reverseMutation.isPending}
              onClick={() => {
                if (!reasonTarget) return
                if (reasonDialogAction === 'cancel') cancelMutation.mutate(reasonText)
                else reverseMutation.mutate({ paymentId: reasonTarget, reason: reasonText })
              }}
            >
              تأكيد
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
