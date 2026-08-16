import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { StatusBadge } from '@/components/ui/status-badge'

// Gate 3 — My Academies / My Children: shows every player linked to
// this account as a guardian (via guardian_links), each with their
// current enrollment/subscription status. Read-only, same rationale as
// My Bookings.
interface PortalPlayer {
  id: string
  full_name: string
  photo_url: string | null
  enrollments: {
    id: string
    status: string
    groups: { name: string } | null
    subscriptions: { status: string; end_date: string }[]
  }[]
}

async function fetchMyPlayers(): Promise<PortalPlayer[]> {
  // RLS (guardian_links_self_service_select) already scopes this to
  // exactly the guardian_links rows for the caller's own linked
  // customer record(s) -- no extra filter needed here.
  const { data: links, error: linksError } = await supabase.from('guardian_links').select('player_id')
  if (linksError) throw linksError

  const playerIds = [...new Set((links ?? []).map((l) => l.player_id))]
  if (playerIds.length === 0) return []

  const { data: players, error } = await supabase
    .from('players')
    .select('id, full_name, photo_url, enrollments(id, status, groups(name), subscriptions(status, end_date))')
    .in('id', playerIds)
  if (error) throw error
  return (players ?? []) as unknown as PortalPlayer[]
}

const SUB_STATUS_LABELS: Record<string, string> = {
  pending: 'بانتظار التفعيل',
  active: 'نشط',
  frozen: 'مجمّد',
  expired: 'منتهي',
  cancelled: 'ملغي',
}

export function PortalAcademyPage() {
  const { data: players = [], isLoading, error } = useQuery({ queryKey: ['portal', 'my-players'], queryFn: fetchMyPlayers })

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="أكاديميتي" description="أبنائي المسجّلون في الأكاديمية" />

      {isLoading && <p className="text-sm text-text-secondary">جارٍ التحميل...</p>}
      {error && <p className="text-sm text-status-danger">تعذّر تحميل البيانات.</p>}

      {!isLoading && players.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          لا يوجد لاعبون مرتبطون بحسابك حاليًا.
        </p>
      )}

      {players.map((p) => {
        const activeEnrollment = p.enrollments?.find((e) => e.status === 'active')
        const sub = activeEnrollment?.subscriptions?.[0]
        return (
          <div key={p.id} className="flex items-center gap-3 rounded-lg border border-border bg-surface p-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-semibold">
              {p.full_name.charAt(0)}
            </div>
            <div className="flex flex-1 flex-col gap-0.5">
              <p className="font-medium">{p.full_name}</p>
              <p className="text-xs text-text-secondary">{activeEnrollment?.groups?.name ?? 'غير مسجّل حاليًا'}</p>
            </div>
            {sub && <StatusBadge tone={sub.status === 'active' ? 'success' : sub.status === 'frozen' ? 'warning' : 'neutral'} label={SUB_STATUS_LABELS[sub.status] ?? sub.status} />}
          </div>
        )
      })}
    </div>
  )
}
