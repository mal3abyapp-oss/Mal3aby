import { PortalBookingsPage } from './PortalBookingsPage'

// Gate 3 — the portal's index route. The claim-vs-dashboard decision
// used to live here (a linked-customer-count check deciding between
// ClaimAccountPage and the real dashboard) -- moved up to
// RequirePortalCustomer (src/app/routing/RequireAuth.tsx) so every
// /portal/* route shares the same gate, not just this one (see that
// guard's own comment for the full PERSONA COUNCIL AUDIT rationale).
// Reaching this component at all now means a linked customer record
// already exists, so it can render the dashboard unconditionally.
export function PortalRoot() {
  return <PortalBookingsPage />
}
