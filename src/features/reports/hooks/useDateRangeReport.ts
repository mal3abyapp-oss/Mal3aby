import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'
import { fromInstant } from '@/lib/domain/time'

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
//
// COMPREHENSIVE REPORTS ACCEPTANCE (2026-08-30), directive Section 6
// (timezone boundary): the default start/end dates used to be computed
// via `new Date().toISOString().slice(0, 10)` -- the BROWSER's timezone
// converted to UTC, not the club's. Near a local midnight boundary
// (e.g. a club in Africa/Cairo, UTC+3), a staff member could open a
// report and see a default range that's off by one day from what
// "today" actually means for their club -- a real violation of this
// project's own established Time Model (already fixed once for the
// exact same bug class in BillingPage.tsx's "Collected Today" figure;
// this hook was a genuine, separate regression of that same class,
// reproduced across all 19 report screens that call useDateRange()
// since they all funnel through this one shared hook).
//
// Fixed by fetching clubs.timezone (same query shape/fallback as
// BillingPage.tsx) and computing "today"/"30 days ago" via
// fromInstant() -- src/lib/domain/time.ts's own Time Model module,
// "the single place that converts between" Instant and Business Date
// in a given IANA venue timezone. Reusing it here rather than
// hand-rolling a parallel Intl.DateTimeFormat call keeps this fix
// consistent with the project's one established conversion primitive
// instead of adding a second one. The initial useState value still
// uses the browser-UTC approximation (unavoidable: the timezone fetch
// is async and a hook cannot block its own first render), then a
// useEffect corrects it to the timezone-exact value the moment the
// club's timezone is known. Every report screen using this hook
// already gates its own data fetch on `enabled: !!currentClubId` (see
// useDateRangeReport below), so the brief pre-correction window is a
// same-tick default-value detail, not a wrong query ever actually
// firing.
export function useDateRange() {
  const { currentClubId } = useAuth()
  const [startDate, setStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 30)
    return d.toISOString().slice(0, 10)
  })
  const [endDate, setEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  const userEditedRef = useRef(false)

  const { data: clubTimezone } = useQuery({
    queryKey: ['report-date-range-club-timezone', currentClubId],
    queryFn: async () => {
      const { data } = await supabase.from('clubs').select('timezone').eq('id', currentClubId!).maybeSingle()
      return data?.timezone ?? 'Africa/Cairo'
    },
    enabled: !!currentClubId,
    staleTime: Infinity,
  })

  useEffect(() => {
    // Only auto-correct the STILL-DEFAULT range once the real timezone
    // is known -- never override a date the user has already picked.
    if (!clubTimezone || userEditedRef.current) return
    const end = new Date()
    const start = new Date()
    start.setDate(start.getDate() - 30)
    setEndDate(fromInstant(end, clubTimezone).date)
    setStartDate(fromInstant(start, clubTimezone).date)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clubTimezone])

  return {
    startDate,
    setStartDate: (v: string) => { userEditedRef.current = true; setStartDate(v) },
    endDate,
    setEndDate: (v: string) => { userEditedRef.current = true; setEndDate(v) },
  }
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
