import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { translateSupabaseError } from '@/lib/errors'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CustomerSelector, type SelectedCustomer } from '@/components/ui/customer-selector'
import { StatusBadge } from '@/components/ui/status-badge'
import { MoneyDisplay } from '@/components/ui/money-display'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
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
import { addMonthsToDate, getAcademySubscriptionDisplayStatus } from '@/lib/domain/academy'
import { PlayerStatusPanel } from './PlayerStatusPanel'
import { Zap } from 'lucide-react'

// Academy radical simplification directive sections 6-8: Player is a
// minimal operational record (name + guardian link), never a scouting
// profile. Date of birth / height / weight / position / preferred foot
// / medical data are explicitly forbidden unless proven necessary --
// no such requirement was found in this system, so none of those
// fields appear anywhere in this file. The `players` table itself
// still has a nullable date_of_birth column (never touched, section
// 28: no destructive schema changes) -- it's just never read, written,
// or shown by this screen.
interface PlayerListRow {
  id: string
  fullName: string
  status: string
  guardianName: string | null
  guardianId: string | null
  membershipName: string | null
  endDate: string | null
  displayStatus: string
  outstanding: number
  attendanceRate: number | null
}

type PlayerFilter = 'all' | 'active' | 'due' | 'expired' | 'none'

async function fetchPlayersWithContext(clubId: string, search: string): Promise<PlayerListRow[]> {
  let query = supabase
    .from('players_safe')
    .select('id, full_name, status')
    .eq('club_id', clubId)
    .order('full_name')
    .limit(100)
  if (search.trim()) query = query.ilike('full_name', `%${search}%`)
  const { data: players, error } = await query
  if (error) throw error

  const rows = (players ?? []).filter(
    (p): p is { id: string; full_name: string; status: string } => !!p.id && !!p.full_name && !!p.status,
  )
  const playerIds = rows.map((p) => p.id)
  if (playerIds.length === 0) return []

  const { data: guardianLinks } = await supabase
    .from('guardian_links')
    .select('player_id, customer_id, is_primary, customers(full_name)')
    .in('player_id', playerIds)
  const guardianByPlayer = new Map<string, { id: string; name: string }>()
  for (const g of guardianLinks ?? []) {
    if (!guardianByPlayer.has(g.player_id) || g.is_primary) {
      guardianByPlayer.set(g.player_id, {
        id: g.customer_id,
        name: (g.customers as unknown as { full_name: string } | null)?.full_name ?? '—',
      })
    }
  }

  const { data: enrollments } = await supabase
    .from('enrollments')
    .select('id, player_id, group_id, groups(name)')
    .in('player_id', playerIds)
    .eq('status', 'active')
  const enrollmentByPlayer = new Map<string, { id: string; groupName: string | null }>()
  for (const e of enrollments ?? []) {
    // A player can have >1 active enrollment (no exclusion constraint,
    // per PlayerStatusPanel's own precedent finding) -- the list view
    // shows the first found; the detail dialog (PlayerStatusPanel)
    // shows all of them, so nothing is hidden, just summarized here.
    if (!enrollmentByPlayer.has(e.player_id)) {
      enrollmentByPlayer.set(e.player_id, { id: e.id, groupName: (e.groups as unknown as { name: string } | null)?.name ?? null })
    }
  }

  const enrollmentIds = [...enrollmentByPlayer.values()].map((e) => e.id)
  const subByEnrollment = new Map<string, { status: string; endDate: string; invoiceId: string | null }>()
  if (enrollmentIds.length > 0) {
    const { data: subs } = await supabase
      .from('subscriptions')
      .select('enrollment_id, status, end_date, invoice_id, created_at')
      .in('enrollment_id', enrollmentIds)
      .order('created_at', { ascending: false })
    for (const s of subs ?? []) {
      if (!subByEnrollment.has(s.enrollment_id)) {
        subByEnrollment.set(s.enrollment_id, { status: s.status, endDate: s.end_date, invoiceId: s.invoice_id })
      }
    }
  }

  const invoiceIds = [...subByEnrollment.values()].map((s) => s.invoiceId).filter((x): x is string => !!x)
  const outstandingByInvoice = new Map<string, number>()
  if (invoiceIds.length > 0) {
    const summaries = await fetchInvoicePaymentSummaries(invoiceIds)
    for (const [id, s] of summaries) outstandingByInvoice.set(id, s.outstanding)
  }

  const { data: attendanceRows } = await supabase.from('attendance').select('player_id, status').in('player_id', playerIds)
  const attendanceByPlayer = new Map<string, { present: number; total: number }>()
  for (const a of attendanceRows ?? []) {
    const cur = attendanceByPlayer.get(a.player_id) ?? { present: 0, total: 0 }
    cur.total += 1
    if (a.status === 'present') cur.present += 1
    attendanceByPlayer.set(a.player_id, cur)
  }

  return rows.map((p) => {
    const guardian = guardianByPlayer.get(p.id) ?? null
    const enrollment = enrollmentByPlayer.get(p.id) ?? null
    const sub = enrollment ? subByEnrollment.get(enrollment.id) ?? null : null
    const displayStatus = sub ? getAcademySubscriptionDisplayStatus(sub.status, sub.endDate) : 'none'
    const att = attendanceByPlayer.get(p.id)
    return {
      id: p.id,
      fullName: p.full_name,
      status: p.status,
      guardianName: guardian?.name ?? null,
      guardianId: guardian?.id ?? null,
      membershipName: enrollment?.groupName ?? null,
      endDate: sub?.endDate ?? null,
      displayStatus,
      outstanding: sub?.invoiceId ? outstandingByInvoice.get(sub.invoiceId) ?? 0 : 0,
      attendanceRate: att && att.total > 0 ? Math.round((att.present / att.total) * 100) : null,
    }
  })
}

