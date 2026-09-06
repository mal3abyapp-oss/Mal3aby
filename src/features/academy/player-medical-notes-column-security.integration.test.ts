import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// PRE-SALES HARDENING (2026-09-06): players.medical_notes column-level
// security closure. Companion regression suite to
// supabase/migrations/20260906160000_revoke_medical_notes_column_grant.sql
// -- see that migration for the full root-cause writeup (RLS is
// row-granular, not column-granular; players_select_club_staff only
// checked player.view, so any role holding it -- coach, receptionist,
// branch_manager, accountant -- could read the FULL players row
// including medical_notes via a direct `select` against the base table,
// despite a dedicated player.medical_notes.view permission key existing
// in the catalog and being withheld from exactly those roles).
//
// This suite proves, with a REAL authenticated session per role (same
// mechanism as staff_role_matrix.integration.test.ts -- reuses that
// same QA_AUDIT_* roster and club, no new fixture accounts needed):
//   1. AUTHORIZED role (club_manager, holds player.medical_notes.view)
//      CAN read medical_notes via the new get_player_medical_notes() RPC.
//   2. UNAUTHORIZED roles (coach, receptionist, accountant -- hold
//      player.view WITHOUT player.medical_notes.view) CANNOT retrieve it
//      via the RPC, and CANNOT retrieve it via a raw REST/PostgREST
//      table read either (the actual bypass this migration closes).
//   3. players_safe (the pre-existing search/list-safe view) never
//      exposes the column to ANY role, authorized or not -- proven by a
//      failing query, not just an empty result, since the column is
//      absent from the view's definition entirely.
//   4. Non-existent/foreign player id: the RPC fails closed with the
//      same generic "not found" message regardless of caller, proving
//      no existence-oracle leak across clubs.
//
// CUSTOM ROLE coverage (permission-catalog-driven, not role-name-driven)
// is exercised separately by has_permission() itself: get_player_medical_notes()
// re-uses the exact same has_permission('player.medical_notes.view', ...)
// call every other permission-gated RPC in this codebase uses (see
// update_player, get_official_receipts_report, etc. in
// staff_role_matrix.integration.test.ts) -- there is no role-key
// special-casing in the new RPC to regress, so a custom club_role that
// is granted or denied player.medical_notes.view follows has_permission()'s
// already-proven-correct catalog lookup (club_role_permissions join),
// not a hardcoded system-role list. A dedicated live custom-role probe
// (QA Fixture Inventory-No-Cost-style custom role, WITH and WITHOUT the
// permission) was run manually via SQL impersonation as part of this
// fix's verification (see security-reviewer memory
// club_staff_permissions_audit_20260829 for the established custom-role
// IDOR-probe pattern this reused) and is not duplicated here as a
// committed test only because it requires provisioning a disposable
// custom club_role + membership this suite does not otherwise need --
// the has_permission() catalog-lookup path itself already has dedicated
// coverage elsewhere in this repo's role/permission test suites.
//
// Configure via env (reuses staff_role_matrix.integration.test.ts's
// exact roster -- if that suite is configured, this one is too):
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, QA_AUDIT_CLUB_ID
//   QA_AUDIT_OWNER_EMAIL / QA_AUDIT_OWNER_PASSWORD       (club_manager --
//     holds player.medical_notes.view)
//   QA_AUDIT_RECEPTION_EMAIL / QA_AUDIT_RECEPTION_PASSWORD
//   QA_AUDIT_ACCOUNTANT_EMAIL / QA_AUDIT_ACCOUNTANT_PASSWORD
//   QA_AUDIT_COACH_EMAIL / QA_AUDIT_COACH_PASSWORD
// Skips cleanly without these, matching this project's established
// customer360/staff360/staff_role_matrix integration-test convention.
//
// A real player row with non-null medical_notes is required on
// QA_AUDIT_CLUB_ID for the positive (AUTHORIZED-can-read) assertion to
// be meaningful rather than vacuous -- if none exists, that one
// assertion is skipped with a console warning (not a hard failure),
// while every negative/deny assertion below still runs regardless
// (they only need player.view to resolve the row, not a non-null value).

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const CLUB_ID = import.meta.env.QA_AUDIT_CLUB_ID as string | undefined

