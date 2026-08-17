import { PageHeader } from '@/components/ui/page-header'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { formatMoney } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { Download } from 'lucide-react'
import { useDateRange, useDateRangeReport } from './hooks/useDateRangeReport'
import { DateRangeFilter } from './components/DateRangeFilter'
import { ReportsNav } from './components/ReportsNav'

// Master IA/UX audit (Reports decomposition phase): extracted from
// ReportsPage.tsx's FinancialExceptionsReportTab. Also reused by
// OwnerFinanceTransparency.tsx's TodayPage widget (scoped to today) --
// legitimate reuse, not duplicated logic. RTL fix carried forward from
// the shared audit: invoice_number wrapped in <bdi> (was unprotected
// in the original tab).
interface FinancialExceptionsReport {
  total_discounts: number
  total_refunds: number
  void_invoice_count: number
  discounts: {
    booking_id: string
    invoice_number: string | null
    customer_name: string | null
    discount_amount: number
    total_price: number
    applied_by: string
    created_at: string
  }[]
  refunds: {
    refund_id: string
    amount: number
    reason: string | null
    refunded_by: string
    refunded_at: string
    customer_name: string
    payment_method: string
  }[]
}

export function ReportExceptionsPage() {
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const { data, isLoading } = useDateRangeReport<FinancialExceptionsReport>('get_financial_exceptions_report', startDate, endDate)

  return (
    <div>
      <PageHeader title="التقارير" description="الاستثناءات المالية -- خصومات، مستردات، وفواتير ملغاة" />
      <ReportsNav />
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
            <StatCard label="إجمالي الخصومات" value={formatMoney(data.total_discounts)} tone={data.total_discounts > 0 ? 'warning' : undefined} />
            <StatCard label="إجمالي المستردات" value={formatMoney(data.total_refunds)} tone="danger" />
            <StatCard label="فواتير ملغاة" value={data.void_invoice_count} tone={data.void_invoice_count > 0 ? 'warning' : undefined} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">الخصومات</p>
                {data.discounts.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadCsv(
                        `discounts-${startDate}-${endDate}.csv`,
                        rowsToCsv(
                          data.discounts.map((d) => ({
                            invoice_number: d.invoice_number ?? '—',
                            customer_name: d.customer_name ?? '—',
                            discount_amount: d.discount_amount,
                            total_price: d.total_price,
                            applied_by: d.applied_by,
                            created_at: d.created_at,
                          })),
                          {
                            invoice_number: 'رقم الفاتورة',
                            customer_name: 'العميل',
                            discount_amount: 'قيمة الخصم',
                            total_price: 'إجمالي الحجز',
                            applied_by: 'طبّقه',
                            created_at: 'التاريخ',
                          },
                        ),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    تصدير CSV
                  </Button>
                )}
              </div>
              {data.discounts.length === 0 ? (
                <p className="text-sm text-text-secondary">لا توجد خصومات في هذه الفترة</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.discounts.map((d) => (
                    <li key={d.booking_id} className="rounded-md border border-border p-2 text-sm">
                      <div className="flex justify-between">
                        <span className="font-medium">{d.customer_name ?? '—'}</span>
                        <span className="tabular-nums text-status-warning">-{formatMoney(d.discount_amount)}</span>
                      </div>
                      <p className="text-xs text-text-secondary">
                        <bdi>{d.invoice_number ?? '—'}</bdi> — طبّقه {d.applied_by} — {new Date(d.created_at).toLocaleDateString('ar-EG')}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">المستردات</p>
                {data.refunds.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadCsv(
                        `refunds-${startDate}-${endDate}.csv`,
                        rowsToCsv(
                          data.refunds.map((r) => ({
                            customer_name: r.customer_name,
                            amount: r.amount,
                            reason: r.reason ?? '—',
                            refunded_by: r.refunded_by,
                            refunded_at: r.refunded_at,
                          })),
                          { customer_name: 'العميل', amount: 'المبلغ', reason: 'السبب', refunded_by: 'استرجعه', refunded_at: 'التاريخ' },
                        ),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    تصدير CSV
                  </Button>
                )}
              </div>
              {data.refunds.length === 0 ? (
                <p className="text-sm text-text-secondary">لا توجد مستردات في هذه الفترة</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.refunds.map((r) => (
                    <li key={r.refund_id} className="rounded-md border border-border p-2 text-sm">
                      <div className="flex justify-between">
                        <span className="font-medium">{r.customer_name}</span>
                        <span className="tabular-nums text-status-danger">-{formatMoney(r.amount)}</span>
                      </div>
                      <p className="text-xs text-text-secondary">
                        {r.reason ?? 'بدون سبب مسجّل'} — استرجعه {r.refunded_by} — {new Date(r.refunded_at).toLocaleDateString('ar-EG')}
                      </p>
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
