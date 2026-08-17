import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { StatCard } from '@/components/ui/stat-card'
import { formatMoney, PAYMENT_METHOD_LABELS } from '@/lib/domain/billing'
import { rowsToCsv, downloadCsv } from '@/lib/csv'
import { translateSupabaseError } from '@/lib/errors'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Wallet, Landmark, GraduationCap, Users, Download, LayoutDashboard, CalendarCheck2, HandCoins, ReceiptText, Banknote } from 'lucide-react'

// V1 Implementation Gap Audit (2026-08-16): docs/IMPLEMENTATION_PLAN.md's
// Phase 7 scope was explicit -- "CSV export on this [Outstanding] AND
// OTHER APPLICABLE REPORTS" -- but only OutstandingPage ever got one.
// Added export buttons to each report tab's tabular data.

// Reports Hub -- revenue, field occupancy, academy, customer activity.
// Desktop-first (Manager/Owner/Accountant/Academy Manager), per
// SCREEN_MAP.md. Filters: date range (all reports), branch + payment
// method (revenue), field (occupancy).
interface ExecutiveDashboard {
  total_revenue: number
  refunds_total: number
  outstanding_total: number
  bookings_count: number
  bookings_cancelled_count: number
  total_booked_hours: number
  active_enrollments: number
  new_customers: number
  revenue_by_day: { date: string; revenue: number }[]
}

interface BookingReport {
  by_status: { status: string; count: number }[]
  by_branch: { branch_id: string; branch_name: string; booking_count: number }[]
  cancellation_rate: number | null
  average_booking_value: number | null
}

interface RevenueReport {
  total_revenue: number
  by_day: { date: string; revenue: number }[]
  by_method: { method: string; revenue: number }[]
  refunds_total: number
}

interface OccupancyReport {
  by_field: { field_id: string; field_name: string; booked_hours: number; booking_count: number }[]
}

interface AcademyReport {
  active_enrollments: number
  attendance_rate: number | null
  by_group: { group_id: string; group_name: string; active_enrollments: number; capacity: number }[]
  expiring_subscriptions: { subscription_id: string; player_name: string; effective_end_date: string }[]
}

interface CustomerReport {
  new_customers: number
  top_customers: { customer_id: string; customer_name: string; total_spend: number; booking_count: number }[]
}

interface CollectionsReport {
  total_collected: number
  by_employee: { user_id: string | null; full_name: string; amount: number; payment_count: number }[]
  by_branch: { branch_id: string; branch_name: string; amount: number; payment_count: number }[]
}

interface PaymentMethodReport {
  total_collected: number
  total_refunded: number
  by_method: {
    method: string
    collected: number
    collected_count: number
    refunded: number
    refunded_count: number
    net: number
  }[]
}

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

function useDateRange() {
  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return d.toISOString().slice(0, 10)
  })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  return { startDate, setStartDate, endDate, setEndDate }
}

function DateRangeFilter({ startDate, endDate, onStart, onEnd }: { startDate: string; endDate: string; onStart: (v: string) => void; onEnd: (v: string) => void }) {
  return (
    <div className="mb-4 flex gap-2">
      <Input type="date" value={startDate} onChange={(e) => onStart(e.target.value)} />
      <Input type="date" value={endDate} onChange={(e) => onEnd(e.target.value)} />
    </div>
  )
}

const BOOKING_STATUS_LABELS: Record<string, string> = {
  pending_payment: 'بانتظار الدفع',
  confirmed: 'مؤكد',
  checked_in: 'تم تسجيل الحضور',
  completed: 'مكتمل',
  cancelled: 'ملغي',
  no_show: 'لم يحضر',
}

