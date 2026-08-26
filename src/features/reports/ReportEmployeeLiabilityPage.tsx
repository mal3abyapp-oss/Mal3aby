import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { StatusBadge } from '@/components/ui/status-badge'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyDisplay } from '@/components/ui/money-display'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatMoney } from '@/lib/domain/billing'
import { translateSupabaseError } from '@/lib/errors'
import { useDirection } from '@/app/providers/DirectionProvider'
import { UserX } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Phase F (F6): employee, shortage created, settled, outstanding,
// shift, date -- exactly what the directive asks for. Reads
// employee_cash_liabilities directly (Phase D), one row per
// shortage/overage event.
interface LiabilityRow {
  liability_id: string
  employee_id: string
  employee_name: string
  kind: 'shortage' | 'overage'
  original_amount: number
  outstanding: number
  status: 'outstanding' | 'settled'
  cash_shift_id: string
  created_at: string
}

// Directive section 64: "from Employee Liabilities, click employee ->
// Staff 360 -> Financial Account. Do not build Employee Finance Detail
// twice." get_employee_liability_report returns employee_id (a raw
// auth.users id), but Staff 360 is keyed by club_memberships.id -- this
// resolves the one membership row per (user_id, club_id) pair present
// in the report so the link lands on a real Employee 360 profile
// rather than duplicating the report's own numbers in a second screen.
async function fetchMembershipIdsByUser(clubId: string, userIds: string[]) {
  if (userIds.length === 0) return new Map<string, string>()
  const { data, error } = await supabase
    .from('club_memberships')
    .select('id, user_id')
    .eq('club_id', clubId)
    .in('user_id', userIds)
  if (error) throw error
  const map = new Map<string, string>()
  for (const row of data ?? []) if (!map.has(row.user_id)) map.set(row.user_id, row.id)
  return map
}