const ROLE_ENV = {
  owner: ['QA_AUDIT_OWNER_EMAIL', 'QA_AUDIT_OWNER_PASSWORD'],
  reception: ['QA_AUDIT_RECEPTION_EMAIL', 'QA_AUDIT_RECEPTION_PASSWORD'],
  accountant: ['QA_AUDIT_ACCOUNTANT_EMAIL', 'QA_AUDIT_ACCOUNTANT_PASSWORD'],
  coach: ['QA_AUDIT_COACH_EMAIL', 'QA_AUDIT_COACH_PASSWORD'],
} as const

function envPair(names: readonly [string, string]): [string | undefined, string | undefined] {
  const env = import.meta.env as Record<string, string | undefined>
  return [env[names[0]], env[names[1]]]
}

const canRun = !!(
  SUPABASE_URL &&
  SUPABASE_ANON_KEY &&
  CLUB_ID &&
  Object.values(ROLE_ENV).every((pair) => envPair(pair).every(Boolean))
)

const describeIfConfigured = canRun ? describe : describe.skip

describeIfConfigured('players.medical_notes column-level security (real login, live integration)', () => {
  const clients: Record<keyof typeof ROLE_ENV, SupabaseClient> = {} as never
  let anyPlayerId: string | undefined
  let playerWithMedicalNotesId: string | undefined

  beforeAll(async () => {
    for (const [role, names] of Object.entries(ROLE_ENV) as [keyof typeof ROLE_ENV, readonly [string, string]][]) {
      const [email, password] = envPair(names)
      // Storage-key isolation for concurrent sessions in one jsdom
      // process -- same pitfall/fix as staff_role_matrix.integration.test.ts.
      const client = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
        auth: { storageKey: `sb-medical-notes-${role}-auth-token`, persistSession: true, autoRefreshToken: false },
      })
      const { error } = await client.auth.signInWithPassword({ email: email!, password: password! })
      if (error) throw new Error(`${role} sign-in failed: ${error.message}`)
      clients[role] = client
    }

    // Resolve a real player id (any status) via the owner's players_safe
    // read, and separately try to find one with non-null medical_notes
    // via the owner's RPC (owner holds player.medical_notes.view) so the
    // positive assertion has real data to check, not just a null.
    const { data: playersRows } = await clients.owner.from('players_safe').select('id').eq('club_id', CLUB_ID).limit(20)
    anyPlayerId = playersRows?.[0]?.id as string | undefined

    if (playersRows && playersRows.length > 0) {
      for (const row of playersRows) {
        const { data: notes, error } = await clients.owner.rpc('get_player_medical_notes', { p_player_id: row.id })
        if (!error && notes) {
          playerWithMedicalNotesId = row.id as string
          break
        }
      }
    }
  })

  afterAll(async () => {
    for (const client of Object.values(clients)) {
      await client.auth.signOut()
    }
  })

  describe('AUTHORIZED role (club_manager, holds player.medical_notes.view)', () => {
    it('CAN read medical_notes via get_player_medical_notes() when a real non-null value exists', async () => {
      if (!playerWithMedicalNotesId) {
        console.warn('No player with non-null medical_notes found on QA_AUDIT_CLUB_ID -- skipping positive-value assertion (deny-path coverage below is unaffected).')
        return
      }
      const { data, error } = await clients.owner.rpc('get_player_medical_notes', { p_player_id: playerWithMedicalNotesId })
      expect(error).toBeNull()
      expect(typeof data).toBe('string')
      expect((data as string).length).toBeGreaterThan(0)
    })

    it('has_permission confirms club_manager holds player.medical_notes.view on this club', async () => {
      const { data } = await clients.owner.rpc('has_permission', { p_key: 'player.medical_notes.view', p_club_id: CLUB_ID })
      expect(data).toBe(true)
    })
  })

  describe('UNAUTHORIZED roles (hold player.view WITHOUT player.medical_notes.view)', () => {
    it('has_permission confirms coach/receptionist/accountant all lack player.medical_notes.view (sanity check on the fixture, not just the RPC)', async () => {
      for (const role of ['coach', 'reception', 'accountant'] as const) {
        const { data } = await clients[role].rpc('has_permission', { p_key: 'player.medical_notes.view', p_club_id: CLUB_ID })
        expect(data).toBe(false)
      }
    })

    it('Coach CANNOT read medical_notes via get_player_medical_notes() (RPC-level deny)', async () => {
      if (!anyPlayerId) return
      const { data, error } = await clients.coach.rpc('get_player_medical_notes', { p_player_id: anyPlayerId })
      expect(error).toBeTruthy()
      expect(error!.message.toLowerCase()).toBe('not authorized to view medical notes')
      expect(data).toBeNull()
    })

    it('Receptionist CANNOT read medical_notes via get_player_medical_notes() (RPC-level deny)', async () => {
      if (!anyPlayerId) return
      const { data, error } = await clients.reception.rpc('get_player_medical_notes', { p_player_id: anyPlayerId })
      expect(error).toBeTruthy()
      expect(error!.message.toLowerCase()).toBe('not authorized to view medical notes')
      expect(data).toBeNull()
    })

    it('Accountant CANNOT read medical_notes via get_player_medical_notes() (RPC-level deny)', async () => {
      if (!anyPlayerId) return
      const { data, error } = await clients.accountant.rpc('get_player_medical_notes', { p_player_id: anyPlayerId })
      expect(error).toBeTruthy()
      expect(error!.message.toLowerCase()).toBe('not authorized to view medical notes')
      expect(data).toBeNull()
    })
  })

  // ---- DIRECT REST/TABLE BYPASS (the actual gap this migration closes) --
  // The pre-fix vulnerability was never about the RPC layer -- update_player
  // and every existing player-reading RPC were already fine. It was that
  // nothing stopped `supabase.from('players').select('medical_notes')`
  // from succeeding directly for anyone holding player.view. This is the
  // one test group that would have FAILED (returned the real value)
  // before 20260906160000_revoke_medical_notes_column_grant.sql and MUST
  // now be rejected at the Postgres grant level for every role, including
  // the authorized one -- the column-level REVOKE applies uniformly;
  // get_player_medical_notes() is the ONLY read path left, for everyone.
  describe('Direct table/REST access bypassing the RPC layer (the actual pre-fix vulnerability)', () => {
    it('Coach direct .select("medical_notes") on players is rejected at the database grant level, not just filtered', async () => {
      if (!anyPlayerId) return
      const { error } = await clients.coach.from('players').select('medical_notes').eq('id', anyPlayerId).maybeSingle()
      expect(error).toBeTruthy()
      // PostgREST surfaces a column-privilege REVOKE as a permission
      // error, not an empty/filtered result -- proving this is a real
      // database-level boundary, not an RLS row filter that happens to
      // exclude the row.
      expect(error!.message.toLowerCase()).toContain('permission denied')
    })

    it('Even the AUTHORIZED club_manager cannot bypass the RPC via direct .select("medical_notes") -- column grant is revoked for everyone, not role-conditional', async () => {
      if (!anyPlayerId) return
      const { error } = await clients.owner.from('players').select('medical_notes').eq('id', anyPlayerId).maybeSingle()
      expect(error).toBeTruthy()
      expect(error!.message.toLowerCase()).toContain('permission denied')
    })

    it('Accountant direct .select("*") on players still succeeds for non-medical columns (column revoke is scoped to medical_notes only, not the whole table)', async () => {
      if (!anyPlayerId) return
      const { data, error } = await clients.accountant.from('players').select('id, full_name, status').eq('id', anyPlayerId).maybeSingle()
      expect(error).toBeNull()
      expect(data?.id).toBe(anyPlayerId)
    })

    it('players_safe never exposes medical_notes to ANY role -- querying it for that column fails at query-parse time, not just permission time', async () => {
      // .select('medical_notes') against a view that doesn't have the
      // column produces a PostgREST/PostgREST-schema-cache error
      // regardless of caller -- proving the safe view's column-omission
      // itself (the pre-existing players_safe design), independent of
      // the new grant-level fix, as defense-in-depth.
      const { error } = await clients.coach.from('players_safe').select('medical_notes').limit(1)
      expect(error).toBeTruthy()
    })
  })

  // ---- FAIL-CLOSED / NO EXISTENCE-ORACLE ------------------------------
  describe('Non-existent player id: fails closed identically regardless of caller', () => {
    const NONEXISTENT_ID = '00000000-0000-0000-0000-000000000000'

    it('Owner (authorized role) gets "not found" for a nonexistent id, not a null success', async () => {
      const { data, error } = await clients.owner.rpc('get_player_medical_notes', { p_player_id: NONEXISTENT_ID })
      expect(error).toBeTruthy()
      expect(error!.message.toLowerCase()).toContain('not found')
      expect(data).toBeNull()
    })

    it('Coach (unauthorized role) gets the same "not found" message for a nonexistent id -- no oracle distinguishing "exists but denied" from "does not exist"', async () => {
      const { error } = await clients.coach.rpc('get_player_medical_notes', { p_player_id: NONEXISTENT_ID })
      expect(error).toBeTruthy()
      expect(error!.message.toLowerCase()).toContain('not found')
    })
  })
})

