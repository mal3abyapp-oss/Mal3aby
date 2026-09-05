import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { PageHeader } from '@/components/ui/page-header'
import { StatCard } from '@/components/ui/stat-card'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from '@/components/ui/status-badge'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/domain/billing'
import { useDirection } from '@/app/providers/DirectionProvider'
import { FirstRunChecklist } from '@/features/dashboard/FirstRunChecklist'
import { AttentionNeeded } from '@/features/dashboard/AttentionNeeded'
import { OwnerFinanceTransparency } from '@/features/dashboard/OwnerFinanceTransparency'
import { CoachTodayView } from '@/features/academy/CoachTodayView'
import { BOOKING_STATUS_LABELS } from '@/lib/domain/booking'
import { CalendarDays, CheckCircle2, Landmark, Wallet, CalendarPlus, ScanLine, UserPlus, GraduationCap } from 'lucide-react'
import { DASHBOARD_POLL_INTERVAL_MS } from '@/lib/query/dashboardPolling'

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

// Master IA/UX audit (Club Side TodayPage phase): every NOW/NEXT row
// and every StatCard on this "operational command center" screen was a
// dead-end -- a manager glancing at "حجوزات اليوم: 12" or a NOW row had
// no way to reach the actual booking without leaving to search
// BookingsPage manually. Rows now navigate to /app/bookings (the
// bookings list, not a specific booking sheet -- BookingDetailSheet
// opens from a full BookingRow object in BookingsPage's own state, not
// a route/id, so a true per-booking deep-link isn't available without
// new routing infra).
function BookingListCard({ title, bookings }: { title: string; bookings: DashboardData['now_bookings'] }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { locale } = useDirection()
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {bookings.length === 0 ? (
          <p className="text-sm text-text-secondary">{t('common.noData')}</p>
        ) : (
          bookings.map((b) => (
            <button
              key={b.id}
              onClick={() => navigate('/app/bookings')}
              className="flex items-center justify-between rounded-md border border-border p-2 text-start text-sm hover:bg-muted/40"
            >
              <div>
                <p className="font-medium">{b.field_name}</p>
                <p className="text-text-secondary">{b.customer_name}</p>
              </div>
              <div className="text-end">
                <p className="tabular-nums text-text-secondary">
                  {new Date(b.start_at).toLocaleTimeString(locale === 'en' ? 'en-US' : 'ar-EG', { hour: '2-digit', minute: '2-digit' })}
                </p>
                <StatusBadge
                  tone={b.status === 'confirmed' || b.status === 'checked_in' ? 'success' : 'warning'}
                  label={t(`bookings.statusLabels.${b.status}`, { defaultValue: BOOKING_STATUS_LABELS[b.status] ?? b.status })}
                />
              </div>
            </button>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function QuickActionButtons({ isManager }: { isManager: boolean }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      <Button size="sm" onClick={() => navigate('/app/bookings')}>
        <CalendarPlus className="size-4" /> {t('dashboard.today.newBooking')}
      </Button>
      <Button size="sm" variant="outline" onClick={() => navigate('/app/billing')}>
        <Wallet className="size-4" /> {t('dashboard.today.collectPayment')}
      </Button>
      <Button size="sm" variant="outline" onClick={() => navigate('/scan')}>
        <ScanLine className="size-4" /> {t('dashboard.today.scanQr')}
      </Button>
      <Button size="sm" variant="outline" onClick={() => navigate('/app/customers')}>
        <UserPlus className="size-4" /> {t('dashboard.today.addCustomer')}
      </Button>
      {isManager && (
        <Button size="sm" variant="outline" onClick={() => navigate('/app/academy')}>
          <GraduationCap className="size-4" /> {t('nav.academy')}
        </Button>
      )}
    </div>
  )
}

// STAFF ACCESS CONTROL & CUSTOM ROLES fix (2026-09-05): this screen used
// to gate every section on roleKey string equality against the 5
// built-in system role names, so a custom role (roleKey is always null
// for those -- see membership.ts) fell through every check and saw a
// near-empty dashboard regardless of its actual permission set --
// exactly the "fail CLOSED, hidden content, not a real permission
// model" bug navigation.ts's own header comment already documents and
// fixes for nav visibility. Fixed the same way: derive visibility from
// ActiveMembership.permissionKeys (real, server-computed via
// caller_permission_keys()) instead of roleKey, so a custom role with
// manager-equivalent permissions sees the manager-equivalent dashboard
// sections. Behavior-preserving for every built-in role -- each
// predicate below was reconstructed from and verified against
// docs/STAFF_PERMISSION_MATRIX.md's live-verified permission rows for
// club_owner/club_manager/branch_manager/receptionist/coach, not
// guessed:
//   - isManager: club_owner ✅ everything; club_manager ✅ via
//     staff.view/staff.create/staff.update/roles.view/roles.manage;
//     branch_manager ✅ via branch.update/field.update (it does NOT
//     hold staff.view -- confirmed live, so staff.* alone would have
//     wrongly excluded it). Reception/accountant/academy-mgr/coach/
//     scanner hold none of these keys.
//   - isOwner: club.update is club_owner-exclusive among the 8 keys
//     above (branch_manager/club_manager both lack it, live-verified).
//   - isReception: booking.view is held by exactly
//     owner/manager/branch_manager/reception and no one else
//     (live-verified) -- reception-equivalent is "has it but isn't
//     already a manager", so a manager-equivalent role isn't
//     double-counted as reception too.
// Reused the same NAV_DOMAIN_PERMISSIONS keys navigation.ts already
// derives (staff/settings/bookings domains) rather than inventing a new
// permission grouping for this screen.
const MANAGER_PERMISSION_KEYS = [
  'staff.view', 'staff.create', 'staff.update', 'roles.view', 'roles.manage',
  'branch.update', 'field.update', 'club.update',
] as const

function hasAnyPermission(permissionKeys: readonly string[] | undefined, keys: readonly string[]): boolean {
  if (!permissionKeys || permissionKeys.length === 0) return false
  return keys.some((key) => permissionKeys.includes(key))
}

export function TodayPage() {
  const { t } = useTranslation()
  const { currentClubId, currentMembership } = useAuth()
  const { locale } = useDirection()
  const roleKey = currentMembership?.roleKey
  const permissionKeys = currentMembership?.permissionKeys

  const isManager = hasAnyPermission(permissionKeys, MANAGER_PERMISSION_KEYS)
  const isOwner = hasAnyPermission(permissionKeys, ['club.update'])
  const isReception = !isManager && hasAnyPermission(permissionKeys, ['booking.view'])
  // Coach delegation stays roleKey-gated: CoachTodayView is a
  // coach-specific UI (sessions/attendance only), a materially
  // different component to route into, not a section-visibility toggle
  // on this screen -- out of this fix's scope (a custom role with
  // coach-equivalent permissions still gets the sections above it
  // qualifies for, same as before this fix, since it never matched
  // roleKey === 'coach' either).
  const isCoach = roleKey === 'coach'

  const { data, isLoading } = useQuery({
    queryKey: ['today-dashboard', currentClubId],
    queryFn: () => fetchDashboard(currentClubId!),
    enabled: !!currentClubId && !isCoach,
    // PERF-04: shared with AttentionNeeded/OwnerFinanceTransparency so
    // the three same-screen loops share one source of truth for cadence.
    refetchInterval: DASHBOARD_POLL_INTERVAL_MS,
    staleTime: DASHBOARD_POLL_INTERVAL_MS,
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
      <PageHeader title={t('nav.today')} />
      <FirstRunChecklist />

      {(isManager || isReception) && <QuickActionButtons isManager={isManager} />}

      {isLoading && <p className="text-sm text-text-secondary">{t('common.loading')}</p>}

      {data && (isManager || isReception) && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label={t('dashboard.today.bookingsToday')} value={data.bookings_today_count} icon={CalendarDays} to="/app/bookings" />
          <StatCard label={t('dashboard.today.checkedIn')} value={data.checked_in_count} icon={CheckCircle2} tone="success" to="/app/bookings" />
          <StatCard
            label={t('dashboard.today.fieldsOccupiedNow')}
            value={`${data.fields_occupied_now_count} / ${data.fields_active_count}`}
            icon={Landmark}
            to={isManager ? '/app/fields' : undefined}
          />
          {isManager && (
            <StatCard label={t('dashboard.today.revenueToday')} value={formatMoney(data.revenue_today, 'EGP', locale)} icon={Wallet} to="/app/billing" />
          )}
        </div>
      )}

      {data && isManager && data.outstanding_total > 0 && (
        <div className="mb-6">
          <StatCard label={t('dashboard.today.totalOutstanding')} value={formatMoney(data.outstanding_total, 'EGP', locale)} tone="danger" to="/app/outstanding" />
        </div>
      )}

      {/* Master IA/UX audit: "على وشك الانتهاء" (expiring-soon count)
          duplicated the exact same 3-day-window signal AttentionNeeded
          already itemizes per-player with a direct link -- a manager
          scanning this screen saw the same underlying risk represented
          twice, once as a bare unclickable count, once as real
          actionable rows. Dropped the redundant count card; the
          itemized version in AttentionNeeded below is the real one.
          The remaining 4 cards are informational counts (not
          "needs a decision today" items) but still get drill-down
          links since they're clickable now rather than dead numbers. */}
      {isManager && academyRisk && (
        <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatCard label={t('dashboard.today.activeSubscriptions')} value={academyRisk.activeSubscriptions} icon={GraduationCap} to="/app/academy" />
          <StatCard label={t('dashboard.today.unpaidSubscriptions')} value={academyRisk.unpaid} tone={academyRisk.unpaid > 0 ? 'danger' : 'default'} to="/app/academy" />
          <StatCard label={t('dashboard.today.sessionsToday')} value={academyRisk.sessionsToday} to="/app/academy" />
          <StatCard label={t('dashboard.today.newCustomersToday')} value={academyRisk.newCustomersToday} tone="success" to="/app/customers" />
        </div>
      )}

      {(isManager || isReception) && (
        <div className="mb-6">
          <AttentionNeeded />
        </div>
      )}

      {isOwner && (
        <div className="mb-6">
          <OwnerFinanceTransparency />
        </div>
      )}

      {data && (isManager || isReception) && (
        <div className="grid gap-4 md:grid-cols-2">
          <BookingListCard title={t('dashboard.today.now')} bookings={data.now_bookings} />
          <BookingListCard title={t('dashboard.today.next')} bookings={data.next_bookings} />
        </div>
      )}
    </div>
  )
}
