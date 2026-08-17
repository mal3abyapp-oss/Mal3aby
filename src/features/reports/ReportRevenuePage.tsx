import { useState } from 'react'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { formatMoney, PAYMENT_METHOD_LABELS } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Wallet, Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's RevenueReportTab -- this is the "financial source"
// most other numbers (Dashboard's total_revenue, Overview's revenue
// card) point back to. Confirmed by the audit: get_executive_dashboard
// and get_revenue_report independently compute the same total_revenue/
// refunds_total predicate in two separate SQL bodies -- see the
// canonical-metrics note in MAL3ABY_IA_RESTRUCTURE_STATE.md for the
// consistency-risk tracking; not fixed at the SQL level in this pass
// (would require a migration, out of scope for a UI decomposition),
// but flagged here so a future SQL consolidation task has a clear home
// to land in.
interface RevenueReport {
  total_revenue: number
  by_day: { date: string; revenue: number }[]
  by_method: { method: string; revenue: number }[]
  refunds_total: number
}

export function ReportRevenuePage() {
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const [method, setMethod] = useState<string>('all')
  const { data, isLoading } = useDateRangeReport<RevenueReport>(
    'get_revenue_report',
    startDate,
    endDate,
    { p_method: method !== 'all' ? method : undefined },
  )

  return (
    <div>
      <PageHeader title="التقارير" description="تقرير الإيرادات -- حسب طريقة الدفع واليوم" />
      <ReportsNav />
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      <div className="mb-4 w-48">
        <Select value={method} onValueChange={setMethod}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل طرق الدفع</SelectItem>
            <SelectItem value="cash">نقدًا</SelectItem>
            <SelectItem value="card">بطاقة</SelectItem>
            <SelectItem value="bank_transfer">تحويل بنكي</SelectItem>
            <SelectItem value="wallet">محفظة إلكترونية</SelectItem>
            <SelectItem value="other">أخرى</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
            <StatCard label="إجمالي الإيرادات" value={formatMoney(data.total_revenue)} icon={Wallet} />
            <StatCard label="إجمالي المستردات" value={formatMoney(data.refunds_total)} tone="danger" />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 font-medium">حسب طريقة الدفع</p>
              {data.by_method.length === 0 ? (
                <p className="text-sm text-text-secondary">لا توجد بيانات</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_method.map((m) => (
                    <li key={m.method} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{PAYMENT_METHOD_LABELS[m.method] ?? m.method}</span>
                      <span>{formatMoney(m.revenue)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">حسب اليوم</p>
                {data.by_day.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadCsv(
                        `revenue-${startDate}-${endDate}.csv`,
                        rowsToCsv(data.by_day, { date: 'التاريخ', revenue: 'الإيرادات' }),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    تصدير CSV
                  </Button>
                )}
              </div>
              {data.by_day.length === 0 ? (
                <p className="text-sm text-text-secondary">لا توجد بيانات</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_day.map((d) => (
                    <li key={d.date} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span className="tabular-nums">{d.date}</span>
                      <span>{formatMoney(d.revenue)}</span>
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
