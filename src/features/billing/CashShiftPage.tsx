import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { StatusBadge } from '@/components/ui/status-badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatMoney } from '@/lib/domain/billing'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'
import { Wallet, Printer } from 'lucide-react'
import { CashShiftSummaryDialog } from './CashShiftSummaryDialog'

// Gate 13 #62 (lean V1) + Master Payment Directive Phase 1: cash shift /
// drawer reconciliation. One open shift per branch at a time (enforced
// server-side by cash_shifts_one_open_per_branch). Only payments.method
// = 'cash' ever affects the drawer -- InstaPay/wallet/bank/POS/card never
// touch expected_cash, by design (open_cash_shift/close_cash_shift RPCs
// only ever sum method='cash' rows).
interface BranchRow {
  id: string
  name: string
}

interface OpenShiftRow {
  id: string
  branch_id: string
  branch_name: string
  opened_by_name: string | null
  opened_at: string
  opening_float: number
}

interface ShiftHistoryRow {
  id: string
  branch_id: string
  branch_name: string
  opened_by_name: string | null
  closed_by_name: string | null
  opened_at: string
  closed_at: string | null
  opening_float: number
  closing_count: number | null
  expected_cash: number | null
  variance: number | null
  status: string
}

async function fetchBranches(clubId: string): Promise<BranchRow[]> {
  const { data, error } = await supabase.from('branches').select('id, name').eq('club_id', clubId).eq('status', 'active').order('name')
  if (error) throw error
  return data ?? []
}

async function fetchShifts(clubId: string) {
  const { data, error } = await supabase
    .from('cash_shifts')
    .select('id, branch_id, opened_by, closed_by, opened_at, closed_at, opening_float, closing_count, expected_cash, variance, status, branches(name)')
    .eq('club_id', clubId)
    .order('opened_at', { ascending: false })
    .limit(50)
  if (error) throw error

  const userIds = [...new Set((data ?? []).flatMap((r) => [r.opened_by, r.closed_by]).filter((id): id is string => !!id))]
  const namesById = new Map<string, string>()
  if (userIds.length > 0) {
    const { data: profiles } = await supabase.from('profiles').select('user_id, full_name').in('user_id', userIds)
    for (const p of profiles ?? []) if (p.full_name) namesById.set(p.user_id, p.full_name)
  }

  const rows = (data ?? []).map((r) => ({
    id: r.id,
    branch_id: r.branch_id,
    branch_name: (r.branches as unknown as { name: string } | null)?.name ?? '—',
    opened_by_name: namesById.get(r.opened_by) ?? null,
    closed_by_name: r.closed_by ? (namesById.get(r.closed_by) ?? null) : null,
    opened_at: r.opened_at,
    closed_at: r.closed_at,
    opening_float: Number(r.opening_float),
    closing_count: r.closing_count === null ? null : Number(r.closing_count),
    expected_cash: r.expected_cash === null ? null : Number(r.expected_cash),
    variance: r.variance === null ? null : Number(r.variance),
    status: r.status,
  }))

  const open = rows.filter((r) => r.status === 'open') as unknown as OpenShiftRow[]
  const history = rows as ShiftHistoryRow[]
  return { open, history }
}

async function fetchOpenShiftStatus(shiftId: string) {
  const { data, error } = await supabase.rpc('get_open_cash_shift_status', { p_shift_id: shiftId })
  if (error) throw error
  return data as unknown as { opening_float: number; cash_collected: number; cash_refunded: number; expected_cash: number }
}

// Phase D (D17): informational only -- never auto-closes a stale open
// shift, just surfaces its age so staff/management can act on it.
interface OpenShiftAgeRow {
  id: string
  branch_id: string
  opened_by: string
  opened_by_name: string | null
  opened_at: string
  opening_float: number
  age_hours: number
}

async function fetchOpenShiftAges(clubId: string): Promise<OpenShiftAgeRow[]> {
  const { data, error } = await supabase.rpc('get_open_cash_shifts', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []) as unknown as OpenShiftAgeRow[]
}

