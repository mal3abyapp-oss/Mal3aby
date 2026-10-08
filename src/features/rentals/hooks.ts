import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import type { RentalBookingRequest, RentalContractRow, RentalReport, RentalSpaceRow } from './types'

export function useRentalPermissions() {
  const { currentMembership } = useAuth()
  const keys = currentMembership?.permissionKeys ?? []
  return {
    canManageSpaces: keys.includes('rental.space.manage'),
    canCreateContracts: keys.includes('rental.contract.create'),
    canManageContracts: keys.includes('rental.contract.manage'),
    canCollect: keys.includes('payment.create'),
  }
}

export function useRentalSpaces(includeArchived = false) {
  const { currentClubId } = useAuth()
  return useQuery({
    queryKey: ['rental-spaces', currentClubId, includeArchived],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_rental_spaces', { p_club_id: currentClubId!, p_include_archived: includeArchived })
      if (error) throw error
      return (data ?? []) as unknown as RentalSpaceRow[]
    },
    enabled: !!currentClubId,
  })
}

export function useRentalContracts(filters: { status?: string; spaceId?: string; customerId?: string } = {}) {
  const { currentClubId } = useAuth()
  return useQuery({
    queryKey: ['rental-contracts', currentClubId, filters.status ?? '', filters.spaceId ?? '', filters.customerId ?? ''],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_rental_contracts', {
        p_club_id: currentClubId!,
        p_status: filters.status || undefined,
        p_space_id: filters.spaceId || undefined,
        p_customer_id: filters.customerId || undefined,
      })
      if (error) throw error
      return (data ?? []) as unknown as RentalContractRow[]
    },
    enabled: !!currentClubId,
  })
}

/** Rental report for an explicit date range (used by the overview / dues tabs and the Reports page). */
export function useRentalReport(startDate: string, endDate: string) {
  const { currentClubId } = useAuth()
  return useQuery({
    queryKey: ['get_rental_report', currentClubId, startDate, endDate],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_rental_report', { p_club_id: currentClubId!, p_start_date: startDate, p_end_date: endDate })
      if (error) throw error
      return data as unknown as RentalReport
    },
    enabled: !!currentClubId,
  })
}

/** Everything that shows rental money/state -- invalidated after any rental write. */
export function useInvalidateRentals() {
  const queryClient = useQueryClient()
  return () => {
    for (const key of ['rental-spaces', 'rental-contracts', 'rental-contract-detail', 'get_rental_report', 'rental-attention', 'rental-booking-requests', 'rental-alerts', 'rental-meters', 'rental-documents']) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }
}

export function monthRange(): { startDate: string; endDate: string } {
  const now = new Date()
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1))
  const end = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 0))
  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) }
}

/** Online hall booking requests ('pending' | 'approved' | 'rejected' | 'cancelled' | 'all'). */
export function useBookingRequests(status: string) {
  const { currentClubId } = useAuth()
  return useQuery({
    queryKey: ['rental-booking-requests', currentClubId, status],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('list_rental_booking_requests', {
        p_club_id: currentClubId!,
        p_status: status,
      })
      if (error) throw error
      return (data ?? []) as unknown as RentalBookingRequest[]
    },
    enabled: !!currentClubId,
  })
}
