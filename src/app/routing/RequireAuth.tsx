import { Navigate, Outlet, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useAuth } from '@/app/providers/AuthProvider'
import { canSeeNavDomain, type NavDomain } from '@/lib/domain/navigation'
import { Button } from '@/components/ui/button'

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
  const { loading, currentMembership, memberships, signOut } = useAuth()
  const { t } = useTranslation()

  if (loading) return null

  // Zero real memberships -- not "an unrecognized role", a genuine
  // customer-only (or freshly-deauthorized) account with nothing to
  // route into. Render an explicit terminal state instead of computing
  // a redirect target that can point back at the very route currently
  // rendering it.
  if (memberships.length === 0) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="max-w-sm text-text-secondary">{t('routing.noClubAccess')}</p>
        <Button variant="outline" onClick={() => void signOut()}>
          {t('routing.signOut')}
        </Button>
      </div>
    )
  }

  if (!currentMembership || !canSeeNavDomain(currentMembership.roleKey, domain)) {
    return <Navigate to={canSeeNavDomain(currentMembership?.roleKey, 'today') ? '/app' : '/scan'} replace />
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