export function ReportEmployeeLiabilityContent() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { currentClubId, currentMembership, session } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data = [], isLoading, isError, error, refetch } = useDateRangeReport<LiabilityRow[]>('get_employee_liability_report', startDate, endDate)
  const [settleRow, setSettleRow] = useState<LiabilityRow | null>(null)

  const employeeIds = [...new Set(data.map((r) => r.employee_id))]
  const { data: membershipByUser } = useQuery({
    queryKey: ['employee-liability-membership-map', currentClubId, employeeIds],
    queryFn: () => fetchMembershipIdsByUser(currentClubId!, employeeIds),
    enabled: !!currentClubId && employeeIds.length > 0,
  })

  const totalOutstanding = data.filter((r) => r.kind === 'shortage').reduce((sum, r) => sum + r.outstanding, 0)
  const totalSettled = data.filter((r) => r.kind === 'shortage').reduce((sum, r) => sum + (r.original_amount - r.outstanding), 0)

  // DEDICATED CASH LIABILITY PERMISSIONS (2026-08-26): this report is
  // the accountant's primary "see all shortages, settle one" surface --
  // reachable today via report.view alone (Finance/Reports nav domain),
  // never requiring staff.view. The Settle action itself is gated on
  // the real cash.liability.settle permission (never a role-name check)
  // plus the same self-settlement UX courtesy used on Employee 360 --
  // the actual enforcement is server-side on
  // settle_employee_cash_liability(), unconditional even for a Club
  // Owner settling their own shortage.
  const canSettle = (currentMembership?.permissionKeys ?? []).includes('cash.liability.settle')
  const currentUserId = session?.user?.id ?? null

  const columns: DataTableColumn<LiabilityRow>[] = [
    {
      key: 'employee', header: t('reports.employeeLiability.columns.employee'), render: (r) => {
        const membershipId = membershipByUser?.get(r.employee_id)
        return membershipId ? (
          <Link to={`/app/staff/${membershipId}`} className="text-accent-foreground hover:underline">{r.employee_name}</Link>
        ) : r.employee_name
      },
    },
    { key: 'date', header: t('reports.employeeLiability.columns.date'), render: (r) => new Date(r.created_at).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG') },
    {
      key: 'kind',
      header: t('reports.employeeLiability.columns.kind'),
      render: (r) => <StatusBadge tone={r.kind === 'shortage' ? 'danger' : 'info'} label={t(`reports.employeeLiability.kindLabels.${r.kind}`)} />,
    },
    { key: 'original', header: t('reports.employeeLiability.columns.originalAmount'), render: (r) => formatMoney(r.original_amount, 'EGP', locale) },
    { key: 'outstanding', header: t('reports.employeeLiability.columns.outstanding'), render: (r) => formatMoney(r.outstanding, 'EGP', locale) },
    {
      key: 'status',
      header: t('reports.employeeLiability.columns.status'),
      render: (r) => <StatusBadge tone={r.status === 'settled' ? 'success' : 'warning'} label={t(`reports.employeeLiability.statusLabels.${r.status}`)} />,
    },
    {
      key: 'actions',
      header: '',
      render: (r) => (r.kind === 'shortage' && r.outstanding > 0 && canSettle && r.employee_id !== currentUserId) ? (
        <Button size="sm" variant="outline" onClick={() => setSettleRow(r)}>{t('staff.detail.settle', { defaultValue: 'Settle' })}</Button>
      ) : null,
    },
  ]

  return (
    <div>
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {isError && <ErrorState message={translateSupabaseError(error, t('reports.loadError'))} onRetry={() => void refetch()} />}
      {!isLoading && !isError && (
        <>
          <div className="mb-6 grid gap-4 md:grid-cols-2">
            <StatCard label={t('reports.employeeLiability.totalOutstanding')} value={formatMoney(totalOutstanding, 'EGP', locale)} icon={UserX} tone={totalOutstanding > 0 ? 'danger' : 'default'} />
            <StatCard label={t('reports.employeeLiability.totalSettled')} value={formatMoney(totalSettled, 'EGP', locale)} icon={UserX} />
          </div>
          <DataTable
            columns={columns}
            rows={data}
            rowKey={(r) => r.liability_id}
            isLoading={isLoading}
            emptyTitle={t('reports.noData')}
          />
        </>
      )}
      {settleRow && (
        <SettleReportLiabilityDialog
          row={settleRow}
          onClose={() => setSettleRow(null)}
          onSettled={() => { setSettleRow(null); void refetch() }}
        />
      )}
    </div>
  )
}

