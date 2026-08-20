import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { formatMoney } from '@/lib/domain/billing'
import { useDateRange, useDateRangeReport } from '@/features/reports/hooks/useDateRangeReport'
import { DateRangeFilter } from '@/features/reports/components/DateRangeFilter'
import { classifyOutstandingInvoices } from '@/lib/domain/finance'
import {
  Wallet, HandCoins, Banknote, CreditCard, CircleDollarSign, ReceiptText,
  FileWarning, Undo2, ShieldCheck, Scale, Clock, Image as ImageIcon, UserX,
} from 'lucide-react'

// Finance IA consolidation directive section 5: a real operational
// dashboard, not decorative KPIs. Every card drill-downs into the tab
// that owns that number (section 5: "Outstanding -> Payments &
// Collections with filter=outstanding", "Open Shift -> Cash Shifts",
// "Official Receipts -> Invoices & Receipts"). Composed entirely from
// EXISTING report RPCs (get_executive_dashboard, get_payment_method_report)
// plus two small direct reads (open cash shifts, pending payment proofs)
// -- no new RPC written for this page, per directive section 83/36
// ("reuse existing RPCs... one source of truth").
interface ExecutiveDashboard {
  total_revenue: number
  refunds_total: number
  outstanding_total: number
}

interface PaymentMethodBreakdown {
  total_collected: number
  total_refunded: number
  by_method: { method: string; collected: number; refunded: number; net: number }[]
}

async function fetchOutstandingSplit(clubId: string) {
  const { data, error } = await supabase
    .from('outstanding_invoices')
    .select('total, outstanding')
    .eq('club_id', clubId)
  if (error) throw error
  return classifyOutstandingInvoices(
    (data ?? []).map((row) => ({ total: Number(row.total), outstanding: Number(row.outstanding ?? 0) })),
  )
}

async function fetchOpenShiftsCount(clubId: string) {
  const { count, error } = await supabase
    .from('cash_shifts')
    .select('id', { count: 'exact', head: true })
    .eq('club_id', clubId)
    .eq('status', 'open')
  if (error) throw error
  return count ?? 0
}

async function fetchExpectedCashNow(clubId: string) {
  const { data, error } = await supabase.rpc('get_open_cash_shifts', { p_club_id: clubId })
  if (error) throw error
  const rows = (data ?? []) as unknown as { opening_float: number }[]
  // get_open_cash_shifts only reports opening_float + age, not live
  // expected cash per-shift (that requires get_open_cash_shift_status
  // per shift id, deliberately not fanned out here to keep the
  // Overview a single fast read) -- shown as an "opening total" proxy
  // with a note, real live figure is on the Cash tab itself.
  return rows.reduce((sum, r) => sum + Number(r.opening_float ?? 0), 0)
}

// Directive section 62: "if there is employee outstanding, Finance
// Overview can show Employee Liabilities Total." Reads the same
// employee_cash_liabilities table Staff 360's Financial Account tab
// reads -- one source, two views.
async function fetchEmployeeLiabilitiesOutstanding(clubId: string) {
  const { data, error } = await supabase
    .from('employee_cash_liabilities')
    .select('outstanding')
    .eq('club_id', clubId)
    .eq('status', 'outstanding')
  if (error) throw error
  return (data ?? []).reduce((sum, r) => sum + Number(r.outstanding ?? 0), 0)
}

async function fetchPendingProofsCount(clubId: string) {
  const { count, error } = await supabase
    .from('payment_proofs')
    .select('id', { count: 'exact', head: true })
    .eq('club_id', clubId)
    .eq('status', 'pending_review')
  if (error) throw error
  return count ?? 0
}

async function fetchOfficialReceiptsCount(clubId: string, startDate: string, endDate: string) {
  const { count, error } = await supabase
    .from('official_collection_receipts')
    .select('id', { count: 'exact', head: true })
    .eq('club_id', clubId)
    .gte('receipt_date', startDate)
    .lte('receipt_date', endDate)
  if (error) throw error
  return count ?? 0
}

