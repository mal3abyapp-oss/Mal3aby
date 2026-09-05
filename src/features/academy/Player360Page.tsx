import { useState } from 'react'
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
import { CustomerSelector, type SelectedCustomer } from '@/components/ui/customer-selector'
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
} from '@/components/ui/dialog'
import { formatMoney, PAYMENT_STATUS_LABELS, PAYMENT_STATUS_TONE, type PaymentStatus } from '@/lib/domain/billing'
import { SUBSCRIPTION_PLAN_LABELS } from '@/lib/domain/academy'
import { ArrowLeft, Wallet, GraduationCap, UsersRound, CalendarCheck, UserX } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'

// Academy Player/Guardian/Customer integrity closure: Player 360, the
// canonical detail/edit location for a player, matching Customer 360's
// established shape (PageHeader + StatCard summary + Tabs). Every
// guardian shown here is a real customers row -- Guardian is never a
// second identity, only a relationship (guardian_links) to an existing
// Customer. Every write on this page goes through the dedicated RPCs
// (create_player_with_guardian's siblings: update_player,
// link_guardian_to_player, unlink_guardian_from_player,
// set_primary_guardian) added alongside this page -- no raw table
// writes from the frontend.

type TabKey = 'overview' | 'guardians' | 'memberships' | 'financial' | 'attendance'

interface Guardian {
  guardian_link_id: string
  customer_id: string
  full_name: string
  phone_e164: string | null
  relationship: string
  is_primary: boolean
}

interface PlayerSummary {
  player: {
    id: string; full_name: string; date_of_birth: string | null; gender: string | null
    photo_url: string | null; status: string; created_at: string
  }
  guardians: Guardian[]
  primary_guardian: Guardian | null
  current_membership: {
    enrollment_id: string; group_name: string; subscription_id: string
    subscription_status: string; plan_type: string; start_date: string; end_date: string; price: number
  } | null
  financial: { total: number; paid: number; outstanding: number; payment_status: PaymentStatus } | null
  attendance_rate: number | null
}

async function fetchPlayerSummary(clubId: string, playerId: string): Promise<PlayerSummary> {
  const { data, error } = await supabase.rpc('get_player_360_summary', { p_club_id: clubId, p_player_id: playerId })
  if (error) throw error
  return data as unknown as PlayerSummary
}

interface SubscriptionRow {
  id: string; group_name: string; plan_type: string; status: string
  start_date: string; end_date: string; price: number
}
async function fetchSubscriptionHistory(playerId: string): Promise<SubscriptionRow[]> {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, plan_type, status, start_date, end_date, price, enrollment_id, enrollments!inner(player_id, groups(name))')
    .eq('enrollments.player_id', playerId)
    .order('created_at', { ascending: false })
    .limit(20)
  if (error) throw error
  return (data ?? []).map((r) => {
    const enrollment = r.enrollments as unknown as { groups: { name: string } | null }
    return {
      id: r.id, plan_type: r.plan_type, status: r.status,
      start_date: r.start_date, end_date: r.end_date, price: Number(r.price),
      group_name: enrollment?.groups?.name ?? '—',
    }
  })
}

interface AttendanceRow { id: string; status: string; marked_at: string; session_id: string }
async function fetchAttendanceHistory(playerId: string): Promise<AttendanceRow[]> {
  const { data, error } = await supabase
    .from('attendance')
    .select('id, status, marked_at, session_id')
    .eq('player_id', playerId)
    .order('marked_at', { ascending: false })
    .limit(30)
  if (error) throw error
  return data ?? []
}

