import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase/client'
import type { ActiveMembership } from '@/lib/domain/membership'

// Auth + multi-tenant session context. Loads the caller's own active
// club_memberships (RLS-scoped to auth.uid() automatically — see
// club_memberships_select_own policy) and lets the app pick a current club.
// Never trust anything here as an authorization decision by itself: every
// server call is still gated by RLS/SECURITY DEFINER checks (docs/SECURITY_ANTI_FRAUD.md).

// MASTER ADMIN / PLATFORM SUPPORT CONTEXT (2026-08-26): a platform_owner
// has no real club_memberships row for an arbitrary club they don't
// independently belong to -- reusing the existing /app shell for support
// mode (directive Section 17: "reuse the normal club UI... do NOT
// duplicate an entire separate management UI") means currentClubId/
// currentMembership must be able to resolve to the SUPPORTED club while
// a session is active, without ever touching the real
// club_memberships-backed `memberships` array above (a platform_owner's
// own real memberships, if any, stay completely separate and unaffected).
//
// get_my_active_support_session() is the SERVER-VERIFIED source of
// truth (directive Section 15: never trust localStorage alone) --
// polled on mount/auth-change same as loadMemberships(), and again on
// every route change via refreshSupportSession() (called from
// RequireAuth.tsx) so an expired/ended session can never leave a stale
// "you have access" UI state. localStorage is used ONLY as a same-tab
// fast-path hint to avoid a one-frame flash of "no session" while the
// RPC round-trip is in flight -- the RPC result always overwrites it.
export interface SupportSession {
  id: string
  clubId: string
  clubName: string
  mode: 'view' | 'manage'
  reason: string | null
  startedAt: string
  expiresAt: string
}

interface AuthContextValue {
  session: Session | null
  loading: boolean
  memberships: ActiveMembership[]
  isPlatformOwner: boolean
  currentClubId: string | null
  setCurrentClubId: (clubId: string) => void
  currentMembership: ActiveMembership | null
  refreshMemberships: () => Promise<void>
  signOut: () => Promise<void>
  supportSession: SupportSession | null
  startSupportSession: (clubId: string, mode: 'view' | 'manage', reason?: string) => Promise<void>
  endSupportSession: () => Promise<void>
  refreshSupportSession: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined)