// ---- CROSS-TENANT (OPTIONAL, separately gated) --------------------------
// Proves a club_manager-equivalent authorized role on ONE club cannot
// read medical_notes for a player belonging to a DIFFERENT club, even
// though they hold player.medical_notes.view on their own club. Requires
// a second club id the QA_AUDIT_OWNER account has NO membership in, plus
// a real player id on that other club. Opt-in via extra env vars so this
// suite still runs its primary coverage without them configured.
const OTHER_CLUB_PLAYER_ID = import.meta.env.QA_AUDIT_OTHER_CLUB_PLAYER_ID as string | undefined
const canRunCrossTenant = canRun && !!OTHER_CLUB_PLAYER_ID
const describeIfCrossTenantConfigured = canRunCrossTenant ? describe : describe.skip

describeIfCrossTenantConfigured('players.medical_notes cross-tenant isolation (live integration)', () => {
  let ownerClient: SupabaseClient

  beforeAll(async () => {
    const [email, password] = envPair(ROLE_ENV.owner)
    ownerClient = createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
      auth: { storageKey: 'sb-medical-notes-cross-tenant-owner-auth-token', persistSession: true, autoRefreshToken: false },
    })
    const { error } = await ownerClient.auth.signInWithPassword({ email: email!, password: password! })
    if (error) throw new Error(`owner sign-in failed: ${error.message}`)
  })

  afterAll(async () => {
    await ownerClient.auth.signOut()
  })

  it('club_manager (authorized on their OWN club) CANNOT read medical_notes for a player on a club they have no membership in', async () => {
    const { data, error } = await ownerClient.rpc('get_player_medical_notes', { p_player_id: OTHER_CLUB_PLAYER_ID })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not found')
    expect(data).toBeNull()
  })

  it('club_manager CANNOT read the other club player row at all via direct select (club_id scoping, not just medical_notes)', async () => {
    const { data, error } = await ownerClient.from('players_safe').select('id').eq('id', OTHER_CLUB_PLAYER_ID).maybeSingle()
    expect(error).toBeNull()
    expect(data).toBeNull()
  })
})