// Phase D (D10-D13): a shift closed with a shortage creates a liability
// row -- shown here so staff don't need to leave Cash Shift to see it.
interface ShiftLiabilityRow {
  id: string
  cash_shift_id: string
  employee_id: string
  kind: 'shortage' | 'overage'
  original_amount: number
  outstanding: number
  status: 'outstanding' | 'settled'
}

async function fetchLiabilitiesByShift(shiftIds: string[]): Promise<Map<string, ShiftLiabilityRow>> {
  if (shiftIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('employee_cash_liabilities')
    .select('id, cash_shift_id, employee_id, kind, original_amount, outstanding, status')
    .in('cash_shift_id', shiftIds)
  if (error) throw error
  const map = new Map<string, ShiftLiabilityRow>()
  for (const row of data ?? []) {
    map.set(row.cash_shift_id, {
      id: row.id,
      cash_shift_id: row.cash_shift_id,
      employee_id: row.employee_id,
      kind: row.kind as 'shortage' | 'overage',
      original_amount: Number(row.original_amount),
      outstanding: Number(row.outstanding),
      status: row.status as 'outstanding' | 'settled',
    })
  }
  return map
}

export function CashShiftPage() {
  const { t } = useTranslation()
  const { currentClubId, currentMembership, session } = useAuth()
  const { locale } = useDirection()
  const queryClient = useQueryClient()
  // CASH CUSTODY & SHIFT LIFECYCLE AUDIT (2026-08-26): this Settle
  // button had NO client-side gate at all -- not on cash.liability.
  // settle, and not on the self-settlement rule already established
  // and enforced server-side (Employee360Page.tsx and
  // ReportEmployeeLiabilityPage.tsx both already hide their own Settle
  // buttons the same way; this screen was simply never wired to match).
  // The server remains the real control either way -- confirmed live,
  // attempting it here was already correctly rejected -- this is a UX
  // consistency fix, not a security fix.
  const canSettleLiability = (currentMembership?.permissionKeys ?? []).includes('cash.liability.settle')
  const currentUserId = session?.user?.id ?? null
  const [selectedBranchId, setSelectedBranchId] = useState<string>('')
  const [openingFloat, setOpeningFloat] = useState('')
  const [closingCount, setClosingCount] = useState('')
  const [closingNotes, setClosingNotes] = useState('')
  const [closingShiftId, setClosingShiftId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  // Phase G (G6/G7): branch + status(active/closed), the two
  // highest-value filters for the shift history table -- client-side
  // since fetchShifts already returns the full capped list (no new RPC
  // param needed for a real, useful narrowing).
  const [historyBranchFilter, setHistoryBranchFilter] = useState('')
  const [historyStatusFilter, setHistoryStatusFilter] = useState('')

  const { data: branches = [] } = useQuery({
    queryKey: ['branches-for-cash-shift', currentClubId],
    queryFn: () => fetchBranches(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['cash-shifts', currentClubId],
    queryFn: () => fetchShifts(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: liveStatus } = useQuery({
    queryKey: ['cash-shift-status', closingShiftId],
    queryFn: () => fetchOpenShiftStatus(closingShiftId!),
    enabled: !!closingShiftId,
    refetchInterval: 15_000,
  })

  // Phase D (D17): open-shift age warnings.
  const { data: openShiftAges = [] } = useQuery({
    queryKey: ['cash-shift-ages', currentClubId],
    queryFn: () => fetchOpenShiftAges(currentClubId!),
    enabled: !!currentClubId,
    refetchInterval: 60_000,
  })

  // Phase D (D10-D13): shortage/overage per shift + settlement dialog.
  const shiftIdsForLiabilityLookup = (data?.history ?? []).map((s) => s.id)
  const { data: liabilitiesByShift = new Map<string, ShiftLiabilityRow>() } = useQuery({
    queryKey: ['cash-shift-liabilities', currentClubId, shiftIdsForLiabilityLookup.join(',')],
    queryFn: () => fetchLiabilitiesByShift(shiftIdsForLiabilityLookup),
    enabled: shiftIdsForLiabilityLookup.length > 0,
  })
  const [settlingLiabilityId, setSettlingLiabilityId] = useState<string | null>(null)
  const [settleAmount, setSettleAmount] = useState('')
  const [settleReason, setSettleReason] = useState('')
  const [printingShift, setPrintingShift] = useState<ShiftHistoryRow | null>(null)

  const settleMutation = useMutation({
    mutationFn: async () => {
      const amount = Number(settleAmount)
      if (!settlingLiabilityId) throw new Error(t('billing.cashShift.errors.noShiftSelected'))
      if (!amount || amount <= 0) throw new Error(t('bookings.detail.invalidAmountError'))
      const { error } = await supabase.rpc('settle_employee_cash_liability', {
        p_liability_id: settlingLiabilityId,
        p_amount: amount,
        p_reason: settleReason.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cash-shift-liabilities', currentClubId] })
      setSettlingLiabilityId(null)
      setSettleAmount('')
      setSettleReason('')
      setFormError(null)
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, t('billing.cashShift.errors.genericError'))),
  })

  const openMutation = useMutation({
    mutationFn: async () => {
      const float = Number(openingFloat)
      if (!selectedBranchId) throw new Error(t('billing.cashShift.errors.selectBranchFirst'))
      if (Number.isNaN(float) || float < 0) throw new Error(t('billing.cashShift.errors.invalidOpeningFloat'))
      const { error } = await supabase.rpc('open_cash_shift', {
        p_club_id: currentClubId!,
        p_branch_id: selectedBranchId,
        p_opening_float: float,
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cash-shifts', currentClubId] })
      setOpeningFloat('')
      setFormError(null)
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, t('billing.cashShift.errors.genericError'))),
  })

  const closeMutation = useMutation({
    mutationFn: async () => {
      const count = Number(closingCount)
      if (!closingShiftId) throw new Error(t('billing.cashShift.errors.noShiftSelected'))
      if (Number.isNaN(count) || count < 0) throw new Error(t('billing.cashShift.errors.invalidClosingCount'))
      const { error } = await supabase.rpc('close_cash_shift', {
        p_shift_id: closingShiftId,
        p_closing_count: count,
        p_notes: closingNotes.trim() || undefined,
      })
      if (error) throw error
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cash-shifts', currentClubId] })
      queryClient.invalidateQueries({ queryKey: ['cash-shift-liabilities', currentClubId] })
      queryClient.invalidateQueries({ queryKey: ['cash-shift-ages', currentClubId] })
      setClosingShiftId(null)
      setClosingCount('')
      setClosingNotes('')
      setFormError(null)
    },
    onError: (err) => setFormError(err instanceof Error ? err.message : translateSupabaseError(err, t('billing.cashShift.errors.genericError'))),
  })

  const openBranchIds = new Set((data?.open ?? []).map((s) => s.branch_id))
  const branchesWithoutOpenShift = branches.filter((b) => !openBranchIds.has(b.id))

  const statusLabels: Record<string, string> = {
    open: t('billing.cashShift.statusLabels.open'),
    closed: t('billing.cashShift.statusLabels.closed'),
  }

  const historyColumns: DataTableColumn<ShiftHistoryRow>[] = [
    { key: 'branch', header: t('billing.cashShift.historyCard.table.branch'), render: (s) => s.branch_name },
    { key: 'opened_by', header: t('billing.cashShift.historyCard.table.openedBy'), render: (s) => s.opened_by_name ?? '—' },
    { key: 'opened_at', header: t('billing.cashShift.historyCard.table.openedAt'), render: (s) => new Date(s.opened_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG') },
    { key: 'closed_at', header: t('billing.cashShift.historyCard.table.closedAt'), render: (s) => (s.closed_at ? new Date(s.closed_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG') : '—') },
    { key: 'opening_float', header: t('billing.cashShift.historyCard.table.openingFloat'), render: (s) => formatMoney(s.opening_float, 'EGP', locale) },
    { key: 'expected', header: t('billing.cashShift.historyCard.table.expected'), render: (s) => (s.expected_cash === null ? '—' : formatMoney(s.expected_cash, 'EGP', locale)) },
    { key: 'counted', header: t('billing.cashShift.historyCard.table.counted'), render: (s) => (s.closing_count === null ? '—' : formatMoney(s.closing_count, 'EGP', locale)) },
    {
      key: 'variance',
      header: t('billing.cashShift.historyCard.table.variance'),
      render: (s) => {
        if (s.variance === null) return '—'
        const tone = s.variance === 0 ? 'text-status-success' : s.variance > 0 ? 'text-status-info' : 'text-status-danger'
        return <span className={tone}>{s.variance > 0 ? '+' : ''}{formatMoney(s.variance, 'EGP', locale)}</span>
      },
    },
    {
      key: 'status',
      header: t('billing.cashShift.historyCard.table.status'),
      render: (s) => <StatusBadge tone={s.status === 'open' ? 'warning' : 'neutral'} label={statusLabels[s.status] ?? s.status} />,
    },
    // Phase D (D10-D13): a closed shift's shortage/overage, with a
    // one-click settle action while it's still outstanding -- no need
    // to leave Cash Shift to record a payroll deduction against it.
    {
      key: 'liability',
      header: t('billing.cashShift.historyCard.table.liability'),
      render: (s) => {
        const liability = liabilitiesByShift.get(s.id)
        if (!liability) return '—'
        if (liability.kind === 'overage') {
          return <span className="text-status-info text-xs">{t('billing.cashShift.liability.overageRecorded')}</span>
        }
        if (liability.status === 'settled') {
          return <StatusBadge tone="success" label={t('billing.cashShift.liability.settled')} />
        }
        const isOwnLiability = !!currentUserId && currentUserId === liability.employee_id
        return (
          <div className="flex items-center gap-2">
            <span className="text-status-danger text-xs tabular-nums">
              {t('billing.cashShift.liability.outstanding', { amount: formatMoney(liability.outstanding, 'EGP', locale) })}
            </span>
            {canSettleLiability && !isOwnLiability && (
              <Button
                size="sm"
                variant="outline"
                className="h-6 px-2 text-xs"
                onClick={() => { setSettlingLiabilityId(liability.id); setSettleAmount(liability.outstanding.toFixed(2)) }}
              >
                {t('billing.cashShift.liability.settle')}
              </Button>
            )}
          </div>
        )
      },
    },
    {
      key: 'print',
      header: '',
      render: (s) => (
        <Button size="sm" variant="ghost" onClick={() => setPrintingShift(s)} aria-label={t('billing.cashShift.summary.print')}>
          <Printer className="size-4" aria-hidden="true" />
        </Button>
      ),
    },
  ]

  return (
    <div>
      <PageHeader title={t('billing.cashShift.title')} description={t('billing.cashShift.description')} />

      {formError && (
        <div className="mb-4 rounded-md border border-status-danger/40 bg-status-danger/5 p-3 text-sm text-status-danger">{formError}</div>
      )}

      {/* Phase D (D17): open-shift age warning -- purely informational,
          never auto-closes anything. Threshold of 12h is a reasonable
          "this has probably been left open" signal for a single-day
          operating pattern without inventing a specific policy number
          the directive never gave. */}
      {openShiftAges.some((s) => s.age_hours >= 12) && (
        <div className="mb-4 rounded-md border border-status-warning/40 bg-status-warning/5 p-3 text-sm text-status-warning">
          {openShiftAges.filter((s) => s.age_hours >= 12).map((s) => (
            <p key={s.id}>
              {t('billing.cashShift.openShiftWarning', { name: s.opened_by_name ?? '—', hours: Math.round(s.age_hours) })}
            </p>
          ))}
        </div>
      )}

      {settlingLiabilityId && (
        <div className="mb-4 flex flex-col gap-2 rounded-lg border border-border p-3 md:flex-row md:items-end">
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">{t('billing.cashShift.liability.settleAmountLabel')}</label>
            <Input type="number" min={0} step="0.01" value={settleAmount} onChange={(e) => setSettleAmount(e.target.value)} className="w-40" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium">{t('billing.cashShift.liability.settleReasonLabel')}</label>
            <Input value={settleReason} onChange={(e) => setSettleReason(e.target.value)} placeholder={t('billing.cashShift.liability.settleReasonPlaceholder')} className="w-56" />
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => settleMutation.mutate()} disabled={settleMutation.isPending}>
              {t('billing.cashShift.liability.confirmSettle')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => { setSettlingLiabilityId(null); setSettleAmount(''); setSettleReason('') }}>
              {t('billing.cashShift.openShiftCard.cancel')}
            </Button>
          </div>
        </div>
      )}

      {(data?.open?.length ?? 0) > 0 && (
        <div className="mb-6 grid gap-4 md:grid-cols-2">
          {data!.open.map((shift) => (
            <Card key={shift.id}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  <span>{t('billing.cashShift.openShiftCard.heading', { branch: shift.branch_name })}</span>
                  <StatusBadge tone="warning" label={t('billing.cashShift.statusLabels.open')} />
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-sm text-text-secondary">
                  {t('billing.cashShift.openShiftCard.openedBy', { name: shift.opened_by_name ?? '—', date: new Date(shift.opened_at).toLocaleString(locale === 'en' ? 'en-US' : 'ar-EG') })}
                </p>
                {closingShiftId === shift.id && liveStatus ? (
                  <>
                    <div className="grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <p className="text-text-secondary">{t('billing.cashShift.openShiftCard.openingFloat')}</p>
                        <p className="font-medium tabular-nums">{formatMoney(liveStatus.opening_float, 'EGP', locale)}</p>
                      </div>
                      <div>
                        <p className="text-text-secondary">{t('billing.cashShift.openShiftCard.cashCollected')}</p>
                        <p className="font-medium tabular-nums">{formatMoney(liveStatus.cash_collected, 'EGP', locale)}</p>
                      </div>
                      <div>
                        <p className="text-text-secondary">{t('billing.cashShift.openShiftCard.expectedNow')}</p>
                        <p className="font-medium tabular-nums">{formatMoney(liveStatus.expected_cash, 'EGP', locale)}</p>
                      </div>
                    </div>
                    <div className="flex flex-col gap-2">
                      <label className="text-sm font-medium">{t('billing.cashShift.openShiftCard.closingCountLabel')}</label>
                      <Input type="number" value={closingCount} onChange={(e) => setClosingCount(e.target.value)} placeholder="0.00" />
                      <label className="text-sm font-medium">{t('billing.cashShift.openShiftCard.notesLabel')}</label>
                      <Input value={closingNotes} onChange={(e) => setClosingNotes(e.target.value)} placeholder={t('billing.cashShift.openShiftCard.notesPlaceholder')} />
                      {/* CASH CUSTODY & SHIFT LIFECYCLE AUDIT (2026-08-26):
                          before this, the dialog showed Expected but
                          never previewed the RESULT of the count the
                          user was about to submit -- confirm before you
                          commit, matching the pattern already
                          established in the liability Settle dialog.
                          Purely a client-side preview; close_cash_shift()
                          itself remains the sole source of truth for the
                          actual variance/liability outcome. */}
                      {closingCount !== '' && !Number.isNaN(Number(closingCount)) && Number(closingCount) >= 0 && (() => {
                        const previewVariance = Number(closingCount) - liveStatus.expected_cash
                        if (previewVariance === 0) {
                          return (
                            <p className="text-sm text-status-success">{t('billing.cashShift.openShiftCard.previewBalanced')}</p>
                          )
                        }
                        if (previewVariance < 0) {
                          return (
                            <p className="text-sm text-status-danger">
                              {t('billing.cashShift.openShiftCard.previewShortage', { amount: formatMoney(Math.abs(previewVariance), 'EGP', locale) })}
                            </p>
                          )
                        }
                        return (
                          <p className="text-sm text-status-info">
                            {t('billing.cashShift.openShiftCard.previewOverage', { amount: formatMoney(previewVariance, 'EGP', locale) })}
                          </p>
                        )
                      })()}
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => closeMutation.mutate()} disabled={closeMutation.isPending}>
                          {t('billing.cashShift.openShiftCard.confirmClose')}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setClosingShiftId(null)}>{t('billing.cashShift.openShiftCard.cancel')}</Button>
                      </div>
                    </div>
                  </>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setClosingShiftId(shift.id)}>{t('billing.cashShift.openShiftCard.closeShift')}</Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {branchesWithoutOpenShift.length > 0 && (
        <Card className="mb-6">
          <CardHeader><CardTitle className="text-base">{t('billing.cashShift.newShiftCard.heading')}</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-3 md:flex-row md:items-end">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">{t('billing.cashShift.newShiftCard.branchLabel')}</label>
              <Select value={selectedBranchId} onValueChange={setSelectedBranchId}>
                <SelectTrigger className="w-56"><SelectValue placeholder={t('billing.cashShift.newShiftCard.branchPlaceholder')} /></SelectTrigger>
                <SelectContent>
                  {branchesWithoutOpenShift.map((b) => (
                    <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">{t('billing.cashShift.newShiftCard.openingFloatLabel')}</label>
              <Input type="number" value={openingFloat} onChange={(e) => setOpeningFloat(e.target.value)} placeholder="0.00" className="w-40" />
            </div>
            <Button onClick={() => openMutation.mutate()} disabled={openMutation.isPending}>
              <Wallet className="me-1 size-4" /> {t('billing.cashShift.newShiftCard.openShift')}
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">{t('billing.cashShift.historyCard.heading')}</CardTitle></CardHeader>
        <CardContent>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('billing.cashShift.filters.branch')}</label>
              <Select value={historyBranchFilter || 'all'} onValueChange={(v) => setHistoryBranchFilter(v === 'all' ? '' : v)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('billing.cashShift.filters.allBranches')}</SelectItem>
                  {branches.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs text-text-secondary">{t('billing.cashShift.filters.status')}</label>
              <Select value={historyStatusFilter || 'all'} onValueChange={(v) => setHistoryStatusFilter(v === 'all' ? '' : v)}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('billing.cashShift.filters.allStatuses')}</SelectItem>
                  <SelectItem value="open">{t('billing.cashShift.statusLabels.open')}</SelectItem>
                  <SelectItem value="closed">{t('billing.cashShift.statusLabels.closed')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {(historyBranchFilter || historyStatusFilter) && (
              <Button variant="ghost" size="sm" onClick={() => { setHistoryBranchFilter(''); setHistoryStatusFilter('') }}>
                {t('billing.filters.clear')}
              </Button>
            )}
          </div>
          <DataTable
            columns={historyColumns}
            rows={(data?.history ?? []).filter((s) =>
              (!historyBranchFilter || s.branch_id === historyBranchFilter)
              && (!historyStatusFilter || s.status === historyStatusFilter),
            )}
            rowKey={(s) => s.id}
            isLoading={isLoading}
            emptyTitle={t('billing.cashShift.historyCard.emptyTitle')}
          />
        </CardContent>
      </Card>

      {printingShift && (
        <CashShiftSummaryDialog
          shift={{
            id: printingShift.id,
            branchName: printingShift.branch_name,
            openedByName: printingShift.opened_by_name,
            closedByName: printingShift.closed_by_name,
            openedAt: printingShift.opened_at,
            closedAt: printingShift.closed_at,
            openingFloat: printingShift.opening_float,
            expectedCash: printingShift.expected_cash,
            closingCount: printingShift.closing_count,
            variance: printingShift.variance,
            status: printingShift.status,
          }}
          onClose={() => setPrintingShift(null)}
        />
      )}
    </div>
  )
}