const CURRENT_CLUB_STORAGE_KEY = 'mala3by.currentClubId'
const SUPPORT_SESSION_HINT_KEY = 'mala3by.supportSessionHint'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const [memberships, setMemberships] = useState<ActiveMembership[]>([])
  const [isPlatformOwner, setIsPlatformOwner] = useState(false)
  const [currentClubId, setCurrentClubIdState] = useState<string | null>(null)
  const [supportSession, setSupportSession] = useState<SupportSession | null>(() => {
    // Same-tab fast-path hint only -- see the class-level comment above.
    // Always overwritten by refreshSupportSession()'s real RPC result
    // before any authorization-sensitive UI can act on it.
    try {
      const raw = localStorage.getItem(SUPPORT_SESSION_HINT_KEY)
      return raw ? (JSON.parse(raw) as SupportSession) : null
    } catch {
      return null
    }
  })
  // The platform_owner's own club, permission set for the CURRENTLY
  // active support session's club -- fetched separately from the normal
  // club_memberships-backed permissionKeys above, via the exact same
  // caller_permission_keys() RPC (already widened server-side to return
  // every permission key while has_platform_support_access(club_id, true)
  // is true), so nav visibility/route guards see a real, server-computed
  // capability set for the supported club instead of an empty one.
  const [supportPermissionKeys, setSupportPermissionKeys] = useState<string[]>([])

  async function refreshSupportSession() {
    const { data: userData } = await supabase.auth.getUser()
    if (!userData.user) {
      setSupportSession(null)
      setSupportPermissionKeys([])
      localStorage.removeItem(SUPPORT_SESSION_HINT_KEY)
      return
    }
    const { data, error } = await supabase.rpc('get_my_active_support_session')
    const row = !error && data?.[0] ? data[0] : null
    if (!row) {
      setSupportSession(null)
      setSupportPermissionKeys([])
      localStorage.removeItem(SUPPORT_SESSION_HINT_KEY)
      return
    }
    const next: SupportSession = {
      id: row.id,
      clubId: row.club_id,
      clubName: row.club_name_ar,
      mode: row.mode as 'view' | 'manage',
      reason: row.reason,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
    }
    setSupportSession(next)
    localStorage.setItem(SUPPORT_SESSION_HINT_KEY, JSON.stringify(next))

    const { data: keys } = await supabase.rpc('caller_permission_keys', { p_club_id: next.clubId })
    setSupportPermissionKeys((keys ?? []).map((k: { key: string } | string) => (typeof k === 'string' ? k : k.key)))
  }

  async function startSupportSession(clubId: string, mode: 'view' | 'manage', reason?: string) {
    const { error } = await supabase.rpc('start_platform_support_session', {
      p_club_id: clubId,
      p_mode: mode,
      p_reason: reason,
    })
    if (error) throw error
    await refreshSupportSession()
  }

  async function endSupportSession() {
    const { error } = await supabase.rpc('end_platform_support_session')
    if (error) throw error
    setSupportSession(null)
    setSupportPermissionKeys([])
    localStorage.removeItem(SUPPORT_SESSION_HINT_KEY)
  }

  async function loadMemberships() {
    const { data: userData } = await supabase.auth.getUser()
    const uid = userData.user?.id
    if (!uid) {
      setMemberships([])
      return
    }

    // Bug found during stabilization pass (2026-08-16): club_memberships'
    // RLS has an ALL-command policy granting platform_owner full access
    // to every membership row in the database (by design, for /platform
    // admin screens). Without this explicit .eq('user_id', uid), a
    // platform_owner's ordinary "load my own memberships" query silently
    // rides along on that grant and returns every OTHER user's membership
    // rows too -- surfacing other real tenants' club names and letting
    // the club-switcher "become" another club's real owner in the UI
    // (RLS still correctly blocks any actual write there, since
    // has_permission()/user_club_ids() are separately keyed on this
    // session's own auth.uid() -- but the read-leak and the misleading
    // "you are Club Owner here" UI state are real bugs on their own).
    // STAFF ACCESS CONTROL & CUSTOM ROLES (2026-08-25): a membership now
    // has EITHER roles (system role) OR club_roles (custom role) set --
    // the previous `.filter(row => row.clubs && row.roles)` silently
    // dropped every custom-role membership from the whole app (club
    // switcher, nav, everything), since `roles` is null by design for
    // those rows. Embed both and require only `clubs` plus one of the
    // two role relations.
    const { data, error } = await supabase
      .from('club_memberships')
      .select(
        'id, club_id, status, clubs(name, name_ar), roles(key, name, name_ar), club_roles(id, name_en, name_ar)',
      )
      .eq('status', 'active')
      .eq('user_id', uid)

    if (error || !data) {
      setMemberships([])
      return
    }

    // Real, server-computed permission keys per club this user belongs
    // to -- this is what nav visibility and route guards must key off
    // of (see navigation.ts), since a custom role has no roleKey a
    // hand-maintained map could ever recognize. One RPC call per
    // distinct club (never per-row inside a render loop).
    const clubIds = Array.from(new Set(data.map((row) => row.club_id)))
    const permissionsByClub = new Map<string, string[]>()
    await Promise.all(
      clubIds.map(async (clubId) => {
        const { data: keys } = await supabase.rpc('caller_permission_keys', { p_club_id: clubId })
        permissionsByClub.set(clubId, (keys ?? []).map((k: { key: string } | string) => (typeof k === 'string' ? k : k.key)))
      }),
    )

    const allRows: ActiveMembership[] = data
      .filter((row) => row.clubs && (row.roles || row.club_roles))
      .map((row) => {
        const systemRole = row.roles as unknown as { key: string; name: string; name_ar: string } | null
        const customRole = row.club_roles as unknown as { id: string; name_en: string; name_ar: string } | null
        return {
          membershipId: row.id,
          clubId: row.club_id,
          clubName: (row.clubs as unknown as { name: string }).name,
          clubNameAr: (row.clubs as unknown as { name_ar: string }).name_ar,
          roleKey: systemRole?.key ?? null,
          roleName: systemRole?.name ?? customRole?.name_en ?? '',
          roleNameAr: systemRole?.name_ar ?? customRole?.name_ar ?? '',
          customRoleId: customRole?.id ?? null,
          permissionKeys: permissionsByClub.get(row.club_id) ?? [],
        }
      })

    // isPlatformOwner is tracked independently of the deduped list below --
    // never let it depend on which row "won" a same-club collision.
    setIsPlatformOwner(allRows.some((row) => row.roleKey === 'platform_owner'))

    // A single account can hold two membership rows on the same club (e.g.
    // platform_owner's own club_owner row plus a separately-seeded
    // platform_owner row -- both real, per docs/RLS_MATRIX.md's club_id
    // being incidental to platform_owner's actual global authority). The
    // club-switcher should still only ever offer one entry per club --
    // dedupe by clubId, preferring the more operationally-specific role
    // (i.e. not platform_owner) so the switcher shows the role that
    // actually governs day-to-day access to that club.
    const byClub = new Map<string, ActiveMembership>()
    for (const row of allRows) {
      const existing = byClub.get(row.clubId)
      if (!existing || existing.roleKey === 'platform_owner') {
        byClub.set(row.clubId, row)
      }
    }
    const rows = Array.from(byClub.values())

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
        await refreshSupportSession()
      }
      setLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange(async (_event, newSession) => {
      if (!mounted) return
      setSession(newSession)
      if (newSession) {
        await loadMemberships()
        await refreshSupportSession()
      } else {
        setMemberships([])
        setIsPlatformOwner(false)
        setCurrentClubIdState(null)
        localStorage.removeItem(CURRENT_CLUB_STORAGE_KEY)
        setSupportSession(null)
        setSupportPermissionKeys([])
        localStorage.removeItem(SUPPORT_SESSION_HINT_KEY)
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

  // MASTER ADMIN / PLATFORM SUPPORT CONTEXT: this is the single override
  // point that makes "reuse the existing /app shell" actually work
  // (directive Section 17). When a support session is active,
  // currentClubId resolves to the SUPPORTED club rather than the
  // platform_owner's own incidental club_memberships row, and
  // currentMembership is synthesized from the session + the real,
  // server-computed supportPermissionKeys (via caller_permission_keys(),
  // already widened server-side) -- never a client-invented permission
  // set. This takes priority over the platform_owner's own real
  // memberships (if any) while a session is active, matching the
  // product intent: entering support mode means "I am now working on
  // this club", not "in addition to my own club". A platform_owner with
  // no support session and no real memberships of their own sees
  // currentClubId/currentMembership as null, exactly as before this
  // feature existed.
  const effectiveCurrentClubId = supportSession ? supportSession.clubId : currentClubId
  const effectiveCurrentMembership: ActiveMembership | null = supportSession
    ? {
        membershipId: `support:${supportSession.id}`,
        clubId: supportSession.clubId,
        clubName: supportSession.clubName,
        clubNameAr: supportSession.clubName,
        roleKey: null,
        roleName: 'Platform Support',
        roleNameAr: 'دعم فني من المنصة',
        customRoleId: null,
        permissionKeys: supportPermissionKeys,
      }
    : (memberships.find((m) => m.clubId === currentClubId) ?? null)

  return (
    <AuthContext.Provider
      value={{
        session,
        loading,
        memberships,
        isPlatformOwner,
        currentClubId: effectiveCurrentClubId,
        setCurrentClubId,
        currentMembership: effectiveCurrentMembership,
        refreshMemberships: loadMemberships,
        signOut,
        supportSession,
        startSupportSession,
        endSupportSession,
        refreshSupportSession,
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
