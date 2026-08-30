import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { translateSupabaseError } from '@/lib/errors'
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
import { useOfficialReceipt, OfficialCollectionReceiptFields } from '@/components/ui/official-collection-receipt-fields'
import { PAYMENT_METHOD_LABELS, fetchInvoicePaymentSummaries } from '@/lib/domain/billing'
import { addMonthsToDate, getAcademySubscriptionDisplayStatus, type EnrollmentRow } from '@/lib/domain/academy'
import { Users } from 'lucide-react'

// Academy radical simplification directive: "Membership" is the
// primary product (sections 2-4). This screen replaces the old
// top-level "Structure" tab -- the underlying table is still `groups`
// (unchanged, per section 28: no destructive migration), but every
// label, form, and flow here speaks "Membership" because that's the
// concept staff actually work with day to day.
//
// LEGACY ACADEMY MUST BE INVISIBLE directive (2026-08-23): the
// Program/Season/Age Group/Coach/legacy-Schedule management UI
// (formerly ProgramsGroupsSection, reachable here via a "خيارات
// متقدمة / قديمة" disclosure toggle) has been removed from this
// screen entirely -- not collapsed behind a button, genuinely deleted
// from the active user experience, per that directive's explicit
// "لا أريد إخفاءها خلف زر... أريدها REMOVED FROM ACTIVE USER
// EXPERIENCE" rule. Confirmed safe before removal: groups.program_id/
// season_id/age_group_id/coach_id/assistant_coach_id/field_id are all
// nullable columns (verified live against the schema), and this
// screen's own createMutation already never sets any of them --
// Membership creation/editing was already fully independent of the
// legacy fields. Real historical data on existing groups (6 of 8 real
// production groups have program_id/season_id set) is preserved
// untouched in the database -- only the UI that created/edited/
// displayed it is gone. ProgramsGroupsSection.tsx itself has been
// deleted (confirmed zero other importers before deletion) rather
// than merely unlinked, since a per-directive "removed" bar means
// gone from the codebase's active surface, not just unreachable dead
// code left to accumulate.
interface MembershipRow {
  id: string
  branchId: string
  name: string
  capacity: number
  status: string
  subscriptionPrice: number | null
  activePlayerCount: number
}

async function fetchMemberships(clubId: string): Promise<MembershipRow[]> {
  const { data, error } = await supabase
    .from('groups')
    .select('id, branch_id, name, capacity, status, subscription_price')
    .eq('club_id', clubId)
    .order('created_at', { ascending: false })
  if (error) throw error

  const groupIds = (data ?? []).map((g) => g.id)
  const counts = new Map<string, number>()
  if (groupIds.length > 0) {
    const { data: enrollments } = await supabase
      .from('enrollments')
      .select('group_id')
      .in('group_id', groupIds)
      .eq('status', 'active')
    for (const e of enrollments ?? []) counts.set(e.group_id, (counts.get(e.group_id) ?? 0) + 1)
  }

  return (data ?? []).map((g) => ({
    id: g.id,
    branchId: g.branch_id,
    name: g.name,
    capacity: g.capacity,
    status: g.status,
    subscriptionPrice: g.subscription_price != null ? Number(g.subscription_price) : null,
    activePlayerCount: counts.get(g.id) ?? 0,
  }))
}

