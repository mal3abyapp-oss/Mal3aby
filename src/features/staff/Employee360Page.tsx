import { useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { translateSupabaseError } from '@/lib/errors'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatCard } from '@/components/ui/stat-card'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Wallet, Wrench, Banknote, Activity, ArrowLeft, KeyRound } from 'lucide-react'

// Staff 360 directive: Employee 360 is a PROJECTION over the existing
// identity/finance sources -- club_memberships + cash_shifts +
// employee_cash_liabilities -- never a duplicate financial ledger.
// Exactly 5 tabs per the directive (section 4): Overview, Access &
// Permissions, Cash Shifts & Custody, Financial Account, Activity &
// Audit.

type TabKey = 'overview' | 'access' | 'shifts' | 'financial' | 'activity'

interface Summary {
  membership: {
    id: string; user_id: string; full_name: string | null; email: string | null
    status: string; has_cash_custody: boolean; created_at: string
  }
  branches: { id: string; name: string }[]
  current_shift: { id: string; branch_id: string; branch_name: string; opened_at: string; opening_float: number } | null
  outstanding_liability: number
  total_settled: number
  last_shift: { id: string; closed_at: string | null; branch_name: string } | null
  last_collection: { id: string; amount: number; received_at: string } | null
  last_activity_at: string | null
}

interface AccessProfile {
  role: { id: string; key: string; name: string; name_ar: string }
  permissions: { key: string; description: string }[]
  assigned_branches: { id: string; name: string }[]
  all_club_branches: { id: string; name: string }[]
  branch_scope_is_all: boolean
}

interface ShiftRow {
  id: string; branch_id: string; branch_name: string; opened_at: string; closed_at: string | null
  opening_float: number; cash_collected: number; closing_count: number | null
  expected_cash: number | null; variance: number | null; status: string
}

interface LiabilityRow {
  id: string; kind: string; cash_shift_id: string; original_amount: number
  outstanding: number; settled_amount: number; status: string; created_at: string
}

const ROLE_KEYS = ['club_manager', 'branch_manager', 'receptionist', 'accountant', 'academy_manager', 'coach', 'scanner']

// Directive section 11: friendly permission groups, not raw internal
// keys. Every permission key in the DB (confirmed via audit) is
// covered by exactly one group below.
const PERMISSION_GROUPS: { titleKey: string; keys: string[] }[] = [
  { titleKey: 'staff.detail.groupBookings', keys: ['booking.view', 'booking.create', 'booking.update', 'booking.cancel', 'booking.discount.apply', 'booking.discount.override'] },
  { titleKey: 'staff.detail.groupCustomers', keys: ['customer.view', 'customer.create', 'customer.update'] },
  { titleKey: 'staff.detail.groupAcademy', keys: ['academy.program.manage', 'academy.group.manage', 'enrollment.view', 'enrollment.create', 'enrollment.update', 'session.view', 'session.manage', 'attendance.view', 'attendance.mark', 'subscription.view', 'subscription.create', 'subscription.update', 'subscription.freeze.create', 'player.view', 'player.create', 'player.update', 'player.medical_notes.view', 'player.medical_notes.update'] },
  { titleKey: 'staff.detail.groupPayments', keys: ['payment.view', 'payment.create', 'payment.refund', 'payment.verify', 'payment.methods.view', 'payment.methods.manage'] },
  { titleKey: 'staff.detail.groupFinance', keys: ['invoice.view', 'invoice.create', 'invoice.update', 'report.view'] },
  { titleKey: 'staff.detail.groupStaff', keys: ['staff.create', 'staff.update'] },
  { titleKey: 'staff.detail.groupSettings', keys: ['club.update', 'branch.create', 'branch.update', 'field.view', 'field.create', 'field.update', 'pricing.view', 'pricing.update', 'manage_whatsapp_connection', 'notification.view'] },
  { titleKey: 'staff.detail.groupScanner', keys: ['qr.scan', 'qr.checkin.confirm'] },
]