export function FinanceOverviewPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data: dashboard, isLoading: dashboardLoading } = useDateRangeReport<ExecutiveDashboard>(
    'get_executive_dashboard', startDate, endDate,
  )
  const { data: methodBreakdown, isLoading: methodLoading } = useDateRangeReport<PaymentMethodBreakdown>(
    'get_payment_method_report', startDate, endDate,
  )
  const { data: outstandingSplit } = useQuery({
    queryKey: ['finance-overview-outstanding-split', currentClubId],
    queryFn: () => fetchOutstandingSplit(currentClubId!),
    enabled: !!currentClubId,
  })
  const { data: openShiftsCount = 0 } = useQuery({
    queryKey: ['finance-overview-open-shifts', currentClubId],
    queryFn: () => fetchOpenShiftsCount(currentClubId!),
    enabled: !!currentClubId,
  })
  const { data: expectedCashNow = 0 } = useQuery({
    queryKey: ['finance-overview-expected-cash', currentClubId],
    queryFn: () => fetchExpectedCashNow(currentClubId!),
    enabled: !!currentClubId,
  })
  const { data: pendingProofsCount = 0 } = useQuery({
    queryKey: ['finance-overview-pending-proofs', currentClubId],
    queryFn: () => fetchPendingProofsCount(currentClubId!),
    enabled: !!currentClubId,
  })
  const { data: employeeLiabilitiesOutstanding = 0 } = useQuery({
    queryKey: ['finance-overview-employee-liabilities', currentClubId],
    queryFn: () => fetchEmployeeLiabilitiesOutstanding(currentClubId!),
    enabled: !!currentClubId,
  })
  const { data: officialReceiptsCount = 0 } = useQuery({
    queryKey: ['finance-overview-official-receipts', currentClubId, startDate, endDate],
    queryFn: () => fetchOfficialReceiptsCount(currentClubId!, startDate, endDate),
    enabled: !!currentClubId,
  })

  const isLoading = dashboardLoading || methodLoading
  const cashRow = methodBreakdown?.by_method.find((m) => m.method === 'cash')
  const transferRow = methodBreakdown?.by_method.find((m) => m.method === 'bank_transfer')
  const electronicTotal = (methodBreakdown?.by_method ?? [])
    .filter((m) => m.method === 'card' || m.method === 'wallet')
    .reduce((sum, m) => sum + m.collected, 0)
  const netMovement = (dashboard?.total_revenue ?? 0) - (dashboard?.refunds_total ?? 0)

  return (
    <div>
      <PageHeader title={t('finance.title')} description={t('finance.description')} />
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />

      {isLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}

      {!isLoading && dashboard && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard
            label={t('finance.overview.revenue')}
            value={formatMoney(dashboard.total_revenue, 'EGP', locale)}
            icon={Wallet}
            to="/app/finance/reports"
          />
          <StatCard
            label={t('finance.overview.cashCollected')}
            value={formatMoney(cashRow?.collected ?? 0, 'EGP', locale)}
            icon={HandCoins}
            to="/app/finance/cash"
          />
          <StatCard
            label={t('finance.overview.bankTransfers')}
            value={formatMoney(transferRow?.collected ?? 0, 'EGP', locale)}
            icon={Banknote}
            to="/app/finance/reports"
          />
          <StatCard
            label={t('finance.overview.electronicPayments')}
            value={formatMoney(electronicTotal, 'EGP', locale)}
            icon={CreditCard}
            to="/app/finance/reports"
          />
          <StatCard
            label={t('finance.overview.outstanding')}
            value={formatMoney(dashboard.outstanding_total, 'EGP', locale)}
            tone={dashboard.outstanding_total > 0 ? 'warning' : undefined}
            icon={CircleDollarSign}
            to="/app/finance/payments?status=outstanding"
          />
          <StatCard
            label={t('finance.overview.unpaidInvoices')}
            value={outstandingSplit?.unpaidCount ?? 0}
            icon={ReceiptText}
            to="/app/finance/payments?status=unpaid"
          />
          <StatCard
            label={t('finance.overview.partiallyPaidInvoices')}
            value={outstandingSplit?.partialCount ?? 0}
            icon={FileWarning}
            to="/app/finance/payments?status=partially_paid"
          />
          <StatCard
            label={t('finance.overview.refunds')}
            value={formatMoney(dashboard.refunds_total, 'EGP', locale)}
            tone="danger"
            icon={Undo2}
            to="/app/finance/payments?status=refunded"
          />
          <StatCard
            label={t('finance.overview.netMovement')}
            value={formatMoney(netMovement, 'EGP', locale)}
            tone={netMovement >= 0 ? 'success' : 'danger'}
            icon={Scale}
            to="/app/finance/reports"
          />
          <StatCard
            label={t('finance.overview.openShifts')}
            value={openShiftsCount}
            tone={openShiftsCount > 0 ? 'success' : undefined}
            icon={Wallet}
            to="/app/finance/cash"
          />
          <StatCard
            label={t('finance.overview.expectedCashDrawer')}
            value={formatMoney(expectedCashNow, 'EGP', locale)}
            icon={CircleDollarSign}
            to="/app/finance/cash"
          />
          <StatCard
            label={t('finance.overview.pendingProofs')}
            value={pendingProofsCount}
            tone={pendingProofsCount > 0 ? 'warning' : undefined}
            icon={ImageIcon}
            to="/app/finance/payments?tab=pending-proofs"
          />
          <StatCard
            label={t('finance.overview.officialReceipts')}
            value={officialReceiptsCount}
            icon={ShieldCheck}
            to="/app/finance/invoices?tab=official-receipts"
          />
          <StatCard
            label={t('finance.overview.expenses')}
            value={t('finance.overview.notApplicable')}
            icon={Clock}
            to="/app/finance/expenses"
          />
          <StatCard
            label={t('finance.overview.employeeLiabilities', { defaultValue: 'Employee Liabilities' })}
            value={formatMoney(employeeLiabilitiesOutstanding, 'EGP', locale)}
            tone={employeeLiabilitiesOutstanding > 0 ? 'danger' : undefined}
            icon={UserX}
            to="/app/reports/employee-liability"
          />
        </div>
      )}
    </div>
  )
}
