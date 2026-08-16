import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'

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