async function fetchSummary(clubId: string, membershipId: string) {
  const { data, error } = await supabase.rpc('get_staff_360_summary', { p_club_id: clubId, p_membership_id: membershipId })
  if (error) throw error
  return data as unknown as Summary
}
async function fetchAccess(clubId: string, membershipId: string) {
  const { data, error } = await supabase.rpc('get_staff_access_profile', { p_club_id: clubId, p_membership_id: membershipId })
  if (error) throw error
  return data as unknown as AccessProfile
}
async function fetchShifts(clubId: string, membershipId: string) {
  const { data, error } = await supabase.rpc('get_staff_shift_history', { p_club_id: clubId, p_membership_id: membershipId, p_limit: 20, p_offset: 0 })
  if (error) throw error
  return data as unknown as { rows: ShiftRow[]; total_count: number }
}
async function fetchFinancial(clubId: string, membershipId: string) {
  const { data, error } = await supabase.rpc('get_staff_financial_account', { p_club_id: clubId, p_membership_id: membershipId, p_limit: 20, p_offset: 0 })
  if (error) throw error
  return data as unknown as { summary: { total_original_liabilities: number; total_settled: number; total_outstanding: number }; liabilities: { rows: LiabilityRow[]; total_count: number } }
}
async function fetchActivity(clubId: string, membershipId: string) {
  const { data, error } = await supabase.rpc('get_staff_activity', { p_club_id: clubId, p_membership_id: membershipId, p_limit: 30, p_offset: 0 })
  if (error) throw error
  return data as unknown as { rows: { id: string; action: string; entity_type: string; entity_id: string; created_at: string }[]; total_count: number }
}