// DEDICATED CASH LIABILITY PERMISSIONS (2026-08-26): a standalone
// dialog (not a re-export of Employee360Page's SettleLiabilityDialog --
// that one is keyed off a different row shape, {id, settled_amount},
// while get_employee_liability_report() returns {liability_id,
// original_amount, outstanding}). Same RPC, same guards, same
// remaining-after preview and success-state pattern, same i18n keys --
// deliberately kept in sync with Employee 360's dialog rather than
// introducing a second set of settle-flow copy.
function SettleReportLiabilityDialog({
  row, onClose, onSettled,
}: {
  row: LiabilityRow
  onClose: () => void
  onSettled: () => void
}) {
  const { t, i18n } = useTranslation()
  const locale = i18n.language === 'en' ? 'en' : 'ar'
  const [amount, setAmount] = useState(() => row.outstanding.toFixed(2))
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const idempotencyKeyRef = useRef<string | null>(null)
  const queryClient = useQueryClient()

  const parsedAmount = Number(amount)
  const isValidAmount = Number.isFinite(parsedAmount) && parsedAmount > 0
  const exceedsOutstanding = isValidAmount && parsedAmount > row.outstanding
  const remainingAfter = isValidAmount && !exceedsOutstanding ? row.outstanding - parsedAmount : null
  const willFullyClose = remainingAfter !== null && remainingAfter <= 0
  const settledSoFar = row.original_amount - row.outstanding

  const settleMutation = useMutation({
    mutationFn: async () => {
      if (!isValidAmount) throw new Error(t('bookings.detail.invalidAmountError'))
      if (exceedsOutstanding) throw new Error(t('staff.detail.settleErrorOverpayment'))
      if (!idempotencyKeyRef.current) idempotencyKeyRef.current = crypto.randomUUID()
      const { error: rpcError } = await supabase.rpc('settle_employee_cash_liability', {
        p_liability_id: row.liability_id, p_amount: parsedAmount, p_reason: reason || undefined,
        p_idempotency_key: idempotencyKeyRef.current,
      })
      if (rpcError) throw rpcError
    },
    onSuccess: () => {
      setSuccessMessage(
        willFullyClose
          ? t('staff.detail.settleSuccessFull')
          : t('staff.detail.settleSuccessPartial', { amount: formatMoney(remainingAfter ?? 0, 'EGP', locale) }),
      )
      void queryClient.invalidateQueries({ queryKey: ['employee-liability-membership-map'] })
      window.setTimeout(onSettled, 900)
    },
    onError: (err) => setError(translateSupabaseError(err, t('staff.detail.settleError', { defaultValue: "Couldn't settle this liability." }))),
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{row.employee_name} — {t('staff.detail.settle', { defaultValue: 'Settle' })}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
            <span className="text-text-secondary">{t('staff.detail.settleOriginalAmount')}</span>
            <MoneyDisplay amount={row.original_amount} size="sm" />
          </div>
          {settledSoFar > 0 && (
            <div className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
              <span className="text-text-secondary">{t('staff.detail.settlePreviouslySettled')}</span>
              <MoneyDisplay amount={settledSoFar} size="sm" />
            </div>
          )}
          <div className="flex items-center justify-between rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm">
            <span>{t('staff.detail.outstanding', { defaultValue: 'Outstanding' })}</span>
            <MoneyDisplay amount={row.outstanding} tone="danger" size="sm" />
          </div>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-text-secondary">{t('staff.detail.settleAmountLabel')}</span>
            <Input
              type="number"
              min={0}
              max={row.outstanding}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={settleMutation.isPending || !!successMessage}
            />
          </label>
          <Input
            placeholder={t('staff.detail.reasonOptional', { defaultValue: 'Reason (optional)' })}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={settleMutation.isPending || !!successMessage}
          />

          {isValidAmount && !exceedsOutstanding && !successMessage && (
            <div className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-text-secondary">{t('staff.detail.settleRemainingAfter')}</span>
                <MoneyDisplay amount={remainingAfter ?? 0} size="sm" tone={willFullyClose ? 'default' : 'danger'} />
              </div>
              {willFullyClose && (
                <p className="text-xs text-status-success">{t('staff.detail.settleWillClose')}</p>
              )}
            </div>
          )}
          {exceedsOutstanding && !successMessage && (
            <p role="alert" className="text-sm text-status-danger">{t('staff.detail.settleErrorOverpayment')}</p>
          )}

          {error && <p role="alert" className="text-sm text-status-danger">{error}</p>}
          {successMessage && <p role="status" className="text-sm text-status-success">{successMessage}</p>}

          <Button
            disabled={settleMutation.isPending || !isValidAmount || exceedsOutstanding || !!successMessage}
            onClick={() => { setError(null); settleMutation.mutate() }}
          >
            {settleMutation.isPending
              ? t('staff.detail.settling')
              : isValidAmount && !exceedsOutstanding
                ? t('staff.detail.settleConfirm', { amount: formatMoney(parsedAmount, 'EGP', locale) })
                : t('staff.detail.settle', { defaultValue: 'Settle' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ReportEmployeeLiabilityPage() {
  const { t } = useTranslation()
  return (
    <div>
      <PageHeader title={t('reports.title')} description={t('reports.employeeLiability.description')} />
      <ReportsNav />
      <ReportEmployeeLiabilityContent />
    </div>
  )
}
