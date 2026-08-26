import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { lazy, Suspense, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/app/providers/AuthProvider'
import { canSeeNavDomain, type NavDomain } from '@/lib/domain/navigation'
import { Button } from '@/components/ui/button'
import { supabase } from '@/lib/supabase/client'

const ClaimAccountPageLazy = lazy(() =>
  import('@/features/portal/ClaimAccountPage').then((m) => ({ default: m.ClaimAccountPage })),
)

// Guards /app and /platform. Client-side redirect only — the real security
// boundary is always RLS on the server (docs/SECURITY_ANTI_FRAUD.md); this
// just prevents rendering an authenticated shell with no session.
export function RequireAuth() {
  const { session, loading } = useAuth()
  const location = useLocation()

  if (loading) return null

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <Outlet />
}

// Mirrors the role-aware navigation at the routing boundary. RLS remains the
// data-security boundary, but a user must not bypass the product role matrix
// merely by typing a hidden URL directly.
//
// DUAL-IDENTITY STAFF + CUSTOMER AUTH AUDIT (2026-08-25): a genuinely
// zero-membership account (a customer-only auth session with no
// club_membership row at all) hitting /app used to hit an infinite
// self-redirect loop. canSeeNavDomain(undefined, ...)'s "unrecognized
// role -> permissive" fallback (see navigation.ts) can't distinguish "no
// role at all" from "a role this nav matrix doesn't know about", so the
// old redirect target computation (canSeeNavDomain(currentMembership?.
// roleKey, 'today') ? '/app' : '/scan') resolved to '/app' for a null
// currentMembership -- and /app's own index route is itself wrapped in
// RequireNavDomain domain="today", so the redirect pointed straight back
// at the component currently rendering it, on every remount. This never
// leaked any data (RLS was never in question -- this is client-side
// routing only, per this file's own header comment), but it is a real,
// silently-broken UX: a customer-only account got a frozen/looping
// screen instead of the explicit "no club access" state the audit's own
// section 4 requires ("BLOCKED بالكامل ... لا تعتمد على UI hiding" --
// this fixes the UI side of that; RLS already enforces the real
// boundary, proven separately in dual-identity-email-isolation.
// integration.test.ts).
export function RequireNavDomain({ domain, children }: { domain: NavDomain; children: ReactNode }) {
  const { loading, currentMembership, memberships, signOut, supportSession } = useAuth()
  const { t } = useTranslation()

  if (loading) return null

  // Zero real memberships -- not "an unrecognized role", a genuine
  // customer-only (or freshly-deauthorized) account with nothing to
  // route into. Render an explicit terminal state instead of computing
  // a redirect target that can point back at the very route currently
  // rendering it.
  //
  // MASTER ADMIN / PLATFORM SUPPORT CONTEXT: a platform_owner (or, once
  // Platform Staff exists, any platform employee) can legitimately have
  // ZERO real club_memberships rows of their own -- that is the clean,
  // correct shape for a pure platform-side account, not an error state.
  // `memberships` here is only ever the platform_owner's OWN real
  // club_memberships rows (AuthProvider never mixes support-session
  // state into it) -- an active supportSession must bypass this
  // "no club access" terminal state entirely, since currentMembership is
  // already correctly synthesized for the supported club in that case.
  if (memberships.length === 0 && !supportSession) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-sm text-text-secondary">{t('routing.noClubAccess')}</p>
        <Button variant="outline" onClick={() => void signOut()}>
          {t('routing.signOut')}
        </Button>
      </div>
    )
  }

  if (!currentMembership || !canSeeNavDomain(currentMembership.permissionKeys, domain)) {
    return <Navigate to={canSeeNavDomain(currentMembership?.permissionKeys, 'today') ? '/app' : '/scan'} replace />
  }

  return children
}

// Guards /portal (the customer/guardian self-service area, Gate 3).
// Session-only, same as RequireAuth — a customer never needs a
// club_membership row (that would incorrectly grant staff-side RLS
// access). The real boundary is still RLS: customers_self_service_*
// policies scoped to customers.user_id = auth.uid().
export function RequirePortalAuth() {
  const { session, loading } = useAuth()
  const location = useLocation()

  if (loading) return null

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <Outlet />
}

// PERSONA COUNCIL AUDIT (2026-08-25) — Customer persona, P0 finding: this
// guard closes the "claim-gate bypass" dead end. The claim-vs-dashboard
// check used to live ONLY inline in PortalRoot, on the bare /portal index
// route — router.tsx's own prior comment on the sibling routes ("this
// route bypasses that gate entirely since reaching it at all requires
// RequirePortalAuth, which already implies a linked customer record
// exists") was simply false: RequirePortalAuth only checks session
// existence, never customer linkage. A real, live-reproduced account with
// a valid session but zero customers.user_id link got a DIFFERENT,
// misleading "empty" screen on every /portal/* sub-route (bookings: "no
// bookings yet", academy: "no players linked", profile: "no data linked
// to your account") with no path back to the one screen that would have
// explained why and offered the fix — a genuine dead end, not merely an
// empty state.
//
// This guard now wraps the WHOLE /portal subtree (every child of
// PortalLayout, index route included) so the claim gate is structurally
// impossible to bypass via a different sub-route, bookmark, deep link, or
// the bottom nav. Uses the same get_my_portal_customers() RPC as
// PortalClubProvider/PortalRoot -- SECURITY DEFINER, checks
// customers.user_id = auth.uid() directly, never RLS's OR-combined
// policy set (see the cross-persona authorization fix). This is a
// client-side UX guard only, same disclosure as every guard in this file
// -- RLS already independently enforces that an unlinked session can
// never read another customer's data regardless of this guard.
export function RequirePortalCustomer({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const { data: linkedCount, isLoading } = useQuery({
    queryKey: ['portal', 'linked-customer-count'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_my_portal_customers')
      if (error) throw error
      return (data ?? []).length
    },
  })

  if (isLoading) return null

  if (!linkedCount || linkedCount === 0) {
    return (
      <Suspense fallback={null}>
        <ClaimAccountPageLazy
          onClaimed={() => {
            void queryClient.invalidateQueries({ queryKey: ['portal'] })
          }}
        />
      </Suspense>
    )
  }

  return children
}

// Guards /platform specifically — requires the platform_owner role on at
// least one active membership. Real enforcement is still server-side
// (public.is_platform_owner() SECURITY DEFINER + RLS policies); this only
// prevents rendering the console shell for non-owners.
export function RequirePlatformOwner() {
  const { session, loading, isPlatformOwner } = useAuth()
  const location = useLocation()

  if (loading) return null

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (!isPlatformOwner) {
    return <Navigate to="/app" replace />
  }

  return <Outlet />
}