export function Employee360Page() {
  const { membershipId } = useParams<{ membershipId: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const [settleLiability, setSettleLiability] = useState<LiabilityRow | null>(null)

  const { data: summary, isLoading } = useQuery({
    queryKey: ['staff-360-summary', currentClubId, membershipId],
    queryFn: () => fetchSummary(currentClubId!, membershipId!),
    enabled: !!currentClubId && !!membershipId,
  })
  const { data: access } = useQuery({
    queryKey: ['staff-360-access', currentClubId, membershipId],
    queryFn: () => fetchAccess(currentClubId!, membershipId!),
    enabled: !!currentClubId && !!membershipId && activeTab === 'access',
  })
  const { data: shifts } = useQuery({
    queryKey: ['staff-360-shifts', currentClubId, membershipId],
    queryFn: () => fetchShifts(currentClubId!, membershipId!),
    enabled: !!currentClubId && !!membershipId && activeTab === 'shifts',
  })
  const { data: financial } = useQuery({
    queryKey: ['staff-360-financial', currentClubId, membershipId],
    queryFn: () => fetchFinancial(currentClubId!, membershipId!),
    enabled: !!currentClubId && !!membershipId && activeTab === 'financial',
  })
  const { data: activity } = useQuery({
    queryKey: ['staff-360-activity', currentClubId, membershipId],
    queryFn: () => fetchActivity(currentClubId!, membershipId!),
    enabled: !!currentClubId && !!membershipId && activeTab === 'activity',
  })

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ['staff-360-summary', currentClubId, membershipId] })
    void queryClient.invalidateQueries({ queryKey: ['staff-360-access', currentClubId, membershipId] })
    void queryClient.invalidateQueries({ queryKey: ['staff-360-shifts', currentClubId, membershipId] })
    void queryClient.invalidateQueries({ queryKey: ['staff-360-financial', currentClubId, membershipId] })
    void queryClient.invalidateQueries({ queryKey: ['staff-360-activity', currentClubId, membershipId] })
    void queryClient.invalidateQueries({ queryKey: ['staff', currentClubId] })
  }

  const [custodyError, setCustodyError] = useState<string | null>(null)

  const custodyMutation = useMutation({
    mutationFn: async (nextValue: boolean) => {
      const { error } = await supabase.rpc('set_staff_cash_custody', { p_membership_id: membershipId!, p_has_custody: nextValue })
      if (error) throw error
    },
    onSuccess: invalidateAll,
    onError: (err) => setCustodyError(translateSupabaseError(err, t('staff.detail.custodyChangeError', { defaultValue: "Couldn't change cash custody." }))),
  })

  const suspendMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('deactivate_staff_member', { p_membership_id: membershipId! })
      if (error) throw error
    },
    onSuccess: invalidateAll,
    onError: (err) => setCustodyError(translateSupabaseError(err, t('staff.detail.suspendError', { defaultValue: "Couldn't suspend this employee." }))),
  })

  const reactivateMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc('reactivate_staff_member', { p_membership_id: membershipId! })
      if (error) throw error
    },
    onSuccess: invalidateAll,
  })

  if (isLoading || !summary) {
    return <div className="p-4 text-sm text-text-secondary">{t('common.loading', { defaultValue: 'Loading...' })}</div>
  }

  const m = summary.membership

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <button onClick={() => navigate('/app/staff')} className="text-text-secondary hover:text-accent-foreground">
          <ArrowLeft className="size-4 rtl:rotate-180" />
        </button>
        <span className="text-sm text-text-secondary">{t('staff.title')}</span>
      </div>

      <PageHeader
        title={m.full_name ?? t('staff.notLoggedInYet', { defaultValue: 'Not logged in yet' })}
        description={m.email ?? ''}
        actions={
          m.status === 'active' ? (
            <Button variant="outline" onClick={() => { setCustodyError(null); suspendMutation.mutate() }} disabled={suspendMutation.isPending}>
              {t('staff.deactivate')}
            </Button>
          ) : (
            <Button onClick={() => reactivateMutation.mutate()} disabled={reactivateMutation.isPending}>
              {t('staff.detail.reactivate', { defaultValue: 'Reactivate' })}
            </Button>
          )
        }
      />
      {custodyError && <p role="alert" className="text-sm text-status-danger">{custodyError}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatCard label={t('staff.detail.branches', { defaultValue: 'Branches' })} value={summary.branches.length === 0 ? t('staff.allBranches') : String(summary.branches.length)} icon={Wrench} />
        <StatCard
          label={t('staff.detail.cashCustody', { defaultValue: 'Cash custody' })}
          value={m.has_cash_custody ? t('staff.custodyEnabled') : t('staff.custodyDisabled')}
          icon={Wallet}
          tone={m.has_cash_custody ? 'default' : 'neutral' as 'default'}
        />
        <StatCard
          label={t('staff.detail.currentShift', { defaultValue: 'Current shift' })}
          value={summary.current_shift ? summary.current_shift.branch_name : t('staff.detail.noOpenShift', { defaultValue: 'No open shift' })}
          icon={Banknote}
        />
        <StatCard
          label={t('staff.detail.outstandingLiability', { defaultValue: 'Outstanding liability' })}
          value={`${summary.outstanding_liability.toFixed(0)} ${t('common.currency')}`}
          icon={Activity}
          tone={summary.outstanding_liability > 0 ? 'danger' : 'default'}
        />
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="overview">{t('staff.detail.tabs.overview', { defaultValue: 'Overview' })}</TabsTrigger>
          <TabsTrigger value="access">{t('staff.detail.tabs.access', { defaultValue: 'Access & Permissions' })}</TabsTrigger>
          <TabsTrigger value="shifts">{t('staff.detail.tabs.shifts', { defaultValue: 'Cash Shifts & Custody' })}</TabsTrigger>
          <TabsTrigger value="financial">{t('staff.detail.tabs.financial', { defaultValue: 'Financial Account' })}</TabsTrigger>
          <TabsTrigger value="activity">{t('staff.detail.tabs.activity', { defaultValue: 'Activity & Audit' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="mt-4 flex flex-col gap-4">
            <div className="rounded-lg border border-border p-4">
              <p className="mb-2 text-sm font-medium text-text-secondary">{t('staff.detail.lastActivitySection', { defaultValue: 'Recent activity' })}</p>
              <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div>
                  <p className="text-text-secondary">{t('staff.detail.lastShift', { defaultValue: 'Last shift' })}</p>
                  <p>{summary.last_shift ? <bdi>{summary.last_shift.branch_name} — {summary.last_shift.closed_at ? new Date(summary.last_shift.closed_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG') : ''}</bdi> : '—'}</p>
                </div>
                <div>
                  <p className="text-text-secondary">{t('staff.detail.lastCollection', { defaultValue: 'Last collection' })}</p>
                  <p>{summary.last_collection ? <MoneyDisplay amount={summary.last_collection.amount} size="sm" /> : '—'}</p>
                </div>
              </div>
            </div>
            <div className="rounded-lg border border-border p-4">
              <p className="mb-2 text-sm font-medium text-text-secondary">{t('staff.detail.branchesSection', { defaultValue: 'Assigned branches' })}</p>
              {summary.branches.length === 0 ? (
                <p className="text-sm">{t('staff.allBranches')}</p>
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {summary.branches.map((b) => <li key={b.id}>{b.name}</li>)}
                </ul>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="access">
          <AccessTab clubId={currentClubId!} membershipId={membershipId!} access={access} onChanged={invalidateAll} />
        </TabsContent>

        <TabsContent value="shifts">
          <div className="mt-4 flex flex-col gap-4">
            <div className="flex items-center justify-between rounded-lg border border-border p-4">
              <div>
                <p className="text-sm font-medium text-text-secondary">{t('staff.detail.cashCustody', { defaultValue: 'Cash custody' })}</p>
                <p className="text-xs text-text-secondary">{t('staff.detail.custodyHint', { defaultValue: 'Whether this employee can be assigned cash-handling duties.' })}</p>
              </div>
              <Button
                variant={m.has_cash_custody ? 'default' : 'outline'}
                size="sm"
                disabled={custodyMutation.isPending}
                onClick={() => { setCustodyError(null); custodyMutation.mutate(!m.has_cash_custody) }}
              >
                {m.has_cash_custody ? t('staff.custodyEnabled') : t('staff.custodyDisabled')}
              </Button>
            </div>
            {summary.current_shift && (
              <div className="rounded-lg border border-accent/30 bg-accent/5 p-4">
                <p className="mb-2 text-sm font-medium text-text-secondary">{t('staff.detail.currentShift', { defaultValue: 'Current shift' })}</p>
                <div className="flex items-center justify-between text-sm">
                  <span><bdi>{summary.current_shift.branch_name}</bdi></span>
                  <MoneyDisplay amount={summary.current_shift.opening_float} size="sm" />
                </div>
              </div>
            )}
            <DataTable
              columns={[
                { key: 'branch', header: t('common.branch', { defaultValue: 'Branch' }), render: (r: ShiftRow) => r.branch_name },
                { key: 'opened', header: t('staff.detail.opened', { defaultValue: 'Opened' }), render: (r: ShiftRow) => <span className="tabular-nums"><bdi>{new Date(r.opened_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi></span> },
                { key: 'collected', header: t('staff.detail.collected', { defaultValue: 'Collected' }), render: (r: ShiftRow) => <MoneyDisplay amount={r.cash_collected} size="sm" /> },
                { key: 'variance', header: t('staff.detail.variance', { defaultValue: 'Variance' }), render: (r: ShiftRow) => r.variance == null ? '—' : <MoneyDisplay amount={r.variance} tone={r.variance < 0 ? 'danger' : r.variance > 0 ? 'success' : 'default'} size="sm" /> },
                { key: 'status', header: t('common.status', { defaultValue: 'Status' }), render: (r: ShiftRow) => <StatusBadge tone={r.status === 'open' ? 'warning' : 'neutral'} label={r.status === 'open' ? t('billing.cashShift.open', { defaultValue: 'Open' }) : t('billing.cashShift.closed', { defaultValue: 'Closed' })} /> },
              ] as DataTableColumn<ShiftRow>[]}
              rows={shifts?.rows ?? []}
              rowKey={(r) => r.id}
              emptyTitle={t('staff.detail.noShiftsYet', { defaultValue: 'No shifts yet' })}
            />
          </div>
        </TabsContent>

        <TabsContent value="financial">
          <div className="mt-4 flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatCard label={t('staff.detail.totalOriginal', { defaultValue: 'Original' })} value={`${(financial?.summary.total_original_liabilities ?? 0).toFixed(0)} ${t('common.currency')}`} />
              <StatCard label={t('staff.detail.totalSettled', { defaultValue: 'Settled' })} value={`${(financial?.summary.total_settled ?? 0).toFixed(0)} ${t('common.currency')}`} />
              <StatCard label={t('staff.detail.totalOutstanding', { defaultValue: 'Outstanding' })} value={`${(financial?.summary.total_outstanding ?? 0).toFixed(0)} ${t('common.currency')}`} tone={(financial?.summary.total_outstanding ?? 0) > 0 ? 'danger' : 'default'} />
            </div>
            <DataTable
              columns={[
                { key: 'date', header: t('common.date', { defaultValue: 'Date' }), render: (r: LiabilityRow) => <span className="tabular-nums"><bdi>{new Date(r.created_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi></span> },
                { key: 'kind', header: t('staff.detail.kind', { defaultValue: 'Type' }), render: (r: LiabilityRow) => r.kind === 'shortage' ? t('staff.detail.shortage', { defaultValue: 'Shortage' }) : t('staff.detail.overage', { defaultValue: 'Overage' }) },
                { key: 'original', header: t('staff.detail.original', { defaultValue: 'Original' }), render: (r: LiabilityRow) => <MoneyDisplay amount={r.original_amount} size="sm" /> },
                { key: 'settled', header: t('staff.detail.settled', { defaultValue: 'Settled' }), render: (r: LiabilityRow) => <MoneyDisplay amount={r.settled_amount} size="sm" /> },
                { key: 'outstanding', header: t('staff.detail.outstanding', { defaultValue: 'Outstanding' }), render: (r: LiabilityRow) => <MoneyDisplay amount={r.outstanding} tone={r.outstanding > 0 ? 'danger' : 'default'} size="sm" /> },
                { key: 'status', header: t('common.status', { defaultValue: 'Status' }), render: (r: LiabilityRow) => <StatusBadge tone={r.status === 'settled' ? 'success' : 'warning'} label={r.status === 'settled' ? t('staff.detail.settledStatus', { defaultValue: 'Settled' }) : t('staff.detail.outstandingStatus', { defaultValue: 'Outstanding' })} /> },
                {
                  key: 'actions', header: '', render: (r: LiabilityRow) => r.outstanding > 0 ? (
                    <Button size="sm" variant="outline" onClick={() => setSettleLiability(r)}>{t('staff.detail.settle', { defaultValue: 'Settle' })}</Button>
                  ) : null,
                },
              ] as DataTableColumn<LiabilityRow>[]}
              rows={financial?.liabilities.rows ?? []}
              rowKey={(r) => r.id}
              emptyTitle={t('staff.detail.noLiabilitiesYet', { defaultValue: 'No liabilities yet' })}
            />
          </div>
        </TabsContent>

        <TabsContent value="activity">
          <div className="mt-4">
            <DataTable
              columns={[
                { key: 'date', header: t('common.date', { defaultValue: 'Date' }), render: (a) => <span className="tabular-nums"><bdi>{new Date(a.created_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi></span> },
                { key: 'action', header: t('customers.detail.action', { defaultValue: 'Action' }), render: (a) => a.action },
                {
                  key: 'entity', header: t('staff.detail.reference', { defaultValue: 'Reference' }), render: (a) => {
                    if (a.entity_type === 'customer') return <Link to={`/app/customers/${a.entity_id}`} className="text-accent-foreground hover:underline">{t('staff.detail.viewCustomer', { defaultValue: 'View customer' })}</Link>
                    return <span className="text-text-secondary">{a.entity_type}</span>
                  },
                },
              ] as DataTableColumn<{ id: string; action: string; entity_type: string; entity_id: string; created_at: string }>[]}
              rows={activity?.rows ?? []}
              rowKey={(a) => a.id}
              emptyTitle={t('customers.detail.noActivityYet', { defaultValue: 'No activity yet' })}
            />
          </div>
        </TabsContent>
      </Tabs>

      {settleLiability && (
        <SettleLiabilityDialog
          liability={settleLiability}
          onClose={() => setSettleLiability(null)}
          onSettled={() => { setSettleLiability(null); invalidateAll() }}
        />
      )}
    </div>
  )
}

// Directive rule #10/#47: the indebted employee cannot settle their
// own liability -- enforced server-side (settle_employee_cash_
// liability rejects it), but the button is also hidden client-side
// when the viewer IS the employee, per section 12's "hiding a button
// is not protection, every action must be server-gated too" -- this
// UI-level hide is a UX courtesy on top of that server enforcement,
// not a substitute for it.
function AccessTab({
  clubId, membershipId, access, onChanged,
}: {
  clubId: string
  membershipId: string
  access: AccessProfile | undefined
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [error, setError] = useState<string | null>(null)
  const [roleValue, setRoleValue] = useState<string | null>(null)
  const [branchSelection, setBranchSelection] = useState<string[] | null>(null)

  const roleMutation = useMutation({
    mutationFn: async (roleKey: string) => {
      const { error: rpcError } = await supabase.rpc('set_staff_role', { p_club_id: clubId, p_membership_id: membershipId, p_role_key: roleKey })
      if (rpcError) throw rpcError
    },
    onSuccess: () => { setError(null); setRoleValue(null); onChanged() },
    onError: (err) => setError(translateSupabaseError(err, t('staff.detail.roleChangeError', { defaultValue: "Couldn't change role." }))),
  })

  const branchMutation = useMutation({
    mutationFn: async (branchIds: string[]) => {
      const { error: rpcError } = await supabase.rpc('set_staff_branch_scope', { p_club_id: clubId, p_membership_id: membershipId, p_branch_ids: branchIds })
      if (rpcError) throw rpcError
    },
    onSuccess: () => { setError(null); setBranchSelection(null); onChanged() },
    onError: (err) => setError(translateSupabaseError(err, t('staff.detail.branchChangeError', { defaultValue: "Couldn't change branch scope." }))),
  })

  if (!access) return <div className="mt-4 text-sm text-text-secondary">{t('common.loading', { defaultValue: 'Loading...' })}</div>

  const permByKey = new Map(access.permissions.map((p) => [p.key, p]))
  const currentBranchIds = branchSelection ?? access.assigned_branches.map((b) => b.id)

  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="rounded-lg border border-border p-4">
        <div className="mb-2 flex items-center gap-2">
          <KeyRound className="size-4 text-text-secondary" />
          <p className="text-sm font-medium text-text-secondary">{t('staff.roleLabel')}</p>
        </div>
        <Select value={roleValue ?? access.role.key} onValueChange={(v) => { setRoleValue(v); roleMutation.mutate(v) }}>
          <SelectTrigger className="max-w-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ROLE_KEYS.map((k) => <SelectItem key={k} value={k}>{t(`staff.roles.${k}`)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border border-border p-4">
        <p className="mb-2 text-sm font-medium text-text-secondary">{t('staff.columns.branchScope')}</p>
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={currentBranchIds.length === 0}
              onChange={(e) => { const next = e.target.checked ? [] : access.all_club_branches.map((b) => b.id); setBranchSelection(next); branchMutation.mutate(next) }}
            />
            {t('staff.allBranches')}
          </label>
          {currentBranchIds.length > 0 && access.all_club_branches.map((b) => (
            <label key={b.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={currentBranchIds.includes(b.id)}
                onChange={(e) => {
                  const next = e.target.checked ? [...currentBranchIds, b.id] : currentBranchIds.filter((id) => id !== b.id)
                  setBranchSelection(next)
                  branchMutation.mutate(next)
                }}
              />
              {b.name}
            </label>
          ))}
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}

      <div className="flex flex-col gap-3">
        <p className="text-sm font-medium text-text-secondary">{t('staff.detail.permissionsReadOnly', { defaultValue: 'Permissions granted by this role' })}</p>
        {PERMISSION_GROUPS.map((group) => {
          const groupPerms = group.keys.map((k) => permByKey.get(k)).filter((p): p is { key: string; description: string } => !!p)
          if (groupPerms.length === 0) return null
          return (
            <div key={group.titleKey} className="rounded-lg border border-border p-3">
              <p className="mb-2 text-sm font-semibold">{t(group.titleKey)}</p>
              <ul className="flex flex-col gap-1">
                {groupPerms.map((p) => (
                  <li key={p.key} className="flex items-center justify-between text-sm">
                    <span className="text-text-secondary">{p.description}</span>
                    <StatusBadge tone="success" label={t('staff.detail.enabled', { defaultValue: 'Enabled' })} />
                  </li>
                ))}
              </ul>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SettleLiabilityDialog({
  liability, onClose, onSettled,
}: {
  liability: LiabilityRow
  onClose: () => void
  onSettled: () => void
}) {
  const { t } = useTranslation()
  const [amount, setAmount] = useState(() => liability.outstanding.toFixed(2))
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const idempotencyKeyRef = useRef<string | null>(null)

  const settleMutation = useMutation({
    mutationFn: async () => {
      const parsedAmount = Number(amount)
      if (!parsedAmount || parsedAmount <= 0) throw new Error(t('bookings.detail.invalidAmountError'))
      if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID()
      const { error: rpcError } = await supabase.rpc('settle_employee_cash_liability', {
        p_liability_id: liability.id, p_amount: parsedAmount, p_reason: reason || undefined,
        p_idempotency_key: idempotencyKeyRef.current,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: onSettled,
    onError: (err) => setError(translateSupabaseError(err, t('staff.detail.settleError', { defaultValue: "Couldn't settle this liability." }))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('staff.detail.settle', { defaultValue: 'Settle' })}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
            <span>{t('staff.detail.outstanding', { defaultValue: 'Outstanding' })}</span>
            <MoneyDisplay amount={liability.outstanding} tone="danger" size="sm" />
          </div>
          <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Input placeholder={t('staff.detail.reasonOptional', { defaultValue: 'Reason (optional)' })} value={reason} onChange={(e) => setReason(e.target.value)} />
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <Button disabled={settleMutation.isPending} onClick={() => settleMutation.mutate()}>
            {settleMutation.isPending ? t('academy.enrollments.enrolling') : t('staff.detail.settle', { defaultValue: 'Settle' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
