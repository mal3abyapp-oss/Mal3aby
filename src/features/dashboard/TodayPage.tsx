import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/domain/billing'
import { FirstRunChecklist } from '@/features/dashboard/FirstRunChecklist'
import { AttentionNeeded } from '@/features/dashboard/AttentionNeeded'
import { CoachTodayView } from '@/features/academy/CoachTodayView'
import { BOOKING_STATUS_LABELS } from '@/lib/domain/booking'
import { CalendarDays, CheckCircle2, Landmark, Wallet, CalendarPlus, ScanLine, UserPlus, GraduationCap } from 'lucide-react'

// Today / Ops Center -- three role-driven variants per Section D:
// D1 Reception (NOW/NEXT + quick actions + attention needed), D2
// Manager (operations + money + academy risk + attention needed), D3
// Coach (delegates entirely to CoachTodayView -- sessions/attendance
// only, no management clutter). Single RPC call for the shared
// operational counters, plus targeted queries for manager-only academy
// risk metrics and the shared AttentionNeeded panel.
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

interface AcademyRisk {
  activeSubscriptions: number
  expiringSoon: number
  unpaid: number
  sessionsToday: number
  newCustomersToday: number
}

async function fetchDashboard(clubId: string): Promise<DashboardData> {
  const { data, error } = await supabase.rpc('get_today_dashboard', { p_club_id: clubId })
  if (error) throw error
  return data as unknown as DashboardData
}

async function fetchAcademyRisk(clubId: string): Promise<AcademyRisk> {
  const today = new Date().toISOString().slice(0, 10)
  const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const [active, expiring, unpaid, sessions, newCustomers] = await Promise.all([
    supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('club_id', clubId).eq('status', 'active'),
    supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('club_id', clubId).eq('status', 'active').gte('end_date', today).lte('end_date', in3Days),
    supabase.from('subscriptions').select('id', { count: 'exact', head: true }).eq('club_id', clubId).eq('status', 'pending'),
    supabase.from('training_sessions').select('id', { count: 'exact', head: true }).eq('club_id', clubId).eq('session_date', today),
    supabase.from('customers').select('id', { count: 'exact', head: true }).eq('club_id', clubId).gte('created_at', `${today}T00:00:00`),
  ])
  return {
    activeSubscriptions: active.count ?? 0,
    expiringSoon: expiring.count ?? 0,
    unpaid: unpaid.count ?? 0,
    sessionsToday: sessions.count ?? 0,
    newCustomersToday: newCustomers.count ?? 0,
  }
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

function QuickActionButtons({ isManager }: { isManager: boolean }) {
  const navigate = useNavigate()
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      <Button size="sm" onClick={() => navigate('/app/bookings')}>
        <CalendarPlus className="size-4" /> حجز جديد
      </Button>
      <Button size="sm" variant="outline" onClick={() => navigate('/app/billing')}>
        <Wallet className="size-4" /> تحصيل دفعة
      </Button>
      <Button size="sm" variant="outline" onClick={() => navigate('/scan')}>
        <ScanLine className="size-4" /> مسح QR
      </Button>
      <Button size="sm" variant="outline" onClick={() => navigate('/app/customers')}>
        <UserPlus className="size-4" /> إضافة عميل
      </Button>
      {isManager && (
        <Button size="sm" variant="outline" onClick={() => navigate('/app/academy')}>
          <GraduationCap className="size-4" /> الأكاديمية
        </Button>
      )}
    </div>
  )
}

export function TodayPage() {
  const { currentClubId, currentMembership } = useAuth()
  const roleKey = currentMembership?.roleKey

  const isManager = roleKey === 'club_owner' || roleKey === 'club_manager' || roleKey === 'branch_manager'
  const isReception = roleKey === 'receptionist'
  const isCoach = roleKey === 'coach'

  const { data, isLoading } = useQuery({
    queryKey: ['today-dashboard', currentClubId],
    queryFn: () => fetchDashboard(currentClubId!),
    enabled: !!currentClubId && !isCoach,
    refetchInterval: 60_000,
  })

  const { data: academyRisk } = useQuery({
    queryKey: ['academy-risk', currentClubId],
    queryFn: () => fetchAcademyRisk(currentClubId!),
    enabled: !!currentClubId && isManager,
  })

  // D3 Coach: sessions/attendance only, no management clutter -- delegate entirely.
  if (isCoach) {
    return <CoachTodayView />
  }

  return (
    <div>
      <PageHeader title="اليوم" />
      <FirstRunChecklist />

      {(isManager || isReception) && <QuickActionButtons isManager={isManager} />}

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

      {isManager && academyRisk && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard label="اشتراكات نشطة" value={academyRisk.activeSubscriptions} icon={GraduationCap} />
          <StatCard label="على وشك الانتهاء" value={academyRisk.expiringSoon} tone={academyRisk.expiringSoon > 0 ? 'warning' : 'default'} />
          <StatCard label="اشتراكات غير مدفوعة" value={academyRisk.unpaid} tone={academyRisk.unpaid > 0 ? 'danger' : 'default'} />
          <StatCard label="حصص اليوم" value={academyRisk.sessionsToday} />
          <StatCard label="عملاء جدد اليوم" value={academyRisk.newCustomersToday} tone="success" />
        </div>
      )}

      {(isManager || isReception) && (
        <div className="mb-6">
          <AttentionNeeded />
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
