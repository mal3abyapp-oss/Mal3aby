import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase/client'
import { useAuth } from './AuthProvider'

// Multi-club portal customer context (Multi-Club E2E audit, 2026-08-24).
//
// The DB layer has supported one auth user holding a separate linked
// customers row per club since 20260823050000_customer_portal_zero_cost_
// activation.sql widened customers_user_id_unique to
// UNIQUE(club_id, user_id) -- but nothing on the frontend ever tracked
// "which of my linked clubs am I currently looking at".
//
// This mirrors AuthProvider's own memberships/currentClubId pattern
// (same shape: load all rows for auth.uid(), dedupe, pick one as
// "current", persist the choice, expose a setter) rather than inventing
// a second pattern -- AuthProvider's version is for staff
// club_memberships rows, this one is for portal customers rows. Kept as
// a separate provider (not merged into AuthProvider) because a portal
// customer and a staff member are different identity concepts in this
// app (RequireAuth.tsx's own comment: "a customer never needs a
// club_membership row") -- AuthProvider's memberships stays empty for a
// pure portal customer, and this provider's customerMemberships stays
// empty for pure staff, so mounting both unconditionally on every
// session is cheap and never conflates the two.
//
// PORTAL CROSS-PERSONA AUTHORIZATION VULNERABILITY FIX (HIGH, confirmed
// live in production, 2026-08-25): this used to query `customers` with
// ZERO filter, on the assumption that customers_self_service_select RLS
// (user_id = auth.uid()) was the only applicable policy -- wrong for any
// account that is ALSO staff somewhere, since Postgres OR-combines
// customers_select_club_staff into the same query, silently returning
// the entire club's customer roster to a staff member's Portal session.
// Proven live via a real authenticated REST call using a real
// staff+portal dual-context session's own JWT (no impersonation): the
// old unfiltered query returned dozens of unrelated customers.
//
// Fixed by moving identity resolution entirely server-side into
// get_my_portal_customers() -- a SECURITY DEFINER RPC that checks
// customers.user_id = auth.uid() directly in its own SQL body, never
// delegating to RLS's OR-combined policy set and never consulting
// has_permission()/user_club_ids() at all. This is now the ONLY source
// of "which customer records does this session own" anywhere in the
// Portal -- every other Portal screen must filter by customer_id IN
// (activeCustomerId / customerMemberships[].customerId), an explicit
// ownership-proven allowlist, never re-query `customers` directly.

export interface PortalCustomerMembership {
  customerId: string
  clubId: string
  clubName: string | null
  clubNameAr: string | null
}

interface PortalClubContextValue {
  customerMemberships: PortalCustomerMembership[]
  isLoading: boolean
  activeClubId: string | null
  activeCustomerId: string | null
  setActiveClubId: (clubId: string) => void
  activeMembership: PortalCustomerMembership | null
  refresh: () => void
}

const PortalClubContext = createContext<PortalClubContextValue | undefined>(undefined)

const ACTIVE_CLUB_STORAGE_KEY = 'mala3by.portal.activeClubId'

interface PortalCustomerRpcRow {
  customer_id: string
  club_id: string
  club_name: string | null
  club_name_ar: string | null
}

async function fetchMyCustomerMemberships(): Promise<PortalCustomerMembership[]> {
  const { data, error } = await supabase.rpc('get_my_portal_customers')
  if (error) throw error
  const rows = (data ?? []) as PortalCustomerRpcRow[]
  // A customer can hold at most one linked row per club (customers_club_
  // user_id_unique), so no same-club dedup is needed here the way
  // AuthProvider dedupes club_memberships (which can have >1 row per
  // club for different reasons) -- each row is already guaranteed to be
  // a distinct club.
  return rows.map((r) => ({
    customerId: r.customer_id,
    clubId: r.club_id,
    clubName: r.club_name,
    clubNameAr: r.club_name_ar,
  }))
}

export function PortalClubProvider({ children }: { children: ReactNode }) {
  const { session } = useAuth()
  const queryClient = useQueryClient()
  const [activeClubId, setActiveClubIdState] = useState<string | null>(null)

  const { data: customerMemberships = [], isLoading } = useQuery({
    queryKey: ['portal', 'customer-memberships'],
    queryFn: fetchMyCustomerMemberships,
    enabled: !!session,
  })

  // Same resolution order as AuthProvider.loadMemberships(): prefer the
  // persisted choice if it's still valid for this session, otherwise
  // fall back to the first row deterministically (never truly
  // "arbitrary" -- always the same first row for the same query, and
  // immediately persisted so the next load is stable) rather than
  // leaving activeClubId unresolved.
  useEffect(() => {
    if (isLoading) return
    if (customerMemberships.length === 0) {
      setActiveClubIdState(null)
      return
    }
    const stored = localStorage.getItem(ACTIVE_CLUB_STORAGE_KEY)
    const validStored = customerMemberships.find((m) => m.clubId === stored)
    if (validStored) {
      setActiveClubIdState(validStored.clubId)
    } else {
      setActiveClubIdState(customerMemberships[0]!.clubId)
      localStorage.setItem(ACTIVE_CLUB_STORAGE_KEY, customerMemberships[0]!.clubId)
    }
  }, [isLoading, customerMemberships])

  useEffect(() => {
    if (!session) {
      setActiveClubIdState(null)
      localStorage.removeItem(ACTIVE_CLUB_STORAGE_KEY)
    }
  }, [session])

  function setActiveClubId(clubId: string) {
    if (!customerMemberships.some((m) => m.clubId === clubId)) return
    setActiveClubIdState(clubId)
    localStorage.setItem(ACTIVE_CLUB_STORAGE_KEY, clubId)
  }

  const activeMembership = customerMemberships.find((m) => m.clubId === activeClubId) ?? null

  return (
    <PortalClubContext.Provider
      value={{
        customerMemberships,
        isLoading,
        activeClubId,
        activeCustomerId: activeMembership?.customerId ?? null,
        setActiveClubId,
        activeMembership,
        refresh: () => void queryClient.invalidateQueries({ queryKey: ['portal', 'customer-memberships'] }),
      }}
    >
      {children}
    </PortalClubContext.Provider>
  )
}

export function usePortalClub() {
  const ctx = useContext(PortalClubContext)
  if (!ctx) throw new Error('usePortalClub must be used within PortalClubProvider')
  return ctx
}
