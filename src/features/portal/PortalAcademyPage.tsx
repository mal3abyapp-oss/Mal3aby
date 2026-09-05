import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { StatusBadge } from '@/components/ui/status-badge'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { Skeleton } from '@/components/ui/skeleton'
import { translateSupabaseError } from '@/lib/errors'
import { usePortalClub } from '@/app/providers/PortalClubProvider'
import { useDirection } from '@/app/providers/DirectionProvider'
import { GraduationCap } from 'lucide-react'

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
    groups: { name: string; branchName: string | null; fieldName: string | null } | null
    subscriptions: { status: string; end_date: string }[]
  }[]
}

interface PortalAcademyRpcRow {
  player_id: string
  player_full_name: string
  player_photo_url: string | null
  enrollment_id: string | null
  enrollment_status: string | null
  group_name: string | null
  branch_name: string | null
  field_name: string | null
  subscription_status: string | null
  subscription_end_date: string | null
}

// PORTAL PERSONA-SCOPED DATA CONTRACT HARDENING (2026-08-25), follow-up
// to the cross-persona authorization fix. A frontend `.in('customer_id',
// ownedCustomerIds)` filter is a UX/data-shape concern, not a security
// boundary on its own -- it depends on every current and future Portal
// code path applying it correctly, with guardian_links_select_club_staff
// RLS sitting immediately behind it as a silent fallback the moment that
// filter is ever dropped (the exact failure mode of the original bug --
// 8 real unrelated guardian_links, exposing real players' enrollment
// data, were returned to a Portal session with no linked customer at all
// before that fix). get_my_portal_academy() is a SECURITY DEFINER RPC
// hard-coded to customers.user_id = auth.uid() in its own SQL body --
// no way for a client request to reach outside the caller's own linked
// customer's guardian_links, regardless of any staff permission on the
// same auth.uid(). Live-verified against the same real production
// session: returns [] where the old query returned 8 real rows.
//
// Returns one row per (player, enrollment) -- grouped back into
// PortalPlayer[] here so the existing "every active enrollment as its
// own row" fix (Phase 10 IA restructuring) keeps working unchanged.
//
// PERSONA COUNCIL AUDIT (2026-08-25) -- Customer persona finding: this
// screen answered "is my subscription active" but not "until when" or
// "where do I go" -- subscription_end_date was already fetched into the
// old data model and simply never rendered, and branch/field were never
// fetched at all despite being real, joinable columns on `groups`
// (branch_id/field_id). Widened the RPC to include branch_name/
// field_name (see the migration's own DROP+CREATE note) -- no schedule/
// timetable data exists anywhere in this product's data model
// (`groups` has no day/time columns at all, confirmed against the live
// schema), so that specific question genuinely cannot be answered here
// without inventing a feature; expiry date and location are the real,
// available parts of "where/when do I go" and are now shown.
async function fetchMyPlayers(): Promise<PortalPlayer[]> {
  const { data, error } = await supabase.rpc('get_my_portal_academy')
  if (error) throw error
  const rows = (data ?? []) as PortalAcademyRpcRow[]

  const byPlayer = new Map<string, PortalPlayer>()
  for (const r of rows) {
    let player = byPlayer.get(r.player_id)
    if (!player) {
      player = { id: r.player_id, full_name: r.player_full_name, photo_url: r.player_photo_url, enrollments: [] }
      byPlayer.set(r.player_id, player)
    }
    if (r.enrollment_id && r.enrollment_status) {
      player.enrollments.push({
        id: r.enrollment_id,
        status: r.enrollment_status,
        groups: r.group_name ? { name: r.group_name, branchName: r.branch_name, fieldName: r.field_name } : null,
        subscriptions: r.subscription_status && r.subscription_end_date ? [{ status: r.subscription_status, end_date: r.subscription_end_date }] : [],
      })
    }
  }
  return [...byPlayer.values()]
}

export function PortalAcademyPage() {
  const { t } = useTranslation()
  const { locale } = useDirection()
  const { isLoading: clubLoading } = usePortalClub()
  const { data: players = [], isLoading, error, refetch } = useQuery({
    queryKey: ['portal', 'my-players'],
    queryFn: fetchMyPlayers,
    enabled: !clubLoading,
  })

  const SUB_STATUS_LABELS: Record<string, string> = {
    pending: t('academy.subscriptionStatusLabels.pending'),
    active: t('academy.subscriptionStatusLabels.active'),
    frozen: t('academy.subscriptionStatusLabels.frozen'),
    expired: t('academy.subscriptionStatusLabels.expired'),
    cancelled: t('academy.subscriptionStatusLabels.cancelled'),
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader title={t('portal.academyPage.title')} description={t('portal.academyPage.description')} />

      {isLoading && (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      )}
      {!!error && (
        <ErrorState message={translateSupabaseError(error, t('portal.academyPage.loadError'))} onRetry={() => void refetch()} />
      )}

      {!isLoading && !error && players.length === 0 && (
        <EmptyState icon={GraduationCap} title={t('portal.academyPage.emptyTitle')} description={t('portal.academyPage.emptyHint')} />
      )}

      {players.map((p) => {
        // IA restructuring (Phase 10): confirmed silent-data-drop bug --
        // `.find(...)` only ever surfaced the FIRST active enrollment,
        // so a player enrolled in two academy groups at once (a real,
        // supported state -- e.g. football + swimming) silently lost
        // one of them from this screen with no indication anything was
        // hidden. Now renders every active enrollment as its own row.
        const activeEnrollments = p.enrollments?.filter((e) => e.status === 'active') ?? []
        return (
          <div key={p.id} className="flex items-start gap-3 rounded-lg border border-border bg-surface p-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-muted text-lg font-semibold">
              {p.full_name.charAt(0)}
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <p className="font-medium">{p.full_name}</p>
              {activeEnrollments.length === 0 ? (
                <p className="text-xs text-text-secondary">{t('portal.academyPage.notEnrolled')}</p>
              ) : (
                activeEnrollments.map((enrollment) => {
                  const sub = enrollment.subscriptions?.[0]
                  const location = [enrollment.groups?.branchName, enrollment.groups?.fieldName].filter(Boolean).join(' · ')
                  return (
                    <div key={enrollment.id} className="flex flex-col gap-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs text-text-secondary">{enrollment.groups?.name ?? '—'}</p>
                        {sub && <StatusBadge tone={sub.status === 'active' ? 'success' : sub.status === 'frozen' ? 'warning' : 'neutral'} label={SUB_STATUS_LABELS[sub.status] ?? sub.status} />}
                      </div>
                      {location && <p className="text-xs text-text-secondary">{location}</p>}
                      {sub?.end_date && (
                        <p className="text-xs text-text-secondary">
                          {t('portal.academyPage.subscriptionUntil', {
                            date: new Date(sub.end_date).toLocaleDateString(locale === 'en' ? 'en-US' : 'ar-EG', { day: 'numeric', month: 'long', year: 'numeric' }),
                          })}
                        </p>
                      )}
                    </div>
                  )
                })
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