export function PlayersSection() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<PlayerFilter>('all')
  const [addOpen, setAddOpen] = useState(false)
  const [selectedPlayer, setSelectedPlayer] = useState<PlayerListRow | null>(null)
  const [subscribeOpen, setSubscribeOpen] = useState(false)
  const [collectOpen, setCollectOpen] = useState(false)

  // Finding H-2 (frozen production audit): this list previously
  // destructured only `data = [], isLoading` -- a failed fetch silently
  // rendered as "no players" via DataTable's own empty state,
  // indistinguishable from an academy that genuinely has none.
  // isError/error/refetch are now surfaced so a fetch failure shows an
  // explicit error, never a false "empty academy" signal.
  const { data: players = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: ['academy-players', currentClubId, search],
    queryFn: () => fetchPlayersWithContext(currentClubId!, search),
    enabled: !!currentClubId,
  })

  // Acceptance-sweep fix (2026-08-30): Player360Page's own "Subscribe
  // to membership" button has always navigated here with
  // ?subscribePlayer=<id>, but this page never read that param -- it
  // silently landed on the plain Academy Overview tab with no player
  // selected, forcing staff to search for the same player again by
  // hand in a completely different tab. Once the player list loads,
  // auto-select and open the wizard for the requested player, then
  // clear the param so it doesn't re-trigger on a later navigation
  // back to this same URL.
  const [searchParams, setSearchParams] = useSearchParams()
  useEffect(() => {
    const requestedId = searchParams.get('subscribePlayer')
    if (!requestedId || players.length === 0) return
    const match = players.find((p) => p.id === requestedId)
    if (match) {
      setSelectedPlayer(match)
      setSubscribeOpen(true)
    }
    const next = new URLSearchParams(searchParams)
    next.delete('subscribePlayer')
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [players])

  const visiblePlayers = players.filter((p) => {
    if (filter === 'all') return true
    if (filter === 'none') return p.displayStatus === 'none'
    return p.displayStatus === filter
  })

  const columns: DataTableColumn<PlayerListRow>[] = [
    {
      key: 'name',
      header: t('common.name'),
      // Academy Player/Guardian/Customer integrity closure (directive
      // section 20/65): "click player -> Player 360... Player 360 is the
      // canonical detail/edit location." The old inline PlayerDetailDialog
      // remains reachable via a separate quick-actions button (attendance
      // QR, fast subscribe/collect) but is no longer the primary
      // destination of the player's own name.
      render: (p) => (
        <Link to={`/app/academy/players/${p.id}`} className="font-medium text-accent-foreground hover:underline">
          {p.fullName}
        </Link>
      ),
    },
    { key: 'guardian', header: t('academy.players.guardianColumn'), render: (p) => p.guardianName ?? '—' },
    { key: 'membership', header: t('academy.memberships.name'), render: (p) => p.membershipName ?? t('academy.players.noActiveSubscription') },
    { key: 'end', header: t('academy.players.expiry'), render: (p) => p.endDate ?? '—' },
    {
      key: 'payment',
      header: t('academy.players.paymentStatus'),
      render: (p) => (p.outstanding > 0 ? <MoneyDisplay amount={p.outstanding} tone="danger" size="sm" /> : p.membershipName ? <span className="text-status-success">{t('academy.playerStatus.fullyPaid')}</span> : '—'),
    },
    {
      key: 'status',
      header: t('academy.players.status'),
      render: (p) => (
        <StatusBadge
          tone={p.displayStatus === 'active' ? 'success' : p.displayStatus === 'due' || p.displayStatus === 'frozen' ? 'warning' : p.displayStatus === 'expired' ? 'danger' : 'neutral'}
          label={t(`academy.subscriptionStatusLabels.${p.displayStatus}`, { defaultValue: p.displayStatus === 'none' ? t('academy.players.noActiveSubscription') : p.displayStatus })}
        />
      ),
    },
    {
      key: 'quickActions',
      header: '',
      // Directive section 20: "Quick actions may remain where useful, but
      // Player 360 is the canonical detail/edit location" -- keeps the
      // existing fast subscribe/collect/attendance-QR dialog reachable
      // without it being the primary destination of the player's name.
      render: (p) => (
        <button
          className="rounded-md p-1.5 text-text-secondary hover:bg-muted hover:text-text-primary"
          title={t('academy.players.quickActions', { defaultValue: 'Quick actions' })}
          onClick={() => setSelectedPlayer(p)}
        >
          <Zap className="size-4" />
        </button>
      ),
    },
  ]

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Input placeholder={t('academy.players.searchByName')} value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm">{t('academy.players.addPlayer')}</Button>
          </DialogTrigger>
          <AddPlayerDialog
            onAdded={() => {
              setAddOpen(false)
              void queryClient.invalidateQueries({ queryKey: ['academy-players', currentClubId] })
            }}
          />
        </Dialog>
      </div>

      {/* Directive section 19: Active / Expiring Soon / Expired / No
          Active Subscription -- the four filters staff actually need,
          nothing more. */}
      <div className="flex flex-wrap gap-1.5">
        {(['all', 'active', 'due', 'expired', 'none'] as const).map((f) => (
          <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} onClick={() => setFilter(f)}>
            {t(`academy.players.filters.${f}`)}
          </Button>
        ))}
      </div>

      {isError ? (
        <ErrorState message={translateSupabaseError(error, t('academy.players.loadError'))} onRetry={() => void refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={visiblePlayers}
          rowKey={(p) => p.id}
          isLoading={isLoading}
          emptyTitle={t('academy.players.emptyTitle')}
          emptyDescription={t('academy.players.emptyDescription')}
        />
      )}

      {selectedPlayer && (
        <PlayerDetailDialog
          player={selectedPlayer}
          onClose={() => setSelectedPlayer(null)}
          onSubscribe={() => setSubscribeOpen(true)}
          onCollectPayment={() => setCollectOpen(true)}
          onChanged={() => void queryClient.invalidateQueries({ queryKey: ['academy-players', currentClubId] })}
        />
      )}

      {subscribeOpen && selectedPlayer && (
        <SubscribePlayerWizard
          player={selectedPlayer}
          onClose={() => setSubscribeOpen(false)}
          onSubscribed={() => {
            setSubscribeOpen(false)
            setSelectedPlayer(null)
            void queryClient.invalidateQueries({ queryKey: ['academy-players', currentClubId] })
          }}
        />
      )}

      {collectOpen && selectedPlayer && (
        <CollectExistingPaymentDialog
          player={selectedPlayer}
          onClose={() => setCollectOpen(false)}
          onCollected={() => {
            setCollectOpen(false)
            setSelectedPlayer(null)
            void queryClient.invalidateQueries({ queryKey: ['academy-players', currentClubId] })
          }}
        />
      )}
    </div>
  )
}

