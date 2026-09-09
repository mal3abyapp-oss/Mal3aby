import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

// PLATFORM OWNER CONTROL PLANE V1 -- PHASE 17 REGRESSION TESTS.
//
// Covers three structural guarantees from this mission's Phase 7/9/10
// migrations:
//
// 1. PAGINATION STABILITY (20260908190000, Phase 9) --
//    get_platform_club_owners() / get_platform_audit_log() now use
//    `count(*) over ()` for total_count plus a primary-key tiebreaker
//    (membership_id / id) after the previous non-unique timestamp sort
//    column. This suite walks 2-3 real pages at a small page size and
//    asserts: (a) total_count is IDENTICAL across every page, (b) no
//    row id appears on more than one page, and (c) the union of every
//    paginated row id set is IDENTICAL to a single unpaginated fetch at
//    a page size >= total_count -- the exact bug class (skipped or
//    duplicated rows across LIMIT/OFFSET boundaries when the sort key
//    isn't unique) this migration fixed.
//
// 2. TENANT HEALTH TRANSPARENCY (20260908180000, Phase 10) --
//    get_platform_tenant_health() must never return an unexplained
//    WATCH/AT_RISK classification: `reasons` is non-empty whenever
//    health != 'HEALTHY', and HEALTHY rows carry an empty (or at least
//    materially minimal) reasons array.
//
// 3. ATTENTION CENTER SHAPE + AUTHORIZATION (20260908161500, Phase 7) --
//    get_platform_attention_items() never returns more than one row for
//    the same (club_id, problem_type) pair (each of its 9 UNION ALL
//    branches is independently deduped/grouped, but nothing currently
//    stops a future 10th branch from overlapping an existing
//    problem_type for the same club without this guard), and a
//    non-owner, non-platform-staff caller is rejected outright (the P2
//    nav-vs-RPC mismatch class flagged by the Phase 15 security review
//    must never silently regress into an actual open RPC).
//
// Configure via env:
//   VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//   PLATFORM_OWNER_TEST_EMAIL / PLATFORM_OWNER_TEST_PASSWORD
//     (real platform_owner account -- all three RPCs under test here
//     are is_platform_owner()-gated, and get_platform_club_owners()/
//     get_platform_audit_log() specifically require is_platform_owner()
//     with no permission-key alternative)
//   QA_AUDIT_OWNER_EMAIL / QA_AUDIT_OWNER_PASSWORD
//     (reused from staff_role_matrix.integration.test.ts -- a normal
//     club_manager with zero platform access at all, used for the
//     negative authorization check on get_platform_attention_items())
// Skips cleanly without these.

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
const OWNER_EMAIL = import.meta.env.PLATFORM_OWNER_TEST_EMAIL as string | undefined
const OWNER_PASSWORD = import.meta.env.PLATFORM_OWNER_TEST_PASSWORD as string | undefined
const TENANT_EMAIL = import.meta.env.QA_AUDIT_OWNER_EMAIL as string | undefined
const TENANT_PASSWORD = import.meta.env.QA_AUDIT_OWNER_PASSWORD as string | undefined

function makeClient(storageKey: string): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { storageKey, persistSession: true, autoRefreshToken: false },
  })
}

