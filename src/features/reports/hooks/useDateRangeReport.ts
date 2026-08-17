import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'

// Master IA/UX audit (Reports decomposition phase): every report screen
// used to hand-write the identical useQuery boilerplate -- same
// queryKey shape, same `enabled: !!currentClubId`, same
// `supabase.rpc(name, {p_club_id, p_start_date, p_end_date})`, same
// error-throw, same cast -- 8 of the 9 original ReportsPage.tsx tabs
// followed this exact pattern (confirmed via the Reports architecture
// audit). Centralizing it here means every independent report screen
// gets identical date-range/loading/error behavior for free, and any
// future fix to the pattern (e.g. adding a shared error boundary) lands
// in one place instead of 8.
export function useDateRange() {
  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return d.toISOString().slice(0, 10)
  })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  return { startDate, setStartDate, endDate, setEndDate }
}

/**
 * Shared fetch-by-date-range pattern for report RPCs shaped as
 * `rpc_name(p_club_id, p_start_date, p_end_date, ...extraParams)`.
 * `extraParams` is merged into the RPC call args and included in the
 * query key so filter changes (e.g. RevenueReportTab's payment-method
 * filter) correctly trigger a refetch.
 */
export function useDateRangeReport<T>(
  rpcName: string,
  startDate: string,
  endDate: string,
  extraParams?: Record<string, string | undefined>,
) {
  const { currentClubId } = useAuth()
  const extraKey = extraParams ? JSON.stringify(extraParams) : ''
  return useQuery({
    queryKey: [rpcName, currentClubId, startDate, endDate, extraKey],
    queryFn: async () => {
      const params: Record<string, string> = {
        p_club_id: currentClubId!,
        p_start_date: startDate,
        p_end_date: endDate,
      }
      if (extraParams) {
        for (const [key, value] of Object.entries(extraParams)) {
          if (value !== undefined) params[key] = value
        }
      }
      // Supabase's generated client types `rpc()`'s first argument as a
      // literal union of every known function name (for autocomplete/
      // typo-safety on static call sites) -- this hook is intentionally
      // generic over any date-range report RPC, so the literal-union
      // check is cast away here, once, rather than at every call site.
      const { data, error } = await supabase.rpc(rpcName as Parameters<typeof supabase.rpc>[0], params)
      if (error) throw error
      return data as unknown as T
    },
    enabled: !!currentClubId,
  })
}