// Directive section 8: "Select existing Customer/Guardian or create a
// new one inline; then Player Name; then Save." No DOB, no other
// fields. Inline customer creation reuses the exact same
// normalizePhone/duplicate-check/consent logic CustomersPage.tsx uses
// (never a second, looser implementation) rather than sending staff to
// a different screen.
function AddPlayerDialog({ onAdded }: { onAdded: () => void }) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()

  const [guardian, setGuardian] = useState<SelectedCustomer | null>(null)
  const [playerName, setPlayerName] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Academy Player/Guardian/Customer integrity closure: previously two
  // independent client-side .insert() calls (players, then
  // guardian_links) with no transaction -- a failure between them left
  // an orphan player with zero guardians, which later hard-failed
  // billing (create_enrollment_with_subscription requires a resolvable
  // payer). create_player_with_guardian does both writes in one
  // transaction server-side. Guardian is also no longer force-required
  // here: a player can legitimately exist with zero guardians (added
  // later from either Player 360 or here) -- the RPC accepts a null
  // customer id, matching directive rule 7/49 ("do not require a
  // guardian for every player without a real business rule").
  const addMutation = useMutation({
    mutationFn: async () => {
      const { error: rpcError } = await supabase.rpc('create_player_with_guardian', {
        p_club_id: currentClubId as string,
        p_full_name: playerName,
        p_customer_id: guardian?.id ?? undefined,
        p_relationship: 'guardian',
        p_is_primary: true,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: onAdded,
    onError: (err) => setError(translateSupabaseError(err, t('academy.players.addError'))),
  })

  const canSubmit = !!playerName.trim()

  return (
    <DialogContent>
      <DialogHeader><DialogTitle>{t('academy.players.addPlayer')}</DialogTitle></DialogHeader>
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">{t('academy.players.fullName')}</label>
          <Input required value={playerName} onChange={(e) => setPlayerName(e.target.value)} />
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium text-text-secondary">
            {t('academy.players.guardianColumn')} <span className="font-normal text-text-secondary">({t('common.optional', { defaultValue: 'optional' })})</span>
          </label>
          <CustomerSelector clubId={currentClubId as string} value={guardian} onSelect={setGuardian} />
          <p className="text-xs text-text-secondary">{t('academy.players.guardianOptionalHint', { defaultValue: 'You can add a guardian later from the player’s page.' })}</p>
        </div>

        {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}

        <Button disabled={!canSubmit || addMutation.isPending} onClick={() => addMutation.mutate()}>
          {addMutation.isPending ? t('academy.players.adding') : t('academy.players.add')}
        </Button>
      </div>
    </DialogContent>
  )
}

// Directive section 6: Player Detail shows only Player Name, Customer/
// Guardian, Current Membership, Subscription Start/End/Status, Amount,
// Paid, Outstanding, Attendance Summary -- plus Subscribe/Renew,
// Record Attendance, Collect Payment, View Invoice actions. No dozens
// of empty fields; DOB/gender editing removed entirely (never shown,
// per section 7's forbidden-fields list).
function PlayerDetailDialog({
  player,
  onClose,
  onSubscribe,
  onCollectPayment,
  onChanged,
}: {
  player: PlayerListRow
  onClose: () => void
  onSubscribe: () => void
  onCollectPayment: () => void
  onChanged: () => void
}) {
  const { t } = useTranslation()
  const [editName, setEditName] = useState(player.fullName)
  const [playerQrDataUrl, setPlayerQrDataUrl] = useState<string | null>(null)

  const updateNameMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from('players').update({ full_name: editName }).eq('id', player.id)
      if (error) throw error
    },
    onSuccess: onChanged,
  })

  const playerQrMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.rpc('ensure_player_qr', { p_player_id: player.id })
      if (error) throw error
      return data as string
    },
    onSuccess: async (rawToken) => {
      const dataUrl = await QRCode.toDataURL(rawToken, { width: 220, margin: 1 })
      setPlayerQrDataUrl(dataUrl)
    },
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{player.fullName}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <Input value={editName} onChange={(e) => setEditName(e.target.value)} className="flex-1" />
            <Button size="sm" disabled={!editName.trim() || editName === player.fullName || updateNameMutation.isPending} onClick={() => updateNameMutation.mutate()}>
              {t('academy.players.save')}
            </Button>
          </div>

          {player.guardianName && (
            <p className="text-sm text-text-secondary">
              {t('academy.players.guardianColumn')}:{' '}
              {player.guardianId ? (
                <Link to={`/app/customers/${player.guardianId}`} className="font-medium text-accent-foreground hover:underline">{player.guardianName}</Link>
              ) : (
                <span className="font-medium text-text-primary">{player.guardianName}</span>
              )}
            </p>
          )}

          <PlayerStatusPanel playerId={player.id} />

          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {(() => {
              const isTerminal = player.displayStatus === 'expired' || player.displayStatus === 'cancelled'
              if (!player.membershipName) {
                return <Button size="sm" onClick={onSubscribe}>{t('academy.players.subscribe')}</Button>
              }
              if (isTerminal) {
                return <Button size="sm" onClick={onSubscribe}>{t('academy.players.renew')}</Button>
              }
              if (player.outstanding > 0) {
                return <Button size="sm" onClick={onCollectPayment}>{t('academy.players.collectPayment')}</Button>
              }
              return null
            })()}
            <Button size="sm" variant="outline" disabled={playerQrMutation.isPending} onClick={() => playerQrMutation.mutate()}>
              {playerQrMutation.isPending ? t('academy.players.generatingQr') : t('academy.players.viewQr')}
            </Button>
          </div>
          {playerQrDataUrl && (
            <div className="flex justify-center">
              <img src={playerQrDataUrl} alt={t('academy.players.qrAlt')} className="size-40" />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
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

async function fetchActiveMemberships(clubId: string) {
  const { data, error } = await supabase
    .from('groups')
    .select('id, branch_id, name, subscription_price')
    .eq('club_id', clubId)
    .eq('status', 'active')
    .order('name')
  if (error) throw error
  return data ?? []
}

async function fetchActiveEnrollmentForPlayer(playerId: string) {
  const { data } = await supabase
    .from('enrollments')
    .select('id, group_id')
    .eq('player_id', playerId)
    .eq('status', 'active')
    .order('enrolled_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data ?? null
}

// Directive sections 9-15: the same Subscribe primary flow reachable
// from the Player side (Academy -> Player -> Subscribe), not just from
// the Membership side. If the player already has an active enrollment,
// this becomes a Renewal against that same enrollment (never a new
// player/customer record, section 11) once its subscription reaches a
// terminal state -- matching renew_academy_subscription()'s own
// server-side guard.
function SubscribePlayerWizard({
  player,
  onClose,
  onSubscribed,
}: {
  player: PlayerListRow
  onClose: () => void
  onSubscribed: () => void
}) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()

  const [membershipId, setMembershipId] = useState('')
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [discount, setDiscount] = useState('0')
  const [collectNow, setCollectNow] = useState(true)
  const [method, setMethod] = useState('cash')
  const [wizardError, setWizardError] = useState<string | null>(null)
  // SAAS ACCEPTANCE REVIEW (2026-08-29): this dialog's "collect now"
  // payment call never passed p_idempotency_key at all, unlike the
  // already-hardened Bookings/Billing/Customer360/Shop-POS payment
  // sites -- a double-click on submit (or a network retry) could
  // record the same payment twice. Stable for the lifetime of this
  // dialog instance (one real payment attempt), matching the
  // established stable-key convention used elsewhere in this codebase.
  const paymentIdempotencyKeyRef = useRef(crypto.randomUUID())

  const { data: memberships = [] } = useQuery({ queryKey: ['memberships-for-subscribe', currentClubId], queryFn: () => fetchActiveMemberships(currentClubId!), enabled: !!currentClubId })
  const { data: guardians = [] } = useQuery({ queryKey: ['guardians-for-subscribe', player.id], queryFn: () => fetchGuardiansForPlayer(player.id), enabled: true })
  const { data: existingEnrollment } = useQuery({ queryKey: ['active-enrollment-for-player', player.id], queryFn: () => fetchActiveEnrollmentForPlayer(player.id), enabled: true })
  const isRenewal = !!existingEnrollment

  // Real bug found in live QA (2026-08-20): for a renewal, membershipId
  // was never populated (the membership <Select> only renders in the
  // non-renewal branch below), so `membership` stayed undefined and
  // the wizard showed "No approved price for this group" even though
  // the group has a real price -- fetchActiveMemberships() only lists
  // memberships with status='active', but a renewal's own group is
  // known directly from existingEnrollment.groupId, so look it up on
  // its own instead of depending on that unrelated list/selection.
  const { data: renewalMembership } = useQuery({
    queryKey: ['membership-for-renewal', existingEnrollment?.group_id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('groups')
        .select('id, branch_id, name, subscription_price')
        .eq('id', existingEnrollment!.group_id)
        .single()
      if (error) throw error
      return data
    },
    enabled: isRenewal && !!existingEnrollment,
  })

  const membership = isRenewal ? renewalMembership : memberships.find((m) => m.id === membershipId)
  const endDate = addMonthsToDate(startDate, 1)
  const price = membership?.subscription_price != null ? Number(membership.subscription_price) : 0
  const total = Math.max(price - Number(discount || 0), 0)
  const guardianId = guardians.find((g) => g.isPrimary)?.id ?? guardians[0]?.id ?? null

  const receipt = useOfficialReceipt({
    clubId: currentClubId,
    branchId: membership?.branch_id ?? null,
    fieldId: null,
    method,
    enabled: collectNow,
  })

  const subscribeMutation = useMutation({
    mutationFn: async () => {
      if (isRenewal && existingEnrollment) {
        const { error } = await supabase.rpc('renew_academy_subscription', {
          p_enrollment_id: existingEnrollment.id,
          p_start_date: startDate,
          p_end_date: endDate,
          p_price: price,
          p_discount: Number(discount || 0),
        })
        if (error) throw error
        // renew_academy_subscription creates a new subscription row but
        // this UI's Collect Now needs its invoice id -- look it up
        // fresh rather than assuming the RPC's return shape.
        const { data: sub } = await supabase
          .from('subscriptions')
          .select('invoice_id')
          .eq('enrollment_id', existingEnrollment.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
        return sub?.invoice_id as string | undefined
      }

      if (!guardianId) throw new Error(t('academy.memberships.noGuardianForPlayer'))
      const { data, error } = await supabase.rpc('create_enrollment_with_subscription', {
        p_player_id: player.id,
        p_group_id: membershipId,
        p_guardian_id: guardianId,
        p_plan_type: 'monthly',
        p_start_date: startDate,
        p_end_date: endDate,
        p_price: price,
        p_discount: Number(discount || 0),
      })
      if (error) throw error
      return data?.[0]?.invoice_id as string | undefined
    },
    onSuccess: async (invoiceId) => {
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
          if (payError) { setWizardError(translateSupabaseError(payError, t('academy.enrollments.enrollError'))); return }
        } else {
          const { error: payError } = await supabase.rpc('record_payment', {
            p_invoice_id: invoiceId,
            p_amount: total,
            p_method: method,
            p_idempotency_key: paymentIdempotencyKeyRef.current,
          })
          if (payError) { setWizardError(translateSupabaseError(payError, t('academy.enrollments.enrollError'))); return }
        }
      }
      onSubscribed()
    },
    onError: (error) => setWizardError(translateSupabaseError(error, t('academy.enrollments.enrollError'))),
  })

  const canSubmit = isRenewal
    ? !!startDate && price > 0 && (!collectNow || total === 0 || receipt.isValid)
    : !!membershipId && !!guardianId && !!startDate && price > 0 && (!collectNow || total === 0 || receipt.isValid)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isRenewal ? t('academy.players.renew') : t('academy.memberships.subscribeTo', { name: player.fullName })}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {!isRenewal && (
            <Select value={membershipId} onValueChange={setMembershipId}>
              <SelectTrigger><SelectValue placeholder={t('academy.memberships.name')} /></SelectTrigger>
              <SelectContent>{memberships.map((m) => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent>
            </Select>
          )}

          {!isRenewal && guardians.length === 0 && (
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
              <p className="text-status-danger">{isRenewal ? t('academy.enrollments.noApprovedPrice') : t('academy.memberships.name')}</p>
            )}
          </div>

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

async function fetchOutstandingSubscriptionInvoice(playerId: string) {
  const { data: enrollment } = await supabase
    .from('enrollments')
    .select('id, group_id, groups(name, branch_id)')
    .eq('player_id', playerId)
    .eq('status', 'active')
    .order('enrolled_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!enrollment) return null

  const { data: sub } = await supabase
    .from('subscriptions')
    .select('id, invoice_id, status')
    .eq('enrollment_id', enrollment.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!sub?.invoice_id) return null

  const summaries = await fetchInvoicePaymentSummaries([sub.invoice_id])
  const outstanding = summaries.get(sub.invoice_id)?.outstanding ?? 0
  return {
    invoiceId: sub.invoice_id,
    outstanding,
    branchId: (enrollment.groups as unknown as { branch_id: string } | null)?.branch_id ?? null,
    membershipName: (enrollment.groups as unknown as { name: string } | null)?.name ?? null,
  }
}

// Directive section 6: "Collect Payment" reachable directly from a
// player's context without a trip to Billing to find the invoice --
// this is the pay-the-existing-invoice path for a player whose
// subscription is already pending/active/frozen (never a renewal:
// renew_academy_subscription() only applies once a subscription is
// terminal, matching its own server-side guard). Reuses the identical
// record_payment/record_payment_with_official_receipt RPCs and
// government-receipt fields as every other payment surface.
function CollectExistingPaymentDialog({
  player,
  onClose,
  onCollected,
}: {
  player: PlayerListRow
  onClose: () => void
  onCollected: () => void
}) {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const [method, setMethod] = useState('cash')
  const [error, setError] = useState<string | null>(null)
  // SAAS ACCEPTANCE REVIEW (2026-08-29): same idempotency-key gap as
  // SubscribePlayerWizard's collect-now above -- see that comment.
  const paymentIdempotencyKeyRef = useRef(crypto.randomUUID())

  const { data: info, isLoading } = useQuery({
    queryKey: ['outstanding-invoice-for-player', player.id],
    queryFn: () => fetchOutstandingSubscriptionInvoice(player.id),
  })

  const receipt = useOfficialReceipt({
    clubId: currentClubId,
    branchId: info?.branchId ?? null,
    fieldId: null,
    method,
    enabled: true,
  })

  const collectMutation = useMutation({
    mutationFn: async () => {
      if (!info) throw new Error('no outstanding invoice')
      const receiptPayload = receipt.getPayload()
      if (receiptPayload) {
        const { p_receipt_notes, ...rest } = receiptPayload
        const { error: payError } = await supabase.rpc('record_payment_with_official_receipt', {
          p_invoice_id: info.invoiceId,
          p_amount: info.outstanding,
          p_method: method,
          ...rest,
          p_notes: p_receipt_notes,
          p_idempotency_key: paymentIdempotencyKeyRef.current,
        })
        if (payError) throw payError
      } else {
        const { error: payError } = await supabase.rpc('record_payment', {
          p_invoice_id: info.invoiceId,
          p_amount: info.outstanding,
          p_method: method,
          p_idempotency_key: paymentIdempotencyKeyRef.current,
        })
        if (payError) throw payError
      }
    },
    onSuccess: onCollected,
    onError: (err) => setError(translateSupabaseError(err, t('academy.enrollments.enrollError'))),
  })

  const canSubmit = !!info && info.outstanding > 0 && receipt.isValid

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('academy.players.collectPayment')}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          {isLoading ? (
            <p className="text-sm text-text-secondary">{t('academy.loading')}</p>
          ) : !info || info.outstanding <= 0 ? (
            <p className="text-sm text-status-success">{t('academy.playerStatus.fullyPaid')}</p>
          ) : (
            <>
              <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
                <span className="text-text-secondary">{info.membershipName}</span>
                <MoneyDisplay amount={info.outstanding} tone="danger" size="sm" />
              </div>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(PAYMENT_METHOD_LABELS).map(([key]) => (
                    <SelectItem key={key} value={key}>{t(`common.paymentMethodLabels.${key}`, { defaultValue: PAYMENT_METHOD_LABELS[key] })}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <OfficialCollectionReceiptFields state={receipt} />
              {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
              <Button disabled={!canSubmit || collectMutation.isPending} onClick={() => collectMutation.mutate()}>
                {collectMutation.isPending ? t('academy.enrollments.enrolling') : t('academy.players.collectPayment')}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