async function signIn(client: SupabaseClient, email: string, password: string) {
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`)
}

const canRunOwner = !!(SUPABASE_URL && SUPABASE_ANON_KEY && OWNER_EMAIL && OWNER_PASSWORD)
const describeIfOwnerConfigured = canRunOwner ? describe : describe.skip

// ---------------------------------------------------------------------
// Generic pagination walker: fetches `pageSize`-sized pages from `rpc`
// with (p_limit, p_offset) style params until a page comes back short
// (fewer rows than pageSize) or a safety cap is hit, then compares
// against one unpaginated fetch at a size >= the reported total_count.
// ---------------------------------------------------------------------
async function walkPages(
  client: SupabaseClient,
  rpcName: string,
  extraParams: Record<string, unknown>,
  limitParamName: string,
  offsetParamName: string,
  idField: string,
  pageSize: number,
) {
  const pages: Array<Array<Record<string, unknown>>> = []
  const totalCounts: number[] = []
  let offset = 0
  const maxPages = 20 // safety cap -- avoids an infinite loop against a misbehaving RPC

  for (let i = 0; i < maxPages; i++) {
    const { data, error } = await client.rpc(rpcName, {
      ...extraParams,
      [limitParamName]: pageSize,
      [offsetParamName]: offset,
    })
    if (error) throw new Error(`${rpcName} page fetch failed at offset ${offset}: ${error.message}`)
    const rows = (data as Array<Record<string, unknown>>) ?? []
    if (rows.length === 0) break
    pages.push(rows)
    totalCounts.push(Number(rows[0]!.total_count))
    offset += pageSize
    if (rows.length < pageSize) break
  }

  const reportedTotal = totalCounts[0] ?? 0

  const { data: fullData, error: fullError } = await client.rpc(rpcName, {
    ...extraParams,
    [limitParamName]: Math.max(reportedTotal, pageSize, 1),
    [offsetParamName]: 0,
  })
  if (fullError) throw new Error(`${rpcName} unpaginated fetch failed: ${fullError.message}`)
  const fullRows = (fullData as Array<Record<string, unknown>>) ?? []

  return {
    pages,
    totalCounts,
    pagedIds: pages.flatMap((page) => page.map((row) => String(row[idField]))),
    fullIds: fullRows.map((row) => String(row[idField])),
  }
}

describeIfOwnerConfigured('get_platform_club_owners() pagination stability (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-owners-pagination-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('total_count is identical across every page, and no membership_id is duplicated or skipped across a full paginated walk vs. a single unpaginated fetch', async () => {
    const { data: probe, error: probeErr } = await client.rpc('get_platform_club_owners', { p_limit: 1, p_offset: 0 })
    expect(probeErr).toBeNull()
    const total = Number(((probe as Array<Record<string, unknown>>) ?? [])[0]?.total_count ?? 0)
    if (total < 2) {
      // Fewer than 2 real owner rows in this QA environment -- the
      // multi-page walk below cannot meaningfully exercise a page
      // boundary. Skip this specific assertion, not the whole suite.
      return
    }

    const pageSize = Math.max(1, Math.floor(total / 3)) || 1
    const result = await walkPages(client, 'get_platform_club_owners', { p_search: null }, 'p_limit', 'p_offset', 'membership_id', pageSize)

    // (a) total_count consistent across every page fetched.
    expect(new Set(result.totalCounts).size).toBe(1)

    // (b) no duplicate id across pages.
    expect(new Set(result.pagedIds).size).toBe(result.pagedIds.length)

    // (c) union of paginated ids matches the unpaginated fetch exactly.
    expect(new Set(result.pagedIds)).toEqual(new Set(result.fullIds))
  })
})

describeIfOwnerConfigured('get_platform_audit_log() pagination stability (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-audit-pagination-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('total_count is identical across every page, and no audit row id is duplicated or skipped across a full paginated walk vs. a single unpaginated fetch', async () => {
    const { data: probe, error: probeErr } = await client.rpc('get_platform_audit_log', { p_limit: 1, p_offset: 0 })
    expect(probeErr).toBeNull()
    const total = Number(((probe as Array<Record<string, unknown>>) ?? [])[0]?.total_count ?? 0)
    if (total < 2) return

    // Cap page size/walk length for a large real audit_logs table (this
    // repo's own migration comment notes 2,197+ rows live) -- 3 pages of
    // a bounded size is enough to prove the tiebreaker fix without
    // walking the entire table every CI run.
    const pageSize = Math.max(1, Math.min(50, Math.ceil(total / 3)))
    const result = await walkPages(client, 'get_platform_audit_log', {}, 'p_limit', 'p_offset', 'id', pageSize)

    expect(new Set(result.totalCounts).size).toBe(1)
    expect(new Set(result.pagedIds).size).toBe(result.pagedIds.length)
    expect(new Set(result.pagedIds)).toEqual(new Set(result.fullIds))
  })
})

describeIfOwnerConfigured('get_platform_tenant_health() -- transparent classification (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-tenant-health-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('every WATCH or AT_RISK row has a non-empty reasons array -- a classification is never returned unexplained', async () => {
    const { data, error } = await client.rpc('get_platform_tenant_health')
    expect(error).toBeNull()
    const rows = (data as Array<{ club_id: string; health: string; reasons: string[] | null }>) ?? []
    const nonHealthy = rows.filter((r) => r.health === 'WATCH' || r.health === 'AT_RISK')
    for (const row of nonHealthy) {
      expect(Array.isArray(row.reasons)).toBe(true)
      expect((row.reasons ?? []).length).toBeGreaterThan(0)
    }
  })

  it('every HEALTHY row has an empty (or minimal) reasons array -- a healthy tenant is never carrying unexplained WATCH-worthy signals', async () => {
    const { data, error } = await client.rpc('get_platform_tenant_health')
    expect(error).toBeNull()
    const rows = (data as Array<{ club_id: string; health: string; reasons: string[] | null }>) ?? []
    const healthy = rows.filter((r) => r.health === 'HEALTHY')
    for (const row of healthy) {
      expect((row.reasons ?? []).length).toBe(0)
    }
  })

  it('health is always exactly one of HEALTHY/WATCH/AT_RISK -- never null, never a free-form score', async () => {
    const { data, error } = await client.rpc('get_platform_tenant_health')
    expect(error).toBeNull()
    const rows = (data as Array<{ health: string }>) ?? []
    for (const row of rows) {
      expect(['HEALTHY', 'WATCH', 'AT_RISK']).toContain(row.health)
    }
  })

  it('one row per real (non-fixture) club -- no club_id is duplicated', async () => {
    const { data, error } = await client.rpc('get_platform_tenant_health')
    expect(error).toBeNull()
    const rows = (data as Array<{ club_id: string }>) ?? []
    const ids = rows.map((r) => r.club_id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describeIfOwnerConfigured('get_platform_attention_items() -- one row per (club, problem) pair (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-owner-attention-shape-auth-token')
    await signIn(client, OWNER_EMAIL!, OWNER_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('never returns more than one row for the same (club_id, problem_type) pair, across all 9 condition branches', async () => {
    const { data, error } = await client.rpc('get_platform_attention_items')
    expect(error).toBeNull()
    const rows = (data as Array<{ club_id: string; problem_type: string }>) ?? []
    const pairKey = (r: { club_id: string; problem_type: string }) => `${r.club_id}::${r.problem_type}`
    const keys = rows.map(pairKey)
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i)
    expect(dupes).toEqual([])
  })

  it('every row carries a non-null club_id -- the frontend must always be able to resolve straight to Tenant 360, never a generic unfiltered list', async () => {
    const { data, error } = await client.rpc('get_platform_attention_items')
    expect(error).toBeNull()
    const rows = (data as Array<{ club_id: string | null }>) ?? []
    for (const row of rows) {
      expect(row.club_id).toBeTruthy()
    }
  })

  it('severity is always exactly "danger" or "warning" (fixed severity ordering, never a composite score)', async () => {
    const { data, error } = await client.rpc('get_platform_attention_items')
    expect(error).toBeNull()
    const rows = (data as Array<{ severity: string }>) ?? []
    for (const row of rows) {
      expect(['danger', 'warning']).toContain(row.severity)
    }
  })
})

// ---- Negative authorization check -- non-owner caller must be rejected ----
const canRunTenant = !!(SUPABASE_URL && SUPABASE_ANON_KEY && TENANT_EMAIL && TENANT_PASSWORD)
const describeIfTenantConfigured = canRunTenant ? describe : describe.skip

describeIfTenantConfigured('get_platform_attention_items() -- authorization boundary (live integration)', () => {
  let client: SupabaseClient

  beforeAll(async () => {
    client = makeClient('sb-platform-tenant-attention-auth-token')
    await signIn(client, TENANT_EMAIL!, TENANT_PASSWORD!)
  })

  afterAll(async () => {
    await client.auth.signOut()
  })

  it('a normal club_manager with zero platform access is rejected server-side, not merely hidden by frontend nav (regression guard against the P2 nav-vs-RPC mismatch getting worse, or silently opening to non-owners)', async () => {
    const { data, error } = await client.rpc('get_platform_attention_items')
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
    expect(data).toBeNull()
  })
})

const describeIfTenantAndOwnerConfigured = canRunTenant && canRunOwner ? describe : describe.skip

describeIfTenantAndOwnerConfigured('get_platform_club_owners() / get_platform_audit_log() -- authorization boundary (live integration)', () => {
  let tenantClient: SupabaseClient

  beforeAll(async () => {
    tenantClient = makeClient('sb-platform-tenant-owners-audit-auth-token')
    await signIn(tenantClient, TENANT_EMAIL!, TENANT_PASSWORD!)
  })

  afterAll(async () => {
    await tenantClient.auth.signOut()
  })

  it('a normal club_manager cannot call get_platform_club_owners()', async () => {
    const { error } = await tenantClient.rpc('get_platform_club_owners', { p_limit: 1, p_offset: 0 })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })

  it('a normal club_manager cannot call get_platform_audit_log()', async () => {
    const { error } = await tenantClient.rpc('get_platform_audit_log', { p_limit: 1, p_offset: 0 })
    expect(error).toBeTruthy()
    expect(error!.message.toLowerCase()).toContain('not authorized')
  })
})