async function fetchBranches(clubId: string) {
  const { data, error } = await supabase.from('branches').select('id, name').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

async function fetchPlayers(clubId: string) {
  const { data, error } = await supabase.from('players').select('id, full_name').eq('club_id', clubId).eq('status', 'active').order('full_name')
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

async function fetchSubscribers(groupId: string) {
  const { data, error } = await supabase
    .from('enrollments')
    .select('id, player_id, group_id, status, enrolled_at, players(full_name)')
    .eq('group_id', groupId)
    .eq('status', 'active')
    .order('enrolled_at', { ascending: false })
  if (error) throw error
  const rows = (data ?? []).map((e) => ({
    id: e.id,
    playerId: e.player_id,
    groupId: e.group_id,
    status: e.status,
    enrolledAt: e.enrolled_at,
    playerName: (e.players as unknown as { full_name: string } | null)?.full_name,
  })) as EnrollmentRow[]

  const enrollmentIds = rows.map((r) => r.id)
  const subsByEnrollment = new Map<string, { id: string; startDate: string; endDate: string; status: string; price: number; discount: number; invoiceId: string | null }>()
  if (enrollmentIds.length > 0) {
    const { data: subs } = await supabase
      .from('subscriptions')
      .select('id, enrollment_id, start_date, end_date, status, price, discount, invoice_id')
      .in('enrollment_id', enrollmentIds)
      .order('created_at', { ascending: false })
    for (const s of subs ?? []) {
      if (!subsByEnrollment.has(s.enrollment_id)) {
        subsByEnrollment.set(s.enrollment_id, {
          id: s.id, startDate: s.start_date, endDate: s.end_date, status: s.status,
          price: Number(s.price), discount: Number(s.discount), invoiceId: s.invoice_id,
        })
      }
    }
  }

  const invoiceIds = [...subsByEnrollment.values()].map((s) => s.invoiceId).filter((x): x is string => !!x)
  const outstandingByInvoice = new Map<string, number>()
  if (invoiceIds.length > 0) {
    const summaries = await fetchInvoicePaymentSummaries(invoiceIds)
    for (const [id, s] of summaries) outstandingByInvoice.set(id, s.outstanding)
  }

  return rows.map((r) => {
    const sub = subsByEnrollment.get(r.id)
    return {
      ...r,
      subscription: sub ?? null,
      outstanding: sub?.invoiceId ? outstandingByInvoice.get(sub.invoiceId) ?? 0 : 0,
    }
  })
}

export function MembershipsSection() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()

  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [branchId, setBranchId] = useState('')
  const [price, setPrice] = useState('')
  const [capacity, setCapacity] = useState('20')
  const [createError, setCreateError] = useState<string | null>(null)

  const [selectedMembership, setSelectedMembership] = useState<MembershipRow | null>(null)
  const [editingMembership, setEditingMembership] = useState<MembershipRow | null>(null)
  const [subscribeOpen, setSubscribeOpen] = useState(false)

  const { data: branches = [] } = useQuery({ queryKey: ['branches-for-academy-memberships', currentClubId], queryFn: () => fetchBranches(currentClubId!), enabled: !!currentClubId })
  const { data: memberships = [], isLoading } = useQuery({ queryKey: ['academy-memberships', currentClubId], queryFn: () => fetchMemberships(currentClubId!), enabled: !!currentClubId })

  useEffect(() => {
    if (!createOpen) {
      setName('')
      setBranchId(branches[0]?.id ?? '')
      setPrice('')
      setCapacity('20')
      setCreateError(null)
    }
  }, [createOpen, branches])

  const createMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('groups').insert({
        club_id: currentClubId as string,
        branch_id: branchId,
        name,
        capacity: Number(capacity),
        subscription_price: price ? Number(price) : null,
        status: 'active',
      })
      if (error) throw error
    },
    onSuccess: () => {
      setCreateOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['academy-memberships', currentClubId] })
    },
    onError: (error) => setCreateError(translateSupabaseError(error, t('academy.memberships.createError'))),
  })

  const membershipColumns: DataTableColumn<MembershipRow>[] = [
    {
      key: 'name',
      header: t('academy.memberships.name'),
      render: (m) => (
        <button className="font-medium text-accent-foreground hover:underline" onClick={() => setSelectedMembership(m)}>
          {m.name}
        </button>
      ),
    },
    { key: 'duration', header: t('academy.memberships.duration'), render: () => t('academy.memberships.oneMonth') },
    { key: 'price', header: t('academy.memberships.price'), render: (m) => (m.subscriptionPrice != null ? <MoneyDisplay amount={m.subscriptionPrice} size="sm" /> : <span className="text-status-danger">{t('academy.memberships.noPriceSet')}</span>) },
    { key: 'players', header: t('academy.memberships.activePlayers'), render: (m) => m.activePlayerCount },
    { key: 'status', header: t('academy.memberships.status'), render: (m) => <StatusBadge tone={m.status === 'active' ? 'success' : m.status === 'full' ? 'warning' : 'neutral'} label={t(`academy.memberships.statusLabels.${m.status}`, { defaultValue: m.status })} /> },
  ]

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-text-secondary">{t('academy.memberships.subtitle')}</p>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button size="sm">{t('academy.memberships.newMembership')}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>{t('academy.memberships.newMembership')}</DialogTitle></DialogHeader>
            {/* Academy radical simplification directive section 4: name,
                duration (fixed at one month -- matches the architecture's
                current monthly-only reality, section 61 audit finding),
                price, status/branch. No Program/Season/Age Group/Coach
                required to create a sellable membership. */}
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('academy.memberships.name')}</label>
                <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder={t('academy.memberships.namePlaceholder')} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('academy.memberships.duration')}</label>
                <Input disabled value={t('academy.memberships.oneMonth')} />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('academy.memberships.price')}</label>
                <Input required type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
              </div>
              {branches.length > 1 && (
                <div className="flex flex-col gap-1.5">
                  <label className="text-sm font-medium text-text-secondary">{t('academy.structure.branch')}</label>
                  <Select value={branchId} onValueChange={setBranchId}>
                    <SelectTrigger><SelectValue placeholder={t('academy.structure.branch')} /></SelectTrigger>
                    <SelectContent>{branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-text-secondary">{t('academy.structure.capacityPlaceholder')}</label>
                <Input type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
              </div>
              {createError && <p role="alert" className="text-sm text-status-danger">{createError}</p>}
              <Button
                disabled={!name.trim() || !price.trim() || !branchId || createMutation.isPending}
                onClick={() => createMutation.mutate()}
              >
                {createMutation.isPending ? t('academy.memberships.creating') : t('academy.memberships.create')}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <DataTable
        columns={membershipColumns}
        rows={memberships}
        rowKey={(m) => m.id}
        isLoading={isLoading}
        emptyTitle={t('academy.memberships.emptyTitle')}
        emptyDescription={t('academy.memberships.emptyDescription')}
      />

      {selectedMembership && (
        <MembershipDetailDialog
          membership={selectedMembership}
          onClose={() => setSelectedMembership(null)}
          onSubscribe={() => setSubscribeOpen(true)}
          onEdit={() => setEditingMembership(selectedMembership)}
        />
      )}

      {editingMembership && (
        <EditMembershipDialog
          membership={editingMembership}
          onClose={() => setEditingMembership(null)}
          onSaved={() => {
            setEditingMembership(null)
            setSelectedMembership(null)
            void queryClient.invalidateQueries({ queryKey: ['academy-memberships', currentClubId] })
          }}
        />
      )}

      {subscribeOpen && selectedMembership && (
        <SubscribeWizard
          membership={selectedMembership}
          onClose={() => setSubscribeOpen(false)}
          onSubscribed={() => {
            setSubscribeOpen(false)
            void queryClient.invalidateQueries({ queryKey: ['academy-memberships', currentClubId] })
          }}
        />
      )}
    </div>
  )
}

// Directive section 23: opening a Membership shows its subscribers --
// Player/Start/End/Status/Paid/Outstanding, with Open Player/Renew/
// Collect Payment actions.
function MembershipDetailDialog({
  membership,
  onClose,
  onSubscribe,
  onEdit,
}: {
  membership: MembershipRow
  onClose: () => void
  onSubscribe: () => void
  onEdit: () => void
}) {
  const { t } = useTranslation()
  const { data: subscribers = [], isLoading } = useQuery({
    queryKey: ['membership-subscribers', membership.id],
    queryFn: () => fetchSubscribers(membership.id),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>{membership.name}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between rounded-lg border border-border bg-muted/20 p-3 text-sm">
            <div className="flex items-center gap-2">
              <Users className="size-4 text-text-secondary" />
              <span>{t('academy.memberships.activePlayers')}: <strong>{membership.activePlayerCount}</strong></span>
            </div>
            {membership.subscriptionPrice != null && <MoneyDisplay amount={membership.subscriptionPrice} size="sm" />}
          </div>
          <div className="flex gap-2">
            <Button className="flex-1" onClick={onSubscribe} disabled={membership.status !== 'active'}>{t('academy.memberships.addPlayerToMembership')}</Button>
            <Button variant="outline" onClick={onEdit}>{t('common.edit')}</Button>
          </div>

          {isLoading ? (
            <p className="text-sm text-text-secondary">{t('academy.loading')}</p>
          ) : subscribers.length === 0 ? (
            <p className="text-sm text-text-secondary">{t('academy.memberships.noSubscribersYet')}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {subscribers.map((s) => {
                const displayStatus = s.subscription ? getAcademySubscriptionDisplayStatus(s.subscription.status, s.subscription.endDate) : 'none'
                return (
                  <div key={s.id} className="flex flex-col gap-1 rounded-md border border-border p-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="font-medium">{s.playerName}</span>
                      <StatusBadge
                        tone={displayStatus === 'active' ? 'success' : displayStatus === 'due' || displayStatus === 'frozen' ? 'warning' : displayStatus === 'expired' ? 'danger' : 'neutral'}
                        label={t(`academy.subscriptionStatusLabels.${displayStatus}`, { defaultValue: displayStatus })}
                      />
                    </div>
                    {s.subscription && (
                      <p className="text-text-secondary">{t('academy.enrollments.dateRange', { start: s.subscription.startDate, end: s.subscription.endDate })}</p>
                    )}
                    <div className="flex items-center justify-between">
                      <span className="text-text-secondary">{t('academy.playerStatus.outstanding')}</span>
                      {s.outstanding > 0 ? <MoneyDisplay amount={s.outstanding} tone="danger" size="sm" /> : <span className="text-status-success">{t('academy.playerStatus.fullyPaid')}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function EditMembershipDialog({ membership, onClose, onSaved }: { membership: MembershipRow; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation()
  const [name, setName] = useState(membership.name)
  const [price, setPrice] = useState(String(membership.subscriptionPrice ?? ''))
  const [capacity, setCapacity] = useState(String(membership.capacity))
  const [status, setStatus] = useState(membership.status === 'closed' ? 'closed' : 'active')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: async () => {
      const { error: updateError } = await supabase.rpc('update_academy_membership', {
        p_group_id: membership.id,
        p_name: name.trim(),
        p_capacity: Number(capacity),
        p_subscription_price: Number(price),
        p_status: status,
        p_reason: status === 'closed' ? 'Membership archived from academy settings' : 'Membership definition updated',
      })
      if (updateError) throw updateError
    },
    onSuccess: onSaved,
    onError: (err) => setError(translateSupabaseError(err, t('academy.memberships.createError'))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('common.edit')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
          <Input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
          <Input type="number" min={1} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="active">{t('academy.memberships.statusLabels.active')}</SelectItem>
              <SelectItem value="closed">{t('academy.memberships.statusLabels.closed')}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-text-secondary">{t('platform.plansPage.editDialog.priceChangeNote')}</p>
          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          <Button disabled={!name.trim() || Number(price) < 0 || Number(capacity) < 1 || mutation.isPending} onClick={() => mutation.mutate()}>
            {t('billing.paymentMethods.save')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Directive sections 9-15: THE primary flow. Select Player -> auto
// price/date -> Collect Now/Later -> Confirm, all in one screen. No
// Program/Season/Group-chain to navigate, and payment collection is
// inline instead of a deep-link handoff to a separate page.
function SubscribeWizard({
  membership,
  onClose,
  onSubscribed,
}: {
  membership: MembershipRow
  onClose: () => void
  onSubscribed: () => void
}) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()

  const [playerId, setPlayerId] = useState('')
  const [guardianId, setGuardianId] = useState('')
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [discount, setDiscount] = useState('0')
  const [collectNow, setCollectNow] = useState(true)
  const [method, setMethod] = useState('cash')
  const [wizardError, setWizardError] = useState<string | null>(null)
  // SAAS ACCEPTANCE REVIEW (2026-08-29): this dialog's "collect now"
  // payment call never passed p_idempotency_key, unlike the
  // already-hardened Bookings/Billing/Customer360/Shop-POS payment
  // sites -- see the matching fix/comment in academy/PlayersSection.tsx.
  const paymentIdempotencyKeyRef = useRef(crypto.randomUUID())

  const endDate = addMonthsToDate(startDate, 1)
  const price = membership.subscriptionPrice ?? 0
  const total = Math.max(price - Number(discount || 0), 0)

  const { data: players = [] } = useQuery({ queryKey: ['players-for-subscribe', currentClubId], queryFn: () => fetchPlayers(currentClubId!), enabled: !!currentClubId })
  const { data: guardians = [] } = useQuery({ queryKey: ['guardians-for-subscribe', playerId], queryFn: () => fetchGuardiansForPlayer(playerId), enabled: !!playerId })

  useEffect(() => {
    if (guardians.length === 1 && guardians[0]) setGuardianId(guardians[0].id)
    else setGuardianId('')
  }, [guardians])

  const receipt = useOfficialReceipt({
    clubId: currentClubId,
    branchId: membership.branchId,
    fieldId: null,
    method,
    enabled: collectNow,
  })

  const subscribeMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('create_enrollment_with_subscription', {
        p_player_id: playerId,
        p_group_id: membership.id,
        p_guardian_id: guardianId,
        p_plan_type: 'monthly',
        p_start_date: startDate,
        p_end_date: endDate,
        p_price: price,
        p_discount: Number(discount || 0),
      })
      if (error) throw error
      const invoiceId = data?.[0]?.invoice_id as string | undefined

      // Directive section 14: "Collect Now" runs inside the SAME
      // journey -- no trip to Finance to find the invoice. Reuses the
      // exact same record_payment/record_payment_with_official_receipt
      // RPCs Finance/Booking use (directive section 15: one payment
      // engine, not a second Academy-specific one). Cash-shift and
      // government-receipt enforcement happen server-side inside these
      // RPCs exactly as everywhere else in the app.
      if (collectNow && invoiceId && total > 0) {
        const receiptPayload = receipt.getPayload()
        if (receiptPayload) {
          const { p_receipt_notes, ...rest } = receiptPayload
          const { error: payError } = await supabase.rpc('record_payment_with_official_receipt', {
            p_invoice_id: invoiceId,
            p_amount: total,
            p_method: method,
            ...rest,
            p_notes: p_receipt_notes,
            p_idempotency_key: paymentIdempotencyKeyRef.current,
          })
          if (payError) throw payError
        } else {
          const { error: payError } = await supabase.rpc('record_payment', {
            p_invoice_id: invoiceId,
            p_amount: total,
            p_method: method,
            p_idempotency_key: paymentIdempotencyKeyRef.current,
          })
          if (payError) throw payError
        }
      }
    },
    onSuccess: onSubscribed,
    onError: (error) => setWizardError(translateSupabaseError(error, t('academy.enrollments.enrollError'))),
  })

  const canSubmit = !!playerId && !!guardianId && !!startDate && price > 0
    && (!collectNow || total === 0 || receipt.isValid)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t('academy.memberships.subscribeTo', { name: membership.name })}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <Select value={playerId} onValueChange={setPlayerId}>
            <SelectTrigger><SelectValue placeholder={t('academy.enrollments.player')} /></SelectTrigger>
            <SelectContent>{players.map((p) => <SelectItem key={p.id} value={p.id}>{p.full_name}</SelectItem>)}</SelectContent>
          </Select>

          {playerId && guardians.length > 0 && (
            <Select value={guardianId} onValueChange={setGuardianId}>
              <SelectTrigger><SelectValue placeholder={t('academy.enrollments.guardianForBilling')} /></SelectTrigger>
              <SelectContent>{guardians.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}{g.isPrimary ? ` ${t('academy.players.primary')}` : ''}</SelectItem>)}</SelectContent>
            </Select>
          )}
          {playerId && guardians.length === 0 && (
            <p className="text-sm text-status-danger">{t('academy.memberships.noGuardianForPlayer')}</p>
          )}

          <div className="flex gap-2">
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('academy.enrollments.startDate')}</label>
              <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('academy.enrollments.endDate')}</label>
              <Input disabled value={endDate} />
            </div>
          </div>

          <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
            {price > 0 ? (
              <div className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <span className="text-text-secondary">{t('academy.enrollments.approvedSubscriptionPrice')}</span>
                  <span className="font-medium tabular-nums">{price.toFixed(0)} {t('common.currency')}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-text-secondary">{t('academy.enrollments.discount')}</span>
                  <Input type="number" min={0} max={price} value={discount} onChange={(e) => setDiscount(e.target.value)} className="h-7 w-24 text-end" />
                </div>
                <div className="mt-1 flex justify-between border-t border-accent/20 pt-1 font-semibold">
                  <span>{t('academy.enrollments.total')}</span>
                  <span className="tabular-nums">{total.toFixed(0)} {t('common.currency')}</span>
                </div>
              </div>
            ) : (
              <p className="text-status-danger">{t('academy.enrollments.noApprovedPrice')}</p>
            )}
          </div>

          {/* Directive section 14: explicit Collect Now / Collect Later choice. */}
          <div className="flex gap-2">
            <Button type="button" size="sm" variant={collectNow ? 'default' : 'outline'} onClick={() => { setCollectNow(true); setWizardError(null) }} className="flex-1">
              {t('academy.memberships.collectNow')}
            </Button>
            <Button type="button" size="sm" variant={!collectNow ? 'default' : 'outline'} onClick={() => { setCollectNow(false); setWizardError(null) }} className="flex-1">
              {t('academy.memberships.collectLater')}
            </Button>
          </div>

          {collectNow && total > 0 && (
            <>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PAYMENT_METHOD_LABELS).map(([key]) => (
                    <SelectItem key={key} value={key}>{t(`common.paymentMethodLabels.${key}`, { defaultValue: PAYMENT_METHOD_LABELS[key] })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <OfficialCollectionReceiptFields state={receipt} />
            </>
          )}

          {wizardError && <p role="alert" className="text-sm text-status-danger">{wizardError}</p>}

          <Button disabled={!canSubmit || subscribeMutation.isPending} onClick={() => subscribeMutation.mutate()}>
            {subscribeMutation.isPending ? t('academy.enrollments.enrolling') : (collectNow && total > 0 ? t('academy.memberships.subscribeAndCollect') : t('academy.enrollments.enrollAndCreateSubscription'))}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
