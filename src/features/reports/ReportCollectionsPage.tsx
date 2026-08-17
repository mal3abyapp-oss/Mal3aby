import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { formatMoney } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { HandCoins, Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's CollectionsReportTab. Same RPC (get_collections_report)
// is also called by OwnerFinanceTransparency.tsx's TodayPage widget
// (scoped to today) -- legitimate reuse of the same source of truth,
// not duplicated logic.
interface CollectionsReport {
  total_collected: number
  by_employee: { user_id: string | null; full_name: string; amount: number; payment_count: number }[]
  by_branch: { branch_id: string; branch_name: string; amount: number; payment_count: number }[]
}

export function ReportCollectionsPage() {
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading } = useDateRangeReport<CollectionsReport>('get_collections_report', startDate, endDate)

  return (
    <div>
      <PageHeader title="التقارير" description="تقرير التحصيلات -- حسب الموظف والفرع" />
      <ReportsNav />
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {data && (
        <>
          <div className="mb-6">
            <StatCard label="إجمالي التحصيلات" value={formatMoney(data.total_collected)} icon={HandCoins} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">حسب الموظف</p>
                {data.by_employee.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadCsv(
                        `collections-by-employee-${startDate}-${endDate}.csv`,
                        rowsToCsv(
                          data.by_employee.map((e) => ({ full_name: e.full_name, amount: e.amount, payment_count: e.payment_count })),
                          { full_name: 'الموظف', amount: 'المبلغ المحصّل', payment_count: 'عدد الدفعات' },
                        ),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    تصدير CSV
                  </Button>
                )}
              </div>
              {data.by_employee.length === 0 ? (
                <p className="text-sm text-text-secondary">لا توجد بيانات</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_employee.map((e) => (
                    <li key={e.user_id ?? 'unknown'} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{e.full_name}</span>
                      <span>{formatMoney(e.amount)} — {e.payment_count} دفعة</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">حسب الفرع</p>
                {data.by_branch.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadCsv(
                        `collections-by-branch-${startDate}-${endDate}.csv`,
                        rowsToCsv(
                          data.by_branch.map((b) => ({ branch_name: b.branch_name, amount: b.amount, payment_count: b.payment_count })),
                          { branch_name: 'الفرع', amount: 'المبلغ المحصّل', payment_count: 'عدد الدفعات' },
                        ),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    تصدير CSV
                  </Button>
                )}
              </div>
              {data.by_branch.length === 0 ? (
                <p className="text-sm text-text-secondary">لا توجد بيانات</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_branch.map((b) => (
                    <li key={b.branch_id} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{b.branch_name}</span>
                      <span>{formatMoney(b.amount)} — {b.payment_count} دفعة</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
