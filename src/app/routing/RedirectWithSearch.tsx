import { Navigate, useLocation } from 'react-router-dom'

// Finance IA consolidation directive section 31/32: old finance routes
// (/app/billing, /app/outstanding, /app/pending-payments, /app/cash-shift)
// redirect into the new /app/finance/* structure, but existing deep
// links carry query params that must survive (e.g. Academy's
// "Collect Payment Now" link to /app/billing?invoice=<id>,
// BookingDetailSheet/CustomerDetailDialog's own invoice deep links).
// React Router's plain <Navigate to="/x" replace /> drops the current
// location's search string entirely -- this component re-attaches it.
export function RedirectWithSearch({ to }: { to: string }) {
  const location = useLocation()
  return <Navigate to={`${to}${location.search}`} replace />
}
