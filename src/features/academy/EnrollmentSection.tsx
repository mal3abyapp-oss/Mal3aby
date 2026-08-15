import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  ACTIVATION_POLICY_LABELS,
  SUBSCRIPTION_PLAN_LABELS,
  SUBSCRIPTION_STATUS_LABELS,
  type EnrollmentRow,
  type SubscriptionRow,
} from '@/lib/domain/academy'

// Enrollment Wizard (guardian -> player -> group -> subscription ->
// invoice -> payment, per USER_FLOWS.md) + freeze UI + a simple
// activation-policy dropdown in club settings-equivalent (kept here,
// scoped to academy, rather than a separate settings screen -- matches
// the "simple dropdown, not a rich policy UI" call in ADR-013).
async function fetchEnrollments(clubId: string) {
  const { data, error } = await supabase
    .from('enrollments')
    .select('id, player_id, group_id, status, enrolled_at, players(full_name), groups(name)')
    .eq('club_id', clubId)
    .order('enrolled_at', { ascending: false })
    .limit(50)
  if (error) throw error
  return (data ?? []).map<EnrollmentRow>((e) => ({
    id: e.id,
    playerId: e.player_id,
    groupId: e.group_id,
    status: e.status,
    enrolledAt: e.enrolled_at,
    playerName: (e.players as unknown as { full_name: string } | null)?.full_name,
    groupName: (e.groups as unknown as { name: string } | null)?.name,
  }))
}

