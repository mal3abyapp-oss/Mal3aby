import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { Input } from '@/components/ui/input'
import { StatCard } from '@/components/ui/stat-card'
import { formatMoney } from '@/lib/domain/billing'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Wallet, Landmark, GraduationCap, Users } from 'lucide-react'

// Reports Hub -- revenue, field occupancy, academy, customer activity.
// Desktop-first (Manager/Owner/Accountant/Academy Manager), per
// SCREEN_MAP.md. Filters: date range (all reports), branch + payment
// method (revenue), field (occupancy).
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
                      <span>{m.method}</span>
                      <span>{formatMoney(m.revenue)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-2 font-medium">حسب اليوم</p>
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
          <ul className="flex flex-col gap-2">
            {data.by_field.map((f) => (
              <li key={f.field_id} className="flex items-center justify-between rounded-md border border-border p-3 text-sm">
                <span className="font-medium">{f.field_name}</span>
                <span className="text-text-secondary">{f.booked_hours} ساعة — {f.booking_count} حجز</span>
              </li>
            ))}
          </ul>
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
                      <span className="tabular-nums">{g.active_enrollments} / {g.capacity}</span>
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
          <p className="mb-2 font-medium">أعلى العملاء إنفاقًا</p>
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

export function ReportsPage() {
  return (
    <div>
      <PageHeader title="التقارير" description="تقارير الإيرادات والملاعب والأكاديمية والعملاء" />
      <Tabs defaultValue="revenue">
        <TabsList>
          <TabsTrigger value="revenue">
            <Wallet className="me-1 size-4" />
            الإيرادات
          </TabsTrigger>
          <TabsTrigger value="occupancy">
            <Landmark className="me-1 size-4" />
            إشغال الملاعب
          </TabsTrigger>
          <TabsTrigger value="academy">
            <GraduationCap className="me-1 size-4" />
            الأكاديمية
          </TabsTrigger>
          <TabsTrigger value="customers">
            <Users className="me-1 size-4" />
            العملاء
          </TabsTrigger>
        </TabsList>
        <TabsContent value="revenue"><RevenueReportTab /></TabsContent>
        <TabsContent value="occupancy"><OccupancyReportTab /></TabsContent>
        <TabsContent value="academy"><AcademyReportTab /></TabsContent>
        <TabsContent value="customers"><CustomerReportTab /></TabsContent>
      </Tabs>
    </div>
  )
}
