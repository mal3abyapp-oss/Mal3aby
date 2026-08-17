import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { formatMoney } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { Users, Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's CustomerReportTab. Drill-down added: each top-
// spender row links to /app/customers?q=<name> (CustomersPage now
// reads a ?q= search param on mount) instead of a dead-end list row.
interface CustomerReport {
  new_customers: number
  top_customers: { customer_id: string; customer_name: string; total_spend: number; booking_count: number }[]
}

export function ReportCustomersPage() {
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading } = useDateRangeReport<CustomerReport>('get_customer_activity_report', startDate, endDate)

  return (
    <div>
      <PageHeader title="التقارير" description="تقرير العملاء -- عملاء جدد وأعلى العملاء إنفاقًا" />
      <ReportsNav />
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {data && (
        <>
          <div className="mb-6">
            <StatCard label="عملاء جدد" value={data.new_customers} icon={Users} to="/app/customers" />
          </div>
          <div className="mb-2 flex items-center justify-between">
            <p className="font-medium">أعلى العملاء إنفاقًا</p>
            {data.top_customers.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadCsv(
                    `customers-${startDate}-${endDate}.csv`,
                    rowsToCsv(data.top_customers, { customer_name: 'العميل', total_spend: 'إجمالي الإنفاق', booking_count: 'عدد الحجوزات' }),
                  )
                }
              >
                <Download className="me-1 size-4" />
                تصدير CSV
              </Button>
            )}
          </div>
          {data.top_customers.length === 0 ? (
            <p className="text-sm text-text-secondary">لا توجد بيانات</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {data.top_customers.map((c) => (
                <li key={c.customer_id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                  <Link to={`/app/customers?q=${encodeURIComponent(c.customer_name)}`} className="font-medium text-accent-foreground hover:underline">
                    {c.customer_name}
                  </Link>
                  <span>{formatMoney(c.total_spend)} — {c.booking_count} حجز</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
