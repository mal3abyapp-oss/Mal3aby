import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { ClaimAccountPage } from './ClaimAccountPage'
import { PortalBookingsPage } from './PortalBookingsPage'

// Gate 3 — the portal's root decides between the claim flow (no linked
// customer record yet in ANY club) and the real dashboard. A session
// may be linked in one club but not another; this only checks "is
// there at least one linked customer record at all" to decide whether
// to show the claim prompt.
//
// PORTAL CROSS-PERSONA AUTHORIZATION VULNERABILITY FIX (HIGH, 2026-08-25):
// this used to be an unfiltered `customers` count, relying on RLS alone
// -- for a staff member's Portal session, customers_select_club_staff
// made this count the WHOLE club's roster (always > 0 for any staff
// account with customer.view), so a staff-only account with zero real
// customer link was routed straight into the dashboard instead of the
// claim-account prompt. Now derives the count exclusively from
// get_my_portal_customers() (see PortalClubProvider.tsx), the one
// SECURITY DEFINER RPC that checks customers.user_id = auth.uid()
// directly and never delegates to RLS's OR-combined policy set.
async function fetchMyLinkedCustomerCount(): Promise<number> {
  const { data, error } = await supabase.rpc('get_my_portal_customers')
  if (error) throw error
  return (data ?? []).length
}

export function PortalRoot() {
  const queryClient = useQueryClient()
  const { data: linkedCount, isLoading } = useQuery({
    queryKey: ['portal', 'linked-customer-count'],
    queryFn: fetchMyLinkedCustomerCount,
  })

  if (isLoading) return null

  if (!linkedCount || linkedCount === 0) {
    return (
      <ClaimAccountPage
        onClaimed={() => {
          void queryClient.invalidateQueries({ queryKey: ['portal'] })
        }}
      />
    )
  }

  return <PortalBookingsPage />
}
