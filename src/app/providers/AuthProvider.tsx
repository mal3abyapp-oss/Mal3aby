import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import type { ActiveMembership } from '@/lib/domain/membership'

// Auth + multi-tenant session context. Loads the caller's own active
// club_memberships (RLS-scoped to auth.uid() automatically — see
// club_memberships_select_own policy) and lets the app pick a current club.
// Never trust anything here as an authorization decision by itself: every
// server call is still gated by RLS/SECURITY DEFINER checks (docs/SECURITY_ANTI_FRAUD.md).

interface AuthContextValue {
  session: Session | null
  loading: boolean
  memberships: ActiveMembership[]
  currentClubId: string | null
  setCurrentClubId: (clubId: string) => void
  currentMembership: ActiveMembership | null
  refreshMemberships: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

const CURRENT_CLUB_STORAGE_KEY = 'mala3by.currentClubId'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [memberships, setMemberships] = useState<ActiveMembership[]>([])
  const [currentClubId, setCurrentClubIdState] = useState<string | null>(null)

  async function loadMemberships() {
    const { data, error } = await supabase
      .from('club_memberships')
      .select('id, club_id, status, clubs(name, name_ar), roles(key, name, name_ar)')
      .eq('status', 'active')

    if (error || !data) {
      setMemberships([])
      return
    }

    const rows: ActiveMembership[] = data
      .filter((row) => row.clubs && row.roles)
      .map((row) => ({
        membershipId: row.id,
        clubId: row.club_id,
        clubName: (row.clubs as unknown as { name: string }).name,
        clubNameAr: (row.clubs as unknown as { name_ar: string }).name_ar,
        roleKey: (row.roles as unknown as { key: string }).key,
        roleName: (row.roles as unknown as { name: string }).name,
        roleNameAr: (row.roles as unknown as { name_ar: string }).name_ar,
      }))

    setMemberships(rows)

    const stored = localStorage.getItem(CURRENT_CLUB_STORAGE_KEY)
    const validStored = rows.find((m) => m.clubId === stored)
    if (validStored) {
      setCurrentClubIdState(validStored.clubId)
    } else if (rows.length > 0) {
      setCurrentClubIdState(rows[0]!.clubId)
      localStorage.setItem(CURRENT_CLUB_STORAGE_KEY, rows[0]!.clubId)
    } else {
      setCurrentClubIdState(null)
    }
  }

  useEffect(() => {
    let mounted = true

    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return
      setSession(data.session)
      if (data.session) {
        await loadMemberships()
      }
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      if (!mounted) return
      setSession(newSession)
      if (newSession) {
        await loadMemberships()
      } else {
        setMemberships([])
        setCurrentClubIdState(null)
        localStorage.removeItem(CURRENT_CLUB_STORAGE_KEY)
      }
    })

    return () => {
      mounted = false
      listener.subscription.unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function setCurrentClubId(clubId: string) {
    setCurrentClubIdState(clubId)
    localStorage.setItem(CURRENT_CLUB_STORAGE_KEY, clubId)
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  const currentMembership = memberships.find((m) => m.clubId === currentClubId) ?? null

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        memberships,
        currentClubId,
        setCurrentClubId,
        currentMembership,
        refreshMemberships: loadMemberships,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
