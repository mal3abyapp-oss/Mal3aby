import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { ClaimAccountPage } from './ClaimAccountPage'
import { PortalBookingsPage } from './PortalBookingsPage'

// Gate 3 — the portal's root decides between the claim flow (no linked
// customer record yet in ANY club) and the real dashboard. A session
// may be linked in one club but not another; this only checks "is
// there at least one linked customer record at all" to decide whether
// to show the claim prompt -- each individual screen still scopes its
// own data correctly via RLS regardless.
async function fetchMyLinkedCustomerCount(): Promise<number> {
  const { count, error } = await supabase.from('customers').select('id', { count: 'exact', head: true })
  if (error) throw error
  return count ?? 0
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