// Reports + Invoices + Universal Entity Drill-Down audit: get_player_360_
// summary's current_membership only carries subscription_id, not
// invoice_id -- "Collect payment" was navigating to
// /app/finance/payments?invoice=<subscription_id>, a wrong-entity-type
// bug (BillingPage's fetchInvoiceDetail does .eq('id', invoiceId)
// against the invoices table, so a subscription id there never
// matches any row -- the dialog silently opened empty). Same
// single-column lookup pattern already established for
// BookingDetailSheet's fetchInvoiceNumber, not a new RPC.
async function fetchSubscriptionInvoiceId(subscriptionId: string): Promise<string | null> {
  const { data, error } = await supabase.from('subscriptions').select('invoice_id').eq('id', subscriptionId).single()
  if (error) return null
  return data?.invoice_id ?? null
}

export function Player360Page() {
  const { playerId } = useParams<{ playerId: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<TabKey>('overview')
  const [editOpen, setEditOpen] = useState(false)
  const [addGuardianOpen, setAddGuardianOpen] = useState(false)
  // Production audit finding M-related note (native window.confirm()
  // swap, trivial while in this area for H-3): same reveal-then-confirm
  // pattern as StaffPage.tsx/RolesPage.tsx's H-3 fixes -- per-row state
  // keyed by guardian_link_id since this is a DataTable row action.
  const [confirmingUnlinkId, setConfirmingUnlinkId] = useState<string | null>(null)

  const { data: summary, isLoading, isError } = useQuery({
    queryKey: ['player-360-summary', currentClubId, playerId],
    queryFn: () => fetchPlayerSummary(currentClubId!, playerId!),
    enabled: !!currentClubId && !!playerId,
    retry: false,
  })

  const currentSubscriptionId = summary?.current_membership?.subscription_id
  const { data: currentInvoiceId } = useQuery({
    queryKey: ['subscription-invoice-id', currentSubscriptionId],
    queryFn: () => fetchSubscriptionInvoiceId(currentSubscriptionId!),
    enabled: !!currentSubscriptionId,
  })

  const { data: subscriptions } = useQuery({
    queryKey: ['player-360-subscriptions', playerId],
    queryFn: () => fetchSubscriptionHistory(playerId!),
    enabled: !!playerId && activeTab === 'memberships',
  })

  const { data: attendance } = useQuery({
    queryKey: ['player-360-attendance', playerId],
    queryFn: () => fetchAttendanceHistory(playerId!),
    enabled: !!playerId && activeTab === 'attendance',
  })

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ['player-360-summary', currentClubId, playerId] })
    void queryClient.invalidateQueries({ queryKey: ['player-360-subscriptions', playerId] })
  }

  const setPrimaryMutation = useMutation({
    mutationFn: async (customerId: string) => {
      const { error } = await supabase.rpc('set_primary_guardian', { p_player_id: playerId!, p_customer_id: customerId })
      if (error) throw error
    },
    onSuccess: invalidateAll,
  })

  const unlinkMutation = useMutation({
    mutationFn: async (guardianLinkId: string) => {
      const { error } = await supabase.rpc('unlink_guardian_from_player', { p_guardian_link_id: guardianLinkId })
      if (error) throw error
    },
    onSuccess: () => {
      setConfirmingUnlinkId(null)
      invalidateAll()
    },
  })

  if (isError) {
    return (
      <EmptyState
        icon={UserX}
        title={t('academy.players.playerNotFoundOrDenied', { defaultValue: "This player couldn't be found, or you don't have access to view them." })}
        action={
          <Button variant="outline" size="sm" onClick={() => navigate('/app/academy')}>
            {t('academy.title', { defaultValue: 'Academy' })}
          </Button>
        }
      />
    )
  }

  if (isLoading || !summary) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  const p = summary.player

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <button onClick={() => navigate('/app/academy')} className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary">
          <ArrowLeft className="size-4 rtl:rotate-180" />
          {t('academy.title', { defaultValue: 'Academy' })}
        </button>
      </div>

      <PageHeader
        title={p.full_name}
        description={
          // Real bug found in live QA (2026-08-30): this fell straight to
          // "No guardians linked" whenever there was no PRIMARY guardian --
          // including when a guardian had genuinely just been linked but
          // not yet marked primary, which reads as "your save didn't
          // work" to a real user. Now distinguishes the two states using
          // summary.guardians (the full linked list), not just
          // primary_guardian.
          summary.primary_guardian
            ? `${t('academy.players.primary', { defaultValue: 'Primary' })}: ${summary.primary_guardian.full_name}`
            : summary.guardians.length > 0
              ? t('academy.players.guardiansLinkedNoPrimary', { defaultValue: 'No primary guardian set' })
              : t('academy.players.noGuardians', { defaultValue: 'No guardians linked' })
        }
        actions={
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>{t('common.edit')}</Button>
          </div>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
        <StatCard label={t('common.status', { defaultValue: 'Status' })} value={p.status === 'active' ? t('academy.players.statusActive', { defaultValue: 'Active' }) : t('academy.players.statusInactive', { defaultValue: 'Inactive' })} icon={UsersRound} />
        <StatCard label={t('academy.memberships.name', { defaultValue: 'Membership' })} value={summary.current_membership?.group_name ?? t('academy.players.noActiveSubscription', { defaultValue: 'No active subscription' })} icon={GraduationCap} />
        <StatCard label={t('customers.outstanding', { defaultValue: 'Outstanding' })} value={formatMoney(summary.financial?.outstanding ?? 0, 'EGP', locale)} icon={Wallet} tone={(summary.financial?.outstanding ?? 0) > 0 ? 'danger' : 'default'} />
        <StatCard label={t('academy.tabs.attendance', { defaultValue: 'Attendance' })} value={summary.attendance_rate != null ? `${summary.attendance_rate}%` : '—'} icon={CalendarCheck} />
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="overview">{t('staff.detail.tabs.overview', { defaultValue: 'Overview' })}</TabsTrigger>
          <TabsTrigger value="guardians">{t('academy.players.guardians', { defaultValue: 'Guardians' })}</TabsTrigger>
          <TabsTrigger value="memberships">{t('academy.tabs.memberships', { defaultValue: 'Memberships & Subscriptions' })}</TabsTrigger>
          <TabsTrigger value="financial">{t('customers.detail.tabs.financial', { defaultValue: 'Financial' })}</TabsTrigger>
          <TabsTrigger value="attendance">{t('academy.tabs.attendance', { defaultValue: 'Attendance' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="mt-4 flex flex-col gap-4">
            <div className="rounded-lg border border-border p-4">
              <p className="mb-2 text-sm font-medium text-text-secondary">{t('academy.players.fullName', { defaultValue: 'Full name' })}</p>
              <p className="text-sm">{p.full_name}</p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border border-border p-4">
                <p className="mb-1 text-sm font-medium text-text-secondary">{t('academy.players.dateOfBirth', { defaultValue: 'Date of birth' })}</p>
                <p className="text-sm tabular-nums"><bdi>{p.date_of_birth ?? '—'}</bdi></p>
              </div>
              <div className="rounded-lg border border-border p-4">
                <p className="mb-1 text-sm font-medium text-text-secondary">{t('academy.players.gender', { defaultValue: 'Gender' })}</p>
                <p className="text-sm">{p.gender === 'male' ? t('academy.players.genderMale', { defaultValue: 'Male' }) : p.gender === 'female' ? t('academy.players.genderFemale', { defaultValue: 'Female' }) : t('academy.players.genderUnspecified', { defaultValue: 'Not specified' })}</p>
              </div>
            </div>
            {!summary.current_membership && (
              <div className="rounded-lg border border-dashed border-border p-4 text-center">
                <p className="mb-2 text-sm text-text-secondary">{t('academy.players.noActiveSubscription', { defaultValue: 'No active subscription' })}</p>
                <Button size="sm" onClick={() => navigate(`/app/academy?subscribePlayer=${p.id}`)}>{t('academy.players.subscribe', { defaultValue: 'Subscribe to membership' })}</Button>
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="guardians">
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setAddGuardianOpen(true)}>{t('academy.players.linkNewGuardian', { defaultValue: 'Add guardian' })}</Button>
            </div>
            <DataTable
              columns={[
                {
                  key: 'name', header: t('common.name'), render: (g: Guardian) => (
                    <Link to={`/app/customers/${g.customer_id}`} className="text-accent-foreground hover:underline">{g.full_name}</Link>
                  ),
                },
                { key: 'phone', header: t('common.phone'), render: (g: Guardian) => g.phone_e164 ? <span dir="ltr">{g.phone_e164}</span> : '—' },
                { key: 'relationship', header: t('academy.players.guardianColumn', { defaultValue: 'Relationship' }), render: (g: Guardian) => t(`customers.relationshipLabels.${g.relationship}`, { defaultValue: g.relationship }) },
                { key: 'primary', header: t('academy.players.primary', { defaultValue: 'Primary' }), render: (g: Guardian) => g.is_primary ? <StatusBadge tone="success" label={t('academy.players.primary', { defaultValue: 'Primary' })} /> : (
                  <Button size="sm" variant="outline" disabled={setPrimaryMutation.isPending} onClick={() => setPrimaryMutation.mutate(g.customer_id)}>
                    {t('academy.players.setPrimary', { defaultValue: 'Set primary' })}
                  </Button>
                ) },
                {
                  key: 'actions', header: '', render: (g: Guardian) => (
                    confirmingUnlinkId === g.guardian_link_id ? (
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          disabled={unlinkMutation.isPending}
                          onClick={() => unlinkMutation.mutate(g.guardian_link_id)}
                        >
                          {unlinkMutation.isPending
                            ? t('academy.players.removingGuardian', { defaultValue: 'Removing...' })
                            : t('academy.players.confirmUnlinkGuardianButton', { defaultValue: 'Confirm remove' })}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmingUnlinkId(null)}>
                          {t('common.cancel')}
                        </Button>
                      </div>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => setConfirmingUnlinkId(g.guardian_link_id)}>
                        {t('common.delete', { defaultValue: 'Remove' })}
                      </Button>
                    )
                  ),
                },
              ] as DataTableColumn<Guardian>[]}
              rows={summary.guardians}
              rowKey={(g) => g.guardian_link_id}
              emptyTitle={t('academy.players.noGuardians', { defaultValue: 'No guardians linked' })}
            />
          </div>
        </TabsContent>

        <TabsContent value="memberships">
          <div className="mt-4">
            <DataTable
              columns={[
                { key: 'group', header: t('academy.memberships.name', { defaultValue: 'Membership' }), render: (s: SubscriptionRow) => s.group_name },
                { key: 'plan', header: t('academy.enrollments.planType', { defaultValue: 'Plan' }), render: (s: SubscriptionRow) => SUBSCRIPTION_PLAN_LABELS[s.plan_type] ?? s.plan_type },
                { key: 'start', header: t('academy.enrollments.startDate', { defaultValue: 'Start' }), render: (s: SubscriptionRow) => <span className="tabular-nums"><bdi>{s.start_date}</bdi></span> },
                { key: 'end', header: t('academy.enrollments.endDate', { defaultValue: 'End' }), render: (s: SubscriptionRow) => <span className="tabular-nums"><bdi>{s.end_date}</bdi></span> },
                { key: 'price', header: t('common.price', { defaultValue: 'Price' }), render: (s: SubscriptionRow) => <MoneyDisplay amount={s.price} size="sm" /> },
                { key: 'status', header: t('common.status', { defaultValue: 'Status' }), render: (s: SubscriptionRow) => <StatusBadge tone={s.status === 'active' ? 'success' : s.status === 'pending' ? 'warning' : 'neutral'} label={t(`academy.subscriptionStatusLabels.${s.status}`, { defaultValue: s.status })} /> },
              ] as DataTableColumn<SubscriptionRow>[]}
              rows={subscriptions ?? []}
              rowKey={(s) => s.id}
              emptyTitle={t('academy.players.noActiveSubscription', { defaultValue: 'No active subscription' })}
            />
          </div>
        </TabsContent>

        <TabsContent value="financial">
          <div className="mt-4 flex flex-col gap-4">
            {summary.financial && (
              <div className="grid grid-cols-3 gap-3">
                <StatCard label={t('common.total', { defaultValue: 'Total' })} value={formatMoney(summary.financial.total, 'EGP', locale)} />
                <StatCard label={t('customers.detail.totalPaid', { defaultValue: 'Paid' })} value={formatMoney(summary.financial.paid, 'EGP', locale)} />
                <StatCard label={t('customers.outstanding', { defaultValue: 'Outstanding' })} value={formatMoney(summary.financial.outstanding, 'EGP', locale)} tone={summary.financial.outstanding > 0 ? 'danger' : 'default'} />
              </div>
            )}
            {summary.financial && (
              <div className="flex items-center justify-between rounded-lg border border-border p-4">
                <StatusBadge tone={PAYMENT_STATUS_TONE[summary.financial.payment_status] ?? 'neutral'} label={t(`secureBooking.paymentStatusLabels.${summary.financial.payment_status}`, { defaultValue: PAYMENT_STATUS_LABELS[summary.financial.payment_status] ?? summary.financial.payment_status })} />
                {summary.financial.outstanding > 0 && currentInvoiceId && (
                  <Button size="sm" onClick={() => navigate(`/app/finance/invoices?invoice=${currentInvoiceId}`)}>
                    {t('academy.players.collectPayment', { defaultValue: 'Collect payment' })}
                  </Button>
                )}
              </div>
            )}
            {!summary.financial && <p className="text-sm text-text-secondary">{t('customers.detail.noInvoicesYet', { defaultValue: 'No invoices yet' })}</p>}
          </div>
        </TabsContent>

        <TabsContent value="attendance">
          <div className="mt-4">
            <DataTable
              columns={[
                { key: 'date', header: t('common.date', { defaultValue: 'Date' }), render: (a: AttendanceRow) => <span className="tabular-nums"><bdi>{new Date(a.marked_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG')}</bdi></span> },
                { key: 'status', header: t('common.status', { defaultValue: 'Status' }), render: (a: AttendanceRow) => <StatusBadge tone={a.status === 'present' ? 'success' : a.status === 'absent' ? 'danger' : 'warning'} label={t(`academy.attendanceStatusLabels.${a.status}`, { defaultValue: a.status })} /> },
              ] as DataTableColumn<AttendanceRow>[]}
              rows={attendance ?? []}
              rowKey={(a) => a.id}
              emptyTitle={t('academy.attendance.emptyTitle', { defaultValue: 'No attendance recorded yet' })}
            />
          </div>
        </TabsContent>
      </Tabs>

      {editOpen && (
        <EditPlayerDialog
          player={p}
          onClose={() => setEditOpen(false)}
          onSaved={() => { setEditOpen(false); invalidateAll() }}
        />
      )}

      {addGuardianOpen && (
        <AddGuardianDialog
          clubId={currentClubId!}
          playerId={p.id}
          onClose={() => setAddGuardianOpen(false)}
          onLinked={() => { setAddGuardianOpen(false); invalidateAll() }}
        />
      )}
    </div>
  )
}

function EditPlayerDialog({
  player, onClose, onSaved,
}: {
  player: PlayerSummary['player']
  onClose: () => void
  onSaved: () => void
}) {
  const { t } = useTranslation()
  const [fullName, setFullName] = useState(player.full_name)
  const [dateOfBirth, setDateOfBirth] = useState(player.date_of_birth ?? '')
  const [gender, setGender] = useState(player.gender ?? '')
  const [status, setStatus] = useState(player.status)
  const [error, setError] = useState<string | null>(null)

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { error: rpcError } = await supabase.rpc('update_player', {
        p_player_id: player.id,
        p_full_name: fullName,
        p_date_of_birth: dateOfBirth || undefined,
        p_gender: gender || undefined,
        p_status: status,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: onSaved,
    onError: (err) => setError(translateSupabaseError(err, t('academy.players.saveError', { defaultValue: "Couldn't save player." }))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('common.edit')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('academy.players.fullName', { defaultValue: 'Full name' })}</label>
            <Input required value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('academy.players.dateOfBirth', { defaultValue: 'Date of birth' })}</label>
            <Input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('academy.players.gender', { defaultValue: 'Gender' })}</label>
            <Select value={gender || 'unspecified'} onValueChange={(v) => setGender(v === 'unspecified' ? '' : v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="unspecified">{t('academy.players.genderUnspecified', { defaultValue: 'Not specified' })}</SelectItem>
                <SelectItem value="male">{t('academy.players.genderMale', { defaultValue: 'Male' })}</SelectItem>
                <SelectItem value="female">{t('academy.players.genderFemale', { defaultValue: 'Female' })}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('academy.players.status', { defaultValue: 'Status' })}</label>
            <Select value={status} onValueChange={setStatus}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="active">{t('academy.players.statusActive', { defaultValue: 'Active' })}</SelectItem>
                <SelectItem value="inactive">{t('academy.players.statusInactive', { defaultValue: 'Inactive' })}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <Button disabled={!fullName.trim() || saveMutation.isPending} onClick={() => saveMutation.mutate()}>
            {saveMutation.isPending ? t('academy.players.saving') : t('common.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function AddGuardianDialog({
  clubId, playerId, onClose, onLinked,
}: {
  clubId: string
  playerId: string
  onClose: () => void
  onLinked: () => void
}) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<SelectedCustomer | null>(null)
  const [relationship, setRelationship] = useState('guardian')
  const [isPrimary, setIsPrimary] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const linkMutation = useMutation({
    mutationFn: async () => {
      if (!selected) throw new Error(t('academy.players.chooseCustomer', { defaultValue: 'Choose a customer' }))
      const { error: rpcError } = await supabase.rpc('link_guardian_to_player', {
        p_player_id: playerId,
        p_customer_id: selected.id,
        p_relationship: relationship,
        p_is_primary: isPrimary,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: onLinked,
    onError: (err) => setError(translateSupabaseError(err, t('academy.players.linkGuardianError', { defaultValue: "Couldn't add this guardian." }))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('academy.players.linkNewGuardian', { defaultValue: 'Add guardian' })}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <CustomerSelector clubId={clubId} value={selected} onSelect={setSelected} />
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-secondary">{t('academy.players.guardianColumn', { defaultValue: 'Relationship' })}</label>
            <Select value={relationship} onValueChange={setRelationship}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="father">{t('customers.relationshipLabels.father', { defaultValue: 'Father' })}</SelectItem>
                <SelectItem value="mother">{t('customers.relationshipLabels.mother', { defaultValue: 'Mother' })}</SelectItem>
                <SelectItem value="guardian">{t('customers.relationshipLabels.guardian', { defaultValue: 'Guardian' })}</SelectItem>
                <SelectItem value="other">{t('customers.relationshipLabels.other', { defaultValue: 'Other' })}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={isPrimary} onChange={(e) => setIsPrimary(e.target.checked)} />
            {t('academy.players.setPrimary', { defaultValue: 'Set as primary guardian' })}
          </label>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <Button disabled={!selected || linkMutation.isPending} onClick={() => linkMutation.mutate()}>
            {linkMutation.isPending ? t('academy.players.saving') : t('academy.players.link', { defaultValue: 'Link' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
