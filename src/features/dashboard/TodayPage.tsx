import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { formatMoney } from '@/lib/domain/billing'
import { FirstRunChecklist } from '@/features/dashboard/FirstRunChecklist'
import { BOOKING_STATUS_LABELS } from '@/lib/domain/booking'
import { CalendarDays, CheckCircle2, Landmark, Wallet } from 'lucide-react'

// Today / Ops Center (Manager, Owner) + Reception Operational View
// (Now/Next), combined into one screen -- role determines which widgets
// render, per SCREEN_MAP.md. Single RPC call, one query pass for every
// widget (get_today_dashboard reads Phase 6-8 data, no new tables).
interface DashboardData {
  bookings_today_count: number
  checked_in_count: number
  fields_active_count: number
  fields_occupied_now_count: number
  revenue_today: number
  outstanding_total: number
  now_bookings: { id: string; field_name: string; customer_name: string; start_at: string; end_at: string; status: string }[]
  next_bookings: { id: string; field_name: string; customer_name: string; start_at: string; end_at: string; status: string }[]
}

async function fetchDashboard(clubId: string): Promise<DashboardData> {
  const { data, error } = await supabase.rpc('get_today_dashboard', { p_club_id: clubId })
  if (error) throw error
  return data as unknown as DashboardData
}

function BookingListCard({ title, bookings }: { title: string; bookings: DashboardData['now_bookings'] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {bookings.length === 0 ? (
          <p className="text-sm text-text-secondary">لا يوجد</p>
        ) : (
          bookings.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
              <div>
                <p className="font-medium">{b.field_name}</p>
                <p className="text-text-secondary">{b.customer_name}</p>
              </div>
              <div className="text-end">
                <p className="tabular-nums text-text-secondary">
                  {new Date(b.start_at).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                </p>
                <StatusBadge
                  tone={b.status === 'confirmed' || b.status === 'checked_in' ? 'success' : 'warning'}
                  label={BOOKING_STATUS_LABELS[b.status] ?? b.status}
                />
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

export function TodayPage() {
  const { currentClubId, currentMembership } = useAuth()
  const roleKey = currentMembership?.roleKey

  const { data, isLoading } = useQuery({
    queryKey: ['today-dashboard', currentClubId],
    queryFn: () => fetchDashboard(currentClubId!),
    enabled: !!currentClubId,
    refetchInterval: 60_000,
  })

  const isManager = roleKey === 'club_owner' || roleKey === 'club_manager' || roleKey === 'branch_manager'
  const isReception = roleKey === 'receptionist'

  return (
    <div>
      <PageHeader title="اليوم" />
      <FirstRunChecklist />

      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}

      {data && (isManager || isReception) && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label="حجوزات اليوم" value={data.bookings_today_count} icon={CalendarDays} />
          <StatCard label="تم تسجيل الحضور" value={data.checked_in_count} icon={CheckCircle2} tone="success" />
          <StatCard
            label="الملاعب المشغولة الآن"
            value={`${data.fields_occupied_now_count} / ${data.fields_active_count}`}
            icon={Landmark}
          />
          {isManager && (
            <StatCard label="إيرادات اليوم" value={formatMoney(data.revenue_today)} icon={Wallet} />
          )}
        </div>
      )}

      {data && isManager && data.outstanding_total > 0 && (
        <div className="mb-6">
          <StatCard label="إجمالي المستحقات" value={formatMoney(data.outstanding_total)} tone="danger" />
        </div>
      )}

      {data && (isManager || isReception) && (
        <div className="grid gap-4 md:grid-cols-2">
          <BookingListCard title="الآن (NOW)" bookings={data.now_bookings} />
          <BookingListCard title="التالي (NEXT)" bookings={data.next_bookings} />
        </div>
      )}
    </div>
  )
}
