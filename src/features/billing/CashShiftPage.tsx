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
import { Wallet } from 'lucide-react'

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

export function CashShiftPage() {
  const { t } = useTranslation()
  const { currentClubId } = useAuth()
  const { locale } = useDirection()
  const queryClient = useQueryClient()
  const [selectedBranchId, setSelectedBranchId] = useState<string>('')
  const [openingFloat, setOpeningFloat] = useState('')
  const [closingCount, setClosingCount] = useState('')
  const [closingNotes, setClosingNotes] = useState('')
  const [closingShiftId, setClosingShiftId] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

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
  ]

  return (
    <div>
      <PageHeader title={t('billing.cashShift.title')} description={t('billing.cashShift.description')} />

      {formError && (
        <div className="mb-4 rounded-md border border-status-danger/40 bg-status-danger/5 p-3 text-sm text-status-danger">{formError}</div>
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
          <DataTable
            columns={historyColumns}
            rows={data?.history ?? []}
            rowKey={(s) => s.id}
            isLoading={isLoading}
            emptyTitle={t('billing.cashShift.historyCard.emptyTitle')}
          />
        </CardContent>
      </Card>
    </div>
  )
}
