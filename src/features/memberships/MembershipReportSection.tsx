import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { StatCard } from '@/components/ui/stat-card'
import { MoneyDisplay } from '@/components/ui/money-display'
import { StatusBadge } from '@/components/ui/status-badge'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatMoney } from '@/lib/domain/billing'
import { translateSupabaseError } from '@/lib/errors'
import { CLUB_MEMBERSHIP_STATUS_TONE } from '@/lib/domain/clubMembership'
import { useDateRange } from '@/features/reports/hooks/useDateRangeReport'
import { DateRangeFilter } from '@/features/reports/components/DateRangeFilter'
import { ReportPrintButton, ReportPrintHeader } from '@/components/ui/report-print-header'
import { UserPlus, RefreshCw, UserX, Wallet, HandCoins, Undo2, CircleDollarSign } from 'lucide-react'

// FINAL REPORTING COVERAGE CLOSURE (2026-08-30): Club Membership
// Lifecycle & Revenue report -- the one confirmed material gap from
// the prior comprehensive reports acceptance pass. New "Report" tab
// on the existing MembershipsPage.tsx, matching this app's own
// established Reports pattern exactly (useDateRange/
// useDateRangeReport-equivalent, ReportPrintButton/ReportPrintHeader/
// .print-target, StatCard grid, DataTable) -- not a new architecture.
//
// Server source: get_club_membership_report() (KPIs/by-plan/expiring/
// financials) + list_club_membership_report_rows() (paginated
// lifecycle table) -- both fixed/added this session to use the REAL
// renewal linkage (renew_club_membership()'s own audit-log
// before->>'previous_membership_subscription_id', not "does this
// customer have any earlier row ever") and the authoritative
// get_invoice_payment_summary() for every financial figure. See
// REPORTING_COVERAGE_FINAL_CLOSURE.md Section 1 for the full domain
// inspection this was built from.

interface ByPlanRow {
  plan_id: string
  plan_name_ar: string
  plan_name_en: string
  is_active: boolean
  active_membership_count: number
  total_membership_count: number
  new_in_range_count: number
}

interface ExpiringRow {
  membership_subscription_id: string
  membership_number: string
  customer_name: string
  plan_name_ar: string
  plan_name_en: string
  effective_end_date: string
}

interface MembershipReportSummary {
  counts_by_status: Record<string, number>
  expiring_within_range: ExpiringRow[]
  renewals_in_range: number
  new_memberships_in_range: number
  cancellations_in_range: number
  by_plan: ByPlanRow[]
  financials: {
    gross_revenue: number
    collected: number
    refunded: number
    outstanding: number
    average_membership_value: number | null
    membership_count: number
  }
}

interface LifecycleRow {
  membership_subscription_id: string
  membership_number: string
  customer_id: string
  customer_name: string
  plan_id: string
  plan_name_ar_snapshot: string
  plan_name_en_snapshot: string
  status: string
  effective_status: string
  start_date: string
  end_date: string
  created_at: string
  cancelled_at: string | null
  branch_id: string
  branch_name: string
  price_snapshot: number
  is_renewal: boolean
  total: number
  paid: number
  refunded: number
  outstanding: number
  payment_status: string
}

interface LifecycleResult { total_count: number; page: number; page_size: number; rows: LifecycleRow[] }

const PAGE_SIZE = 25

async function fetchSummary(clubId: string, startDate: string, endDate: string, planId: string): Promise<MembershipReportSummary> {
  const { data, error } = await supabase.rpc('get_club_membership_report', {
    p_club_id: clubId,
    p_start_date: startDate,
    p_end_date: endDate,
    p_plan_id: planId || undefined,
  })
  if (error) throw error
  return data as unknown as MembershipReportSummary
}

async function fetchLifecycleRows(clubId: string, startDate: string, endDate: string, planId: string, status: string, page: number): Promise<LifecycleResult> {
  const { data, error } = await supabase.rpc('list_club_membership_report_rows', {
    p_club_id: clubId,
    p_start_date: startDate,
    p_end_date: endDate,
    p_plan_id: planId || undefined,
    p_status: status || undefined,
    p_page: page,
    p_page_size: PAGE_SIZE,
  })
  if (error) throw error
  return data as unknown as LifecycleResult
}

async function fetchPlans(clubId: string): Promise<{ id: string; nameAr: string; nameEn: string }[]> {
  const { data, error } = await supabase.from('club_membership_plans').select('id, name_ar, name_en').eq('club_id', clubId).is('archived_at', null).order('sort_order')
  if (error) throw error
  return (data ?? []).map((p) => ({ id: p.id, nameAr: p.name_ar, nameEn: p.name_en }))
}

const LIFECYCLE_STATUS_OPTIONS = ['pending_payment', 'scheduled', 'active', 'frozen', 'expired', 'cancelled'] as const

