import { supabase } from '@/lib/supabase/client'
import type { PortalRentalContract } from '@/features/rentals/types'

/** The signed-in customer's own leases/bookings (get_my_portal_rentals, auth.uid() resolved server-side). */
export async function fetchMyPortalRentals(): Promise<PortalRentalContract[]> {
  const { data, error } = await supabase.rpc('get_my_portal_rentals')
  if (error) throw error
  return (data ?? []) as unknown as PortalRentalContract[]
}