async function fetchSubscriptionForEnrollment(enrollmentId: string) {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id')
    .eq('enrollment_id', enrollmentId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return {
    id: data.id,
    enrollmentId: data.enrollment_id,
    planType: data.plan_type,
    startDate: data.start_date,
    endDate: data.end_date,
    price: Number(data.price),
    discount: Number(data.discount),
    status: data.status,
    invoiceId: data.invoice_id,
  } as SubscriptionRow
}

async function fetchPlayers(clubId: string) {
  const { data, error } = await supabase.from('players').select('id, full_name').eq('club_id', clubId).eq('status', 'active').order('full_name')
  if (error) throw error
  return data ?? []
}

async function fetchGroups(clubId: string) {
  const { data, error } = await supabase.from('groups').select('id, name, capacity, status').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

async function fetchGuardiansForPlayer(playerId: string) {
  const { data, error } = await supabase.from('guardian_links').select('customer_id, is_primary, customers(full_name)').eq('player_id', playerId)
  if (error) throw error
  return (data ?? []).map((g) => ({
    id: g.customer_id,
    name: (g.customers as unknown as { full_name: string } | null)?.full_name ?? g.customer_id,
    isPrimary: g.is_primary,
  }))
}

export function EnrollmentSection() {
  const { currentClubId, currentMembership } = useAuth()
  const queryClient = useQueryClient()

  const [wizardOpen, setWizardOpen] = useState(false)
  const [wizardPlayerId, setWizardPlayerId] = useState('')
  const [wizardGroupId, setWizardGroupId] = useState('')
  const [wizardGuardianId, setWizardGuardianId] = useState('')
  const [wizardPlanType, setWizardPlanType] = useState('monthly')
  const [wizardStart, setWizardStart] = useState('')
  const [wizardEnd, setWizardEnd] = useState('')
  const [wizardPrice, setWizardPrice] = useState('')
  const [wizardDiscount, setWizardDiscount] = useState('0')
  const [wizardError, setWizardError] = useState<string | null>(null)

  const [selectedEnrollment, setSelectedEnrollment] = useState<EnrollmentRow | null>(null)
  const [freezeStart, setFreezeStart] = useState('')
  const [freezeEnd, setFreezeEnd] = useState('')
  const [freezeReason, setFreezeReason] = useState('')

  const { data: enrollments = [], isLoading } = useQuery({
    queryKey: ['enrollments', currentClubId],
    queryFn: () => fetchEnrollments(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: players = [] } = useQuery({ queryKey: ['players-for-enrollment', currentClubId], queryFn: () => fetchPlayers(currentClubId!), enabled: !!currentClubId })
  const { data: groups = [] } = useQuery({ queryKey: ['groups-for-enrollment', currentClubId], queryFn: () => fetchGroups(currentClubId!), enabled: !!currentClubId })
  const { data: guardians = [] } = useQuery({
    queryKey: ['guardians-for-player', wizardPlayerId],
    queryFn: () => fetchGuardiansForPlayer(wizardPlayerId),
    enabled: !!wizardPlayerId,
  })

  const { data: subscription } = useQuery({
    queryKey: ['subscription-for-enrollment', selectedEnrollment?.id],
    queryFn: () => fetchSubscriptionForEnrollment(selectedEnrollment!.id),
    enabled: !!selectedEnrollment,
  })

  const effectiveEndQuery = useQuery({
    queryKey: ['effective-end-date', subscription?.id],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_subscription_effective_end_date', { p_subscription_id: subscription!.id })
      if (error) throw error
      return data as string
    },
    enabled: !!subscription,
  })

  const enrollMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('create_enrollment_with_subscription', {
        p_player_id: wizardPlayerId,
        p_group_id: wizardGroupId,
        p_guardian_id: wizardGuardianId,
        p_plan_type: wizardPlanType,
        p_start_date: wizardStart,
        p_end_date: wizardEnd,
        p_price: Number(wizardPrice),
        p_discount: Number(wizardDiscount || 0),
      })
      if (error) throw error
    },
    onSuccess: () => {
      setWizardOpen(false)
      setWizardPlayerId('')
      setWizardGroupId('')
      setWizardGuardianId('')
      setWizardPrice('')
      setWizardDiscount('0')
      setWizardError(null)
      void queryClient.invalidateQueries({ queryKey: ['enrollments', currentClubId] })
    },
    onError: () => setWizardError('تعذّر إتمام التسجيل — تحقق من توفر مكان في المجموعة أو صلاحياتك.'),
  })

  const freezeMutation = useMutation({
    mutationFn: async () => {
      if (!subscription) throw new Error('no subscription')
      const { error } = await supabase.rpc('freeze_subscription', {
        p_subscription_id: subscription.id,
        p_start_date: freezeStart,
        p_end_date: freezeEnd,
        ...(freezeReason ? { p_reason: freezeReason } : {}),
        p_extends_expiry: true,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setFreezeStart('')
      setFreezeEnd('')
      setFreezeReason('')
      void queryClient.invalidateQueries({ queryKey: ['subscription-for-enrollment', selectedEnrollment?.id] })
      void queryClient.invalidateQueries({ queryKey: ['effective-end-date', subscription?.id] })
    },
  })

  const activateMutation = useMutation({
    mutationFn: async () => {
      if (!subscription) throw new Error('no subscription')
      const { error } = await supabase.rpc('activate_subscription_if_due', { p_subscription_id: subscription.id })
      if (error) throw error
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['subscription-for-enrollment', selectedEnrollment?.id] })
    },
  })

  const columns: DataTableColumn<EnrollmentRow>[] = [
    {
      key: 'player',
      header: 'اللاعب',
      render: (e) => (
        <button className="text-accent-foreground hover:underline" onClick={() => setSelectedEnrollment(e)}>
          {e.playerName ?? '—'}
        </button>
      ),
    },
    { key: 'group', header: 'المجموعة', render: (e) => e.groupName ?? '—' },
    { key: 'status', header: 'الحالة', render: (e) => <StatusBadge tone={e.status === 'active' ? 'success' : 'neutral'} label={e.status === 'active' ? 'نشط' : 'منسحب'} /> },
  ]

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-text-secondary">تسجيل لاعب في مجموعة وإنشاء اشتراكه</p>
        <Dialog open={wizardOpen} onOpenChange={setWizardOpen}>
          <DialogTrigger asChild>
            <Button size="sm">تسجيل جديد</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>معالج التسجيل</DialogTitle></DialogHeader>
            <div className="flex flex-col gap-3">
              <Select value={wizardPlayerId} onValueChange={(v) => { setWizardPlayerId(v); setWizardGuardianId('') }}>
                <SelectTrigger><SelectValue placeholder="اللاعب" /></SelectTrigger>
                <SelectContent>{players.map((p) => <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>)}</SelectContent>
              </Select>
              {guardians.length > 0 && (
                <Select value={wizardGuardianId} onValueChange={setWizardGuardianId}>
                  <SelectTrigger><SelectValue placeholder="ولي الأمر (للفوترة)" /></SelectTrigger>
                  <SelectContent>{guardians.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}{g.isPrimary ? ' (أساسي)' : ''}</SelectItem>)}</SelectContent>
                </Select>
              )}
              <Select value={wizardGroupId} onValueChange={setWizardGroupId}>
                <SelectTrigger><SelectValue placeholder="المجموعة" /></SelectTrigger>
                <SelectContent>{groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={wizardPlanType} onValueChange={setWizardPlanType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(SUBSCRIPTION_PLAN_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex gap-2">
                <Input required type="date" value={wizardStart} onChange={(e) => setWizardStart(e.target.value)} />
                <Input required type="date" value={wizardEnd} onChange={(e) => setWizardEnd(e.target.value)} />
              </div>
              <div className="flex gap-2">
                <Input required type="number" min={0} placeholder="السعر" value={wizardPrice} onChange={(e) => setWizardPrice(e.target.value)} />
                <Input type="number" min={0} placeholder="الخصم" value={wizardDiscount} onChange={(e) => setWizardDiscount(e.target.value)} />
              </div>
              {wizardError && <p role="alert" className="text-sm text-status-danger">{wizardError}</p>}
              <Button
                disabled={!wizardPlayerId || !wizardGuardianId || !wizardGroupId || !wizardStart || !wizardEnd || !wizardPrice || enrollMutation.isPending}
                onClick={() => enrollMutation.mutate()}
              >
                {enrollMutation.isPending ? 'جارٍ التسجيل...' : 'تسجيل وإنشاء الاشتراك'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <DataTable
        columns={columns}
        rows={enrollments}
        rowKey={(e) => e.id}
        isLoading={isLoading}
        emptyTitle="لا يوجد تسجيلات"
        emptyDescription="سجّل أول لاعب في مجموعة لبدء الاشتراكات"
      />

      <Dialog open={!!selectedEnrollment} onOpenChange={(open) => !open && setSelectedEnrollment(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>اشتراك {selectedEnrollment?.playerName}</DialogTitle></DialogHeader>
          {subscription ? (
            <div className="flex flex-col gap-3 text-sm">
              <p>الخطة: {SUBSCRIPTION_PLAN_LABELS[subscription.planType] ?? subscription.planType}</p>
              <p>من {subscription.startDate} إلى {subscription.endDate}</p>
              {effectiveEndQuery.data && effectiveEndQuery.data !== subscription.endDate && (
                <p className="text-status-warning">تاريخ الانتهاء الفعلي (بعد التجميد): {effectiveEndQuery.data}</p>
              )}
              <MoneyDisplay amount={subscription.price - subscription.discount} size="lg" />
              <StatusBadge
                tone={subscription.status === 'active' ? 'success' : subscription.status === 'frozen' ? 'warning' : 'neutral'}
                label={SUBSCRIPTION_STATUS_LABELS[subscription.status] ?? subscription.status}
              />

              {subscription.status === 'pending' && currentMembership?.roleKey && ['club_manager', 'academy_manager'].includes(currentMembership.roleKey) && (
                <Button size="sm" variant="outline" disabled={activateMutation.isPending} onClick={() => activateMutation.mutate()}>
                  تفعيل يدوي
                </Button>
              )}

              {(subscription.status === 'active' || subscription.status === 'frozen') && (
                <div className="flex flex-col gap-2 border-t border-border pt-3">
                  <p className="font-medium">تجميد الاشتراك</p>
                  <div className="flex gap-2">
                    <Input type="date" value={freezeStart} onChange={(e) => setFreezeStart(e.target.value)} />
                    <Input type="date" value={freezeEnd} onChange={(e) => setFreezeEnd(e.target.value)} />
                  </div>
                  <Input placeholder="السبب" value={freezeReason} onChange={(e) => setFreezeReason(e.target.value)} />
                  <Button size="sm" disabled={!freezeStart || !freezeEnd || freezeMutation.isPending} onClick={() => freezeMutation.mutate()}>
                    تجميد
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-text-secondary">لا يوجد اشتراك مرتبط.</p>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

// Simple activation-policy dropdown -- club_owner-scoped setting, kept
// minimal per ADR-013 ("a simple dropdown ... is sufficient").
export function ActivationPolicySetting() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()

  const { data: policy } = useQuery({
    queryKey: ['activation-policy', currentClubId],
    queryFn: async () => {
      const { data, error } = await supabase.from('clubs').select('subscription_activation_policy').eq('id', currentClubId!).single()
      if (error) throw error
      return data.subscription_activation_policy
    },
    enabled: !!currentClubId,
  })

  const updateMutation = useMutation({
    mutationFn: async (value: string) => {
      const { error } = await supabase.from('clubs').update({ subscription_activation_policy: value }).eq('id', currentClubId!)
      if (error) throw error
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['activation-policy', currentClubId] }),
  })

  return (
    <div className="flex items-center gap-3">
      <label className="text-sm font-medium text-text-secondary">سياسة تفعيل الاشتراك</label>
      <Select value={policy ?? 'first_payment'} onValueChange={(v) => updateMutation.mutate(v)}>
        <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
        <SelectContent>
          {Object.entries(ACTIVATION_POLICY_LABELS).map(([key, label]) => (
            <SelectItem key={key} value={key}>{label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
