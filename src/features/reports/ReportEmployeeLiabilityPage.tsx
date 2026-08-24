import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { StatusBadge } from '@/components/ui/status-badge'
import { DataTable, type DataTableColumn } from '@/components/ui/data-table'
import { ErrorState } from '@/components/ui/error-state'
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
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data = [], isLoading, isError, error, refetch } = useDateRangeReport<LiabilityRow[]>('get_employee_liability_report', startDate, endDate)

  const employeeIds = [...new Set(data.map((r) => r.employee_id))]
  const { data: membershipByUser } = useQuery({
    queryKey: ['employee-liability-membership-map', currentClubId, employeeIds],
    queryFn: () => fetchMembershipIdsByUser(currentClubId!, employeeIds),
    enabled: !!currentClubId && employeeIds.length > 0,
  })

  const totalOutstanding = data.filter((r) => r.kind === 'shortage').reduce((sum, r) => sum + r.outstanding, 0)
  const totalSettled = data.filter((r) => r.kind === 'shortage').reduce((sum, r) => sum + (r.original_amount - r.outstanding), 0)

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
    </div>
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
