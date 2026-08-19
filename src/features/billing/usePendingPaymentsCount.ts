import { useQuery } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from '@/app/providers/AuthProvider'

// HIGH-ROI UX PASS 01, Priority 3 (design audit finding: "Pending
// Payments" -- a time-sensitive review queue where a real customer is
// waiting on their booking's payment hold countdown -- had zero
// ambient signal anywhere in navigation; staff had to open the screen
// to discover work). Shared across the sidebar badge, the mobile More
// list, and Today's exception card so all three always agree.
//
// A plain count query is deliberately used here rather than a new RPC:
// payment_proofs' own RLS (payment_proofs_staff_all, gated on
// has_permission('payment.create', club_id)) already scopes this
// correctly per-tenant and per-permission -- adding a SECURITY DEFINER
// RPC would duplicate a check RLS already performs for free. head:true
// avoids fetching row bodies, keeping this a single lightweight COUNT
// query, not a payload-carrying one.
export function usePendingPaymentsCount() {
  const { currentClubId } = useAuth()
  return useQuery({
    queryKey: ['pending-payments-count', currentClubId],
    queryFn: async () => {
      const { count, error } = await supabase
        .from('payment_proofs')
        .select('id', { count: 'exact', head: true })
        .eq('club_id', currentClubId!)
        .eq('status', 'pending_review')
      if (error) throw error
      return count ?? 0
    },
    enabled: !!currentClubId,
    refetchInterval: 30000,
  })
}
