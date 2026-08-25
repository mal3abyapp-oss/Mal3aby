import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { supabase } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { StatusBadge } from '@/components/ui/status-badge'
import { usePortalClub } from '@/app/providers/PortalClubProvider'

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

// PORTAL CROSS-PERSONA AUTHORIZATION VULNERABILITY FIX (HIGH, 2026-08-25):
// this used to query `guardian_links` with zero filter, relying on RLS
// alone (guardian_links_self_service_select) -- for a staff member's
// Portal session, guardian_links_select_club_staff (customer.view on the
// customer's own club) is ALSO an applicable SELECT policy and
// OR-combines with it, so this returned every guardian_link in that
// club, not just the caller's own. Proven live via a real authenticated
// REST call (8 real unrelated guardian_links, exposing real players'
// enrollment data, returned to a Portal session with no linked customer
// at all). Now filters explicitly by customer_id IN (this account's own
// customer ids, sourced exclusively from get_my_portal_customers()) --
// an ownership-proven allowlist, not an ambient RLS assumption.
async function fetchMyPlayers(ownedCustomerIds: string[]): Promise<PortalPlayer[]> {
  if (ownedCustomerIds.length === 0) return []
  const { data: links, error: linksError } = await supabase
    .from('guardian_links')
    .select('player_id')
    .in('customer_id', ownedCustomerIds)
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

export function PortalAcademyPage() {
  const { t } = useTranslation()
  const { customerMemberships, isLoading: clubLoading } = usePortalClub()
  const ownedCustomerIds = customerMemberships.map((m) => m.customerId)
  const { data: players = [], isLoading, error } = useQuery({
    queryKey: ['portal', 'my-players', ownedCustomerIds],
    queryFn: () => fetchMyPlayers(ownedCustomerIds),
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

      {isLoading && <p className="text-sm text-text-secondary">{t('portal.academyPage.loading')}</p>}
      {error && <p className="text-sm text-status-danger">{t('portal.academyPage.loadError')}</p>}

      {!isLoading && players.length === 0 && (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-secondary">
          {t('portal.academyPage.emptyTitle')}
        </p>
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
                  return (
                    <div key={enrollment.id} className="flex items-center justify-between gap-2">
                      <p className="text-xs text-text-secondary">{enrollment.groups?.name ?? '—'}</p>
                      {sub && <StatusBadge tone={sub.status === 'active' ? 'success' : sub.status === 'frozen' ? 'warning' : 'neutral'} label={SUB_STATUS_LABELS[sub.status] ?? sub.status} />}
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