function ExecutiveDashboardTab() {
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data, isLoading } = useQuery({
    queryKey: ['executive-dashboard', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_executive_dashboard', {
        p_club_id: currentClubId!,
        p_start_date: startDate,
        p_end_date: endDate,
      })
      if (error) throw error
      return data as unknown as ExecutiveDashboard
    },
    enabled: !!currentClubId,
  })

  return (
    <div>
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatCard label="إجمالي الإيرادات" value={formatMoney(data.total_revenue)} icon={Wallet} />
            <StatCard label="المستحقات الحالية" value={formatMoney(data.outstanding_total)} tone={data.outstanding_total > 0 ? 'warning' : undefined} />
            <StatCard label="المستردات" value={formatMoney(data.refunds_total)} tone="danger" />
            <StatCard label="حجوزات مؤكدة" value={data.bookings_count} icon={CalendarCheck2} />
            <StatCard label="حجوزات ملغاة" value={data.bookings_cancelled_count} />
            <StatCard label="ساعات محجوزة" value={data.total_booked_hours} />
            <StatCard label="تسجيلات نشطة بالأكاديمية" value={data.active_enrollments} icon={GraduationCap} />
            <StatCard label="عملاء جدد" value={data.new_customers} icon={Users} />
          </div>
          <div className="mb-2 flex items-center justify-between">
            <p className="font-medium">الإيرادات حسب اليوم</p>
            {data.revenue_by_day.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadCsv(
                    `executive-dashboard-${startDate}-${endDate}.csv`,
                    rowsToCsv(data.revenue_by_day, { date: 'التاريخ', revenue: 'الإيرادات' }),
                  )
                }
              >
                <Download className="me-1 size-4" />
                تصدير CSV
              </Button>
            )}
          </div>
          {data.revenue_by_day.length === 0 ? (
            <p className="text-sm text-text-secondary">لا توجد بيانات</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {data.revenue_by_day.map((d) => (
                <li key={d.date} className="flex justify-between rounded-md border border-border p-2 text-sm">
                  <span className="tabular-nums">{d.date}</span>
                  <span>{formatMoney(d.revenue)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  )
}

function BookingReportTab() {
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data, isLoading } = useQuery({
    queryKey: ['booking-report', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_booking_report', {
        p_club_id: currentClubId!,
        p_start_date: startDate,
        p_end_date: endDate,
      })
      if (error) throw error
      return data as unknown as BookingReport
    },
    enabled: !!currentClubId,
  })

  return (
    <div>
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
            <StatCard
              label="نسبة الإلغاء"
              value={data.cancellation_rate !== null ? `${data.cancellation_rate}%` : '—'}
              tone={data.cancellation_rate !== null && data.cancellation_rate > 15 ? 'danger' : undefined}
            />
            <StatCard label="متوسط قيمة الحجز" value={data.average_booking_value !== null ? formatMoney(data.average_booking_value) : '—'} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium">حسب الحالة</p>
                {data.by_status.length > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      downloadCsv(
                        `bookings-by-status-${startDate}-${endDate}.csv`,
                        rowsToCsv(
                          data.by_status.map((s) => ({ status: BOOKING_STATUS_LABELS[s.status] ?? s.status, count: s.count })),
                          { status: 'الحالة', count: 'العدد' },
                        ),
                      )
                    }
                  >
                    <Download className="me-1 size-4" />
                    تصدير CSV
                  </Button>
                )}
              </div>
              {data.by_status.length === 0 ? (
                <p className="text-sm text-text-secondary">لا توجد بيانات</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_status.map((s) => (
                    <li key={s.status} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{BOOKING_STATUS_LABELS[s.status] ?? s.status}</span>
                      <span className="tabular-nums">{s.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-2 font-medium">حسب الفرع</p>
              {data.by_branch.length === 0 ? (
                <p className="text-sm text-text-secondary">لا توجد فروع</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_branch.map((b) => (
                    <li key={b.branch_id} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{b.branch_name}</span>
                      <span className="tabular-nums">{b.booking_count} حجز</span>
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

function RevenueReportTab() {
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const [method, setMethod] = useState<string>('all')

  const { data, isLoading } = useQuery({
    queryKey: ['revenue-report', currentClubId, startDate, endDate, method],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_revenue_report', {
        p_club_id: currentClubId!,
        p_start_date: startDate,
        p_end_date: endDate,
        ...(method !== 'all' ? { p_method: method } : {}),
      })
      if (error) throw error
      return data as unknown as RevenueReport
    },
    enabled: !!currentClubId,
  })

  return (
    <div>
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

// Gate 13 #58: the natural follow-on to #57's attribution audit -- once
// received_by is confirmed trustworthy, this is "how much did each staff
// member collect, and how much did each branch collect" over a range.
function CollectionsReportTab() {
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data, isLoading } = useQuery({
    queryKey: ['collections-report', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_collections_report', {
        p_club_id: currentClubId!,
        p_start_date: startDate,
        p_end_date: endDate,
      })
      if (error) throw error
      return data as unknown as CollectionsReport
    },
    enabled: !!currentClubId,
  })

  return (
    <div>
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

// Master Payment Directive task #87: get_collections_report() (#58,
// above) breaks collections down by employee and branch but never by
// payment METHOD -- the actual reconciliation dimension a manager
// needs at day/period close (how much cash should be physically on
// hand vs. what the card terminal batch should show vs. what hit the
// bank account). Nets refunds against the method they were originally
// collected under, so each channel can be reconciled independently
// rather than only seeing one blended total.
// task #87: manual reconciliation confirmation, layered on top of the
// (collected/refunded/net)-per-method report above. Reuses
// confirm_payment_reconciliation() (task #87's own migration), which
// computes reconciled_total server-side from the real payments/refunds
// data for the exact method+period -- never trusts a client-supplied
// number. A staff member checks the recorded total against their bank
// statement/POS batch report, then confirms; the confirmation itself
// (who, when, what total, optional note) is the audit record, not a
// recomputation of anything already shown above.
interface ReconciliationRecord {
  id: string
  method: string
  period_start: string
  period_end: string
  reconciled_total: number
  note: string | null
  reconciled_at: string
}

async function fetchReconciliations(clubId: string, startDate: string, endDate: string): Promise<ReconciliationRecord[]> {
  const { data, error } = await supabase
    .from('payment_reconciliations')
    .select('id, method, period_start, period_end, reconciled_total, note, reconciled_at')
    .eq('club_id', clubId)
    .gte('period_start', startDate)
    .lte('period_end', endDate)
    .order('reconciled_at', { ascending: false })
  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id,
    method: r.method,
    period_start: r.period_start,
    period_end: r.period_end,
    reconciled_total: Number(r.reconciled_total),
    note: r.note,
    reconciled_at: r.reconciled_at,
  }))
}

function PaymentMethodReportTab() {
  const { currentClubId } = useAuth()
  const queryClient = useQueryClient()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()
  const [reconcileError, setReconcileError] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['payment-method-report', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_payment_method_report', {
        p_club_id: currentClubId!,
        p_start_date: startDate,
        p_end_date: endDate,
      })
      if (error) throw error
      return data as unknown as PaymentMethodReport
    },
    enabled: !!currentClubId,
  })

  const { data: reconciliations = [] } = useQuery({
    queryKey: ['payment-reconciliations', currentClubId, startDate, endDate],
    queryFn: () => fetchReconciliations(currentClubId!, startDate, endDate),
    enabled: !!currentClubId,
  })
  const reconciledMethods = new Set(reconciliations.map((r) => r.method))

  const confirmMutation = useMutation({
    mutationFn: async (method: string) => {
      const { error } = await supabase.rpc('confirm_payment_reconciliation', {
        p_club_id: currentClubId!,
        p_method: method,
        p_period_start: startDate,
        p_period_end: endDate,
      })
      if (error) throw error
    },
    onSuccess: () => {
      setReconcileError(null)
      void queryClient.invalidateQueries({ queryKey: ['payment-reconciliations', currentClubId] })
    },
    onError: (error) => setReconcileError(translateSupabaseError(error, 'تعذّر تأكيد التسوية.')),
  })

  return (
    <div>
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {data && (
        <>
          <div className="mb-6 grid gap-4 sm:grid-cols-3">
            <StatCard label="إجمالي التحصيلات" value={formatMoney(data.total_collected)} icon={Banknote} />
            <StatCard label="إجمالي المستردات" value={formatMoney(data.total_refunded)} tone="danger" />
            <StatCard label="الصافي" value={formatMoney(data.total_collected - data.total_refunded)} />
          </div>
          <div className="mb-2 flex items-center justify-between">
            <p className="font-medium">التسوية حسب طريقة الدفع</p>
            {data.by_method.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadCsv(
                    `payment-method-reconciliation-${startDate}-${endDate}.csv`,
                    rowsToCsv(
                      data.by_method.map((m) => ({
                        method: PAYMENT_METHOD_LABELS[m.method] ?? m.method,
                        collected: m.collected,
                        collected_count: m.collected_count,
                        refunded: m.refunded,
                        refunded_count: m.refunded_count,
                        net: m.net,
                      })),
                      {
                        method: 'طريقة الدفع',
                        collected: 'التحصيل',
                        collected_count: 'عدد الدفعات',
                        refunded: 'المسترد',
                        refunded_count: 'عدد المستردات',
                        net: 'الصافي',
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
          {reconcileError && <p className="mb-2 text-sm text-status-danger">{reconcileError}</p>}
          {data.by_method.length === 0 ? (
            <p className="text-sm text-text-secondary">لا توجد بيانات</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-start text-sm">
                <thead>
                  <tr className="border-b border-border text-text-secondary">
                    <th className="p-2 text-start">طريقة الدفع</th>
                    <th className="p-2 text-start">التحصيل</th>
                    <th className="p-2 text-start">المسترد</th>
                    <th className="p-2 text-start">الصافي</th>
                    <th className="p-2 text-start">التسوية اليدوية</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_method.map((m) => (
                    <tr key={m.method} className="border-b border-border">
                      <td className="p-2 font-medium">{PAYMENT_METHOD_LABELS[m.method] ?? m.method}</td>
                      <td className="p-2">{formatMoney(m.collected)} — {m.collected_count} دفعة</td>
                      <td className="p-2 text-status-danger">
                        {m.refunded > 0 ? `${formatMoney(m.refunded)} — ${m.refunded_count} استرداد` : '—'}
                      </td>
                      <td className="p-2 font-medium">{formatMoney(m.net)}</td>
                      <td className="p-2">
                        {reconciledMethods.has(m.method) ? (
                          <span className="text-status-success">تمت التسوية ✓</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={confirmMutation.isPending}
                            onClick={() => confirmMutation.mutate(m.method)}
                          >
                            تأكيد التسوية
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {reconciliations.length > 0 && (
            <div className="mt-6">
              <p className="mb-2 font-medium">سجل التسويات</p>
              <ul className="flex flex-col gap-1">
                {reconciliations.map((r) => (
                  <li key={r.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                    <span>
                      {PAYMENT_METHOD_LABELS[r.method] ?? r.method} — {formatMoney(r.reconciled_total)}
                      {r.note && <span className="text-text-secondary"> — {r.note}</span>}
                    </span>
                    <span className="text-xs text-text-secondary">
                      {new Date(r.reconciled_at).toLocaleString('ar-EG')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  )
}

// Gate 13 #59: financial exception transparency -- an itemized "who, how
// much, on what, when" list for discounts and refunds, not just the
// aggregate refunds_total number that already existed on other tabs.
function FinancialExceptionsReportTab() {
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data, isLoading } = useQuery({
    queryKey: ['financial-exceptions-report', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_financial_exceptions_report', {
        p_club_id: currentClubId!,
        p_start_date: startDate,
        p_end_date: endDate,
      })
      if (error) throw error
      return data as unknown as FinancialExceptionsReport
    },
    enabled: !!currentClubId,
  })

  return (
    <div>
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
                        {d.invoice_number ?? '—'} — طبّقه {d.applied_by} — {new Date(d.created_at).toLocaleDateString('ar-EG')}
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

function OccupancyReportTab() {
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data, isLoading } = useQuery({
    queryKey: ['occupancy-report', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_field_occupancy_report', {
        p_club_id: currentClubId!,
        p_start_date: startDate,
        p_end_date: endDate,
      })
      if (error) throw error
      return data as unknown as OccupancyReport
    },
    enabled: !!currentClubId,
  })

  return (
    <div>
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {data && (
        data.by_field.length === 0 ? (
          <p className="text-sm text-text-secondary">لا توجد ملاعب</p>
        ) : (
          <>
            <div className="mb-2 flex justify-end">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  downloadCsv(
                    `occupancy-${startDate}-${endDate}.csv`,
                    rowsToCsv(data.by_field, { field_name: 'الملعب', booked_hours: 'ساعات محجوزة', booking_count: 'عدد الحجوزات' }),
                  )
                }
              >
                <Download className="me-1 size-4" />
                تصدير CSV
              </Button>
            </div>
            <ul className="flex flex-col gap-2">
              {data.by_field.map((f) => (
                <li key={f.field_id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                  <span className="font-medium">{f.field_name}</span>
                  <span className="text-text-secondary">{f.booked_hours} ساعة — {f.booking_count} حجز</span>
                </li>
              ))}
            </ul>
          </>
        )
      )}
    </div>
  )
}

function AcademyReportTab() {
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data, isLoading } = useQuery({
    queryKey: ['academy-report', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_academy_report', {
        p_club_id: currentClubId!,
        p_start_date: startDate,
        p_end_date: endDate,
      })
      if (error) throw error
      return data as unknown as AcademyReport
    },
    enabled: !!currentClubId,
  })

  return (
    <div>
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {data && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3">
            <StatCard label="التسجيلات النشطة" value={data.active_enrollments} icon={GraduationCap} />
            <StatCard label="نسبة الحضور" value={data.attendance_rate !== null ? `${data.attendance_rate}%` : '—'} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <p className="mb-2 font-medium">حسب المجموعة</p>
              {data.by_group.length === 0 ? (
                <p className="text-sm text-text-secondary">لا توجد مجموعات</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.by_group.map((g) => (
                    <li key={g.group_id} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{g.group_name}</span>
                      <span className="tabular-nums"><bdi>{g.active_enrollments} / {g.capacity}</bdi></span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-2 font-medium">اشتراكات تنتهي قريبًا</p>
              {data.expiring_subscriptions.length === 0 ? (
                <p className="text-sm text-text-secondary">لا توجد</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.expiring_subscriptions.map((s) => (
                    <li key={s.subscription_id} className="flex justify-between rounded-md border border-border p-2 text-sm">
                      <span>{s.player_name}</span>
                      <span className="tabular-nums text-status-warning">{s.effective_end_date}</span>
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

function CustomerReportTab() {
  const { currentClubId } = useAuth()
  const { startDate, setStartDate, endDate, setEndDate } = useDateRange()

  const { data, isLoading } = useQuery({
    queryKey: ['customer-report', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_customer_activity_report', {
        p_club_id: currentClubId!,
        p_start_date: startDate,
        p_end_date: endDate,
      })
      if (error) throw error
      return data as unknown as CustomerReport
    },
    enabled: !!currentClubId,
  })

  return (
    <div>
      <DateRangeFilter startDate={startDate} endDate={endDate} onStart={setStartDate} onEnd={setEndDate} />
      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {data && (
        <>
          <div className="mb-6">
            <StatCard label="عملاء جدد" value={data.new_customers} icon={Users} />
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
                <li key={c.customer_id} className="flex justify-between rounded-md border border-border p-2 text-sm">
                  <span>{c.customer_name}</span>
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

// IA restructuring (Phase 7): 9 flat, undifferentiated tabs was one of
// the audit's confirmed crowding symptoms -- no visual indication that
// "الإيرادات" and "تسوية طرق الدفع" are both financial reports while
// "الأكاديمية" is a completely different concern. Per the target IA's
// Phase 2 design decision (see MAL3ABY_IA_RESTRUCTURE_STATE.md's Phase
// 2 log): reports share one genuine purpose (retrospective analysis),
// so the crowding is a PRESENTATION problem, not a domain-mixing one --
// fixed with labeled groups, not a route split. Each group renders as
// its own bordered TabsList cluster with a caption above it; Radix
// Tabs' single flat trigger list doesn't support inline group labels
// as non-trigger children, so grouping is expressed via layout instead
// (wrapping clusters + a caption row), keeping all 9 triggers as
// siblings of one Tabs.Root (single active-tab state, no behavior
// change).
const TAB_GROUPS: {
  titleKey: string
  tabs: { value: string; label: string; icon: typeof LayoutDashboard }[]
}[] = [
  {
    titleKey: 'overview',
    tabs: [{ value: 'dashboard', label: 'نظرة عامة', icon: LayoutDashboard }],
  },
  {
    titleKey: 'operations',
    tabs: [
      { value: 'bookings', label: 'الحجوزات', icon: CalendarCheck2 },
      { value: 'occupancy', label: 'إشغال الملاعب', icon: Landmark },
    ],
  },
  {
    titleKey: 'finance',
    tabs: [
      { value: 'revenue', label: 'الإيرادات', icon: Wallet },
      { value: 'collections', label: 'التحصيلات', icon: HandCoins },
      { value: 'payment-methods', label: 'تسوية طرق الدفع', icon: Banknote },
      { value: 'exceptions', label: 'الاستثناءات المالية', icon: ReceiptText },
    ],
  },
  {
    titleKey: 'academyCustomers',
    tabs: [
      { value: 'academy', label: 'الأكاديمية', icon: GraduationCap },
      { value: 'customers', label: 'العملاء', icon: Users },
    ],
  },
]

const GROUP_TITLES: Record<string, string> = {
  overview: 'نظرة عامة',
  operations: 'التشغيل',
  finance: 'المالية',
  academyCustomers: 'الأكاديمية والعملاء',
}

export function ReportsPage() {
  return (
    <div>
      <PageHeader title="التقارير" description="تقارير الإيرادات والتحصيلات والاستثناءات المالية والملاعب والأكاديمية والعملاء" />
      <Tabs defaultValue="dashboard">
        <div className="mb-4 flex flex-wrap gap-4">
          {TAB_GROUPS.map((group) => (
            <div key={group.titleKey} className="flex flex-col gap-1">
              <p className="px-1 text-xs font-medium text-text-secondary">{GROUP_TITLES[group.titleKey]}</p>
              <TabsList>
                {group.tabs.map((tab) => (
                  <TabsTrigger key={tab.value} value={tab.value}>
                    <tab.icon className="me-1 size-4" />
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          ))}
        </div>
        <TabsContent value="dashboard"><ExecutiveDashboardTab /></TabsContent>
        <TabsContent value="revenue"><RevenueReportTab /></TabsContent>
        <TabsContent value="collections"><CollectionsReportTab /></TabsContent>
        <TabsContent value="payment-methods"><PaymentMethodReportTab /></TabsContent>
        <TabsContent value="bookings"><BookingReportTab /></TabsContent>
        <TabsContent value="exceptions"><FinancialExceptionsReportTab /></TabsContent>
        <TabsContent value="occupancy"><OccupancyReportTab /></TabsContent>
        <TabsContent value="academy"><AcademyReportTab /></TabsContent>
        <TabsContent value="customers"><CustomerReportTab /></TabsContent>
      </Tabs>
    </div>
  )
}