export function MembershipReportSection() {
  const { t, i18n } = useTranslation()
  const { locale } = useDirection()
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const [planId, setPlanId] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)

  const { data: plans = [] } = useQuery({
    queryKey: ['club-membership-report-plans', currentClubId],
    queryFn: () => fetchPlans(currentClubId!),
    enabled: !!currentClubId,
  })

  const { data: summary, isLoading: summaryLoading, isError: summaryError, error: summaryErrorObj, refetch: refetchSummary } = useQuery({
    queryKey: ['club-membership-report-summary', currentClubId, startDate, endDate, planId],
    queryFn: () => fetchSummary(currentClubId!, startDate, endDate, planId),
    enabled: !!currentClubId,
  })

  const { data: lifecycle, isLoading: rowsLoading } = useQuery({
    queryKey: ['club-membership-report-rows', currentClubId, startDate, endDate, planId, statusFilter, page],
    queryFn: () => fetchLifecycleRows(currentClubId!, startDate, endDate, planId, statusFilter, page),
    enabled: !!currentClubId,
  })

  const planName = (p: { nameAr: string; nameEn: string }) => (i18n.language === 'en' ? p.nameEn : p.nameAr) || p.nameAr

  const rows = lifecycle?.rows ?? []
  const totalCount = lifecycle?.total_count ?? 0
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE))

  const filterSummary = `${t('clubMemberships.report.title')} — ${startDate} → ${endDate}${planId ? ` — ${planName(plans.find((p) => p.id === planId) ?? { nameAr: '', nameEn: '' })}` : ''}`

  const columns: DataTableColumn<LifecycleRow>[] = [
    { key: 'customer', header: t('common.name'), render: (r) => r.customer_name },
    { key: 'plan', header: t('clubMemberships.membershipPlan'), render: (r) => i18n.language === 'en' ? r.plan_name_en_snapshot : r.plan_name_ar_snapshot },
    {
      key: 'event',
      header: t('clubMemberships.report.columns.event'),
      render: (r) => r.cancelled_at
        ? <StatusBadge tone="danger" label={t('clubMemberships.report.event.cancelled')} />
        : r.is_renewal
          ? <StatusBadge tone="info" label={t('clubMemberships.report.event.renewal')} />
          : <StatusBadge tone="success" label={t('clubMemberships.report.event.new')} />,
    },
    {
      key: 'status',
      header: t('common.status', { defaultValue: 'Status' }),
      render: (r) => (
        <StatusBadge
          tone={CLUB_MEMBERSHIP_STATUS_TONE[r.effective_status] ?? 'neutral'}
          label={t(`clubMemberships.statusLabels.${r.effective_status}`, { defaultValue: r.effective_status })}
        />
      ),
    },
    { key: 'start', header: t('clubMemberships.startDate'), render: (r) => <span className="tabular-nums">{r.start_date}</span> },
    { key: 'end', header: t('clubMemberships.expiryDate'), render: (r) => <span className="tabular-nums">{r.end_date}</span> },
    { key: 'total', header: t('clubMemberships.report.columns.total'), render: (r) => <MoneyDisplay amount={r.total} size="sm" /> },
    { key: 'paid', header: t('clubMemberships.report.columns.paid'), render: (r) => <MoneyDisplay amount={r.paid} size="sm" tone="success" /> },
    {
      key: 'refunded',
      header: t('clubMemberships.report.columns.refunded'),
      render: (r) => r.refunded > 0 ? <MoneyDisplay amount={r.refunded} size="sm" tone="danger" /> : <span className="text-text-secondary">—</span>,
    },
    {
      key: 'outstanding',
      header: t('clubMemberships.report.columns.outstanding'),
      render: (r) => r.outstanding > 0 ? <MoneyDisplay amount={r.outstanding} size="sm" tone="danger" /> : <span className="text-text-secondary">—</span>,
    },
  ]

  return (
    <div className="mt-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2 print:hidden">
        <div className="flex flex-wrap items-end gap-2">
          <DateRangeFilter startDate={startDate} endDate={endDate} onStart={(v) => { setStartDate(v); setPage(1) }} onEnd={(v) => { setEndDate(v); setPage(1) }} />
          <label className="flex flex-col gap-1 text-xs text-text-secondary">
            {t('clubMemberships.membershipPlan')}
            <Select value={planId || 'all'} onValueChange={(v) => { setPlanId(v === 'all' ? '' : v); setPage(1) }}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('clubMemberships.members.allStatuses', { defaultValue: t('common.all', { defaultValue: 'All' }) })}</SelectItem>
                {plans.map((p) => <SelectItem key={p.id} value={p.id}><bdi>{planName(p)}</bdi></SelectItem>)}
              </SelectContent>
            </Select>
          </label>
        </div>
        {summary && <ReportPrintButton />}
      </div>

      {summaryLoading && <p className="text-sm text-text-secondary">{t('reports.loading')}</p>}
      {summaryError && <ErrorState message={translateSupabaseError(summaryErrorObj, t('reports.loadError'))} onRetry={() => void refetchSummary()} />}

      {summary && (
        <div className="print-target visible-for-print flex flex-col gap-6">
          <ReportPrintHeader reportName={t('clubMemberships.report.title')} filterSummary={filterSummary} />

          <div>
            <p className="mb-2 text-xs font-medium text-text-secondary">{t('clubMemberships.report.lifecycleSectionLabel')}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard label={t('clubMemberships.report.newMemberships')} value={summary.new_memberships_in_range} icon={UserPlus} tone="success" />
              <StatCard label={t('clubMemberships.report.renewals')} value={summary.renewals_in_range} icon={RefreshCw} />
              <StatCard label={t('clubMemberships.report.cancellations')} value={summary.cancellations_in_range} icon={UserX} tone={summary.cancellations_in_range > 0 ? 'danger' : 'default'} />
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-text-secondary">{t('clubMemberships.report.statusSectionLabel')}</p>
            <div className="flex flex-wrap gap-2">
              {LIFECYCLE_STATUS_OPTIONS.map((s) => (
                <div key={s} className="flex items-center gap-2 rounded-md border border-border p-2 text-sm">
                  <StatusBadge tone={CLUB_MEMBERSHIP_STATUS_TONE[s] ?? 'neutral'} label={t(`clubMemberships.statusLabels.${s}`)} />
                  <span className="tabular-nums font-medium">{summary.counts_by_status[s] ?? 0}</span>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-2 text-xs font-medium text-text-secondary">{t('clubMemberships.report.financialsSectionLabel')}</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <StatCard label={t('clubMemberships.report.grossRevenue')} value={<MoneyDisplay amount={summary.financials.gross_revenue} size="md" />} icon={Wallet} />
              <StatCard label={t('clubMemberships.report.collected')} value={<MoneyDisplay amount={summary.financials.collected} size="md" tone="success" />} icon={HandCoins} />
              <StatCard label={t('clubMemberships.report.refunded')} value={<MoneyDisplay amount={summary.financials.refunded} size="md" tone="danger" />} icon={Undo2} />
              <StatCard label={t('clubMemberships.report.outstanding')} value={<MoneyDisplay amount={summary.financials.outstanding} size="md" tone={summary.financials.outstanding > 0 ? 'danger' : 'default'} />} icon={CircleDollarSign} />
              <StatCard
                label={t('clubMemberships.report.averageValue')}
                value={summary.financials.average_membership_value !== null ? formatMoney(summary.financials.average_membership_value, 'EGP', locale) : '—'}
                icon={Wallet}
              />
            </div>
          </div>

          {summary.by_plan.length > 0 && (
            <div>
              <p className="mb-2 font-medium">{t('clubMemberships.report.topPlans')}</p>
              <ul className="flex flex-col gap-1">
                {summary.by_plan.map((p) => (
                  <li key={p.plan_id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                    <span><bdi>{i18n.language === 'en' ? p.plan_name_en : p.plan_name_ar}</bdi>{!p.is_active && <span className="ms-1 text-xs text-text-secondary">({t('clubMemberships.plans.archived', { defaultValue: t('common.inactive', { defaultValue: 'Inactive' }) })})</span>}</span>
                    <span className="flex items-center gap-3 text-xs text-text-secondary">
                      <span>{t('clubMemberships.report.newInRange')}: <span className="tabular-nums font-medium text-text-primary">{p.new_in_range_count}</span></span>
                      <span>{t('clubMemberships.report.activeNow')}: <span className="tabular-nums font-medium text-text-primary">{p.active_membership_count}</span></span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.expiring_within_range.length > 0 && (
            <div>
              <p className="mb-2 font-medium">{t('clubMemberships.report.expiringInRange')}</p>
              <ul className="flex flex-col gap-1">
                {summary.expiring_within_range.map((e) => (
                  <li key={e.membership_subscription_id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                    <span>{e.customer_name} — <bdi>{i18n.language === 'en' ? e.plan_name_en : e.plan_name_ar}</bdi></span>
                    <span className="tabular-nums text-text-secondary">{e.effective_end_date}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 print:hidden">
              <p className="font-medium">{t('clubMemberships.report.lifecycleTable')}</p>
              <Select value={statusFilter || 'all'} onValueChange={(v) => { setStatusFilter(v === 'all' ? '' : v); setPage(1) }}>
                <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('clubMemberships.members.allStatuses')}</SelectItem>
                  {LIFECYCLE_STATUS_OPTIONS.map((s) => <SelectItem key={s} value={s}>{t(`clubMemberships.statusLabels.${s}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <DataTable
              columns={columns}
              rows={rows}
              rowKey={(r) => r.membership_subscription_id}
              isLoading={rowsLoading}
              emptyTitle={t('clubMemberships.report.emptyTitle')}
              emptyDescription={t('clubMemberships.report.emptyDescription')}
            />
            {totalPages > 1 && (
              <div className="mt-2 flex items-center justify-between text-sm text-text-secondary print:hidden">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>{t('common.previous', { defaultValue: 'Previous' })}</Button>
                <span>{t('common.pageOfTotal', { page, total: totalPages })}</span>
                <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>{t('common.next', { defaultValue: 'Next' })}</Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
