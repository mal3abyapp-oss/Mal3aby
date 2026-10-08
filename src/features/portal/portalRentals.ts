import { supabase } from '@/lib/supabase/client'
import type { PortalBookableSpace, PortalBookingRequest, PortalRentalContract } from '@/features/rentals/types'

/** The signed-in customer's own leases/bookings (get_my_portal_rentals, auth.uid() resolved server-side). */
export async function fetchMyPortalRentals(): Promise<PortalRentalContract[]> {
  const { data, error } = await supabase.rpc('get_my_portal_rentals')
  if (error) throw error
  return (data ?? []) as unknown as PortalRentalContract[]
}

/** Spaces of a club this customer can request online (halls), with busy slots. */
export async function fetchPortalBookableSpaces(clubId: string): Promise<PortalBookableSpace[]> {
  const { data, error } = await supabase.rpc('get_portal_bookable_spaces', { p_club_id: clubId })
  if (error) throw error
  return (data ?? []) as unknown as PortalBookableSpace[]
}

export async function fetchMyBookingRequests(): Promise<PortalBookingRequest[]> {
  const { data, error } = await supabase.rpc('get_my_rental_booking_requests')
  if (error) throw error
  return (data ?? []) as unknown as PortalBookingRequest[]
}
