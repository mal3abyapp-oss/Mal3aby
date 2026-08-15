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

// Guards /platform specifically — requires the platform_owner role on at
// least one active membership. Real enforcement is still server-side
// (public.is_platform_owner() SECURITY DEFINER + RLS policies); this only
// prevents rendering the console shell for non-owners.
export function RequirePlatformOwner() {
  const { session, loading, memberships } = useAuth()
  const location = useLocation()

  if (loading) return null

  if (!session) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  const isPlatformOwner = memberships.some((m) => m.roleKey === 'platform_owner')
  if (!isPlatformOwner) {
    return <Navigate to="/app" replace />
  }

  return <Outlet />
}
