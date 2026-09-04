// sales-activate-tenant-owner -- PHASE 14 (ADR-054 final decision):
// INVITE-BASED OWNER ACTIVATION for Sales Intelligence lead conversion.
//
// Mirrors activate-portal-account's proven shape exactly (re-read in
// full before writing this), with one deliberate structural difference
// explained below.
//
// Deployed with verify_jwt=false -- same reasoning as activate-portal-
// account: this is the first entrypoint an unauthenticated prospect
// reaches, holding only the opaque invite token, no session yet.
//
// WHY THIS EDGE FUNCTION EXISTS: identical reasoning to activate-portal-
// account -- client-side supabase.auth.signUp() would hit this
// project's live outbound-email confirmation rate limit. Account
// creation happens server-side via auth.admin.createUser(...,
// { email_confirm: true }), zero additional cost, matching this
// project's own established convention.
//
// THE STRUCTURAL DIFFERENCE FROM activate-portal-account: portal_invites'
// Edge Function performs the FULL link (claim_portal_invite_service)
// server-side, because linking a customer row to a user_id is a plain
// UPDATE that a service-role RPC can safely do with an explicit
// p_user_id parameter. Tenant conversion is different in kind:
// complete_new_club_onboarding() is deliberately auth.uid()-only (it
// creates the clubs/branches/club_memberships rows AS the calling
// identity) -- there is no safe, correct way to run the actual
// onboarding step from a service-role context with an explicit "act as
// this other user" parameter without either (a) making the platform
// owner's own account the club owner (the exact defect ADR-054
// documents as a TRUE STOP), or (b) inventing a parallel onboarding
// implementation (explicitly prohibited by the user's mandate). So this
// function does ONLY the minimum service-role-required step -- creating
// the pre-confirmed auth identity -- and returns success with NO
// session and NO onboarding yet. The frontend then performs an
// ORDINARY supabase.auth.signInWithPassword() (exactly like
// ActivateAccountPage.tsx already does), and only THEN, under the
// prospect's own real session, calls claim_sales_activation_invite()
// (authenticated-role RPC), which is the one and only place that ever
// invokes complete_new_club_onboarding() -- reusing it completely
// unmodified, per the mandatory "do not duplicate onboarding logic"
// rule, and always under the prospect's own identity, never the
// platform owner's.
//
// This function does NOT trust anything from the client except the raw
// invite token and the prospect-chosen email/password -- the invite's
// own state (pending/unexpired/both factors verified) is re-validated
// here before ever calling auth.admin.createUser(), exactly mirroring
// activate-portal-account's own pre-check discipline, so no orphan auth
// user is created for a request that could never have succeeded anyway.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  })
}

// Mirrors encode(extensions.digest(x, 'sha256'), 'hex') exactly.
async function sha256Hex(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }

  let body: { raw_token?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid request body' }, 400)
  }

  const { raw_token: rawToken, password } = body

  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 32) {
    return jsonResponse({ error: 'invalid invite link' }, 400)
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return jsonResponse({ error: 'password must be at least 8 characters' }, 400)
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // Re-validate the invite is genuinely claimable BEFORE creating any
  // auth user -- avoids an orphan account for a request that could
  // never succeed anyway. The email itself is read from the invite row
  // server-side (never trusted from the client) -- this function never
  // accepts an email parameter at all, closing off any possibility of
  // creating an identity for an email the prospect doesn't actually
  // control on this invite.
  const { data: contextRows, error: contextError } = await admin.rpc('get_sales_activation_invite_context', { p_raw_token: rawToken })
  if (contextError || !contextRows || contextRows.length === 0) {
    return jsonResponse({ error: 'invalid invite link' }, 400)
  }
  const context = contextRows[0]
  if (context.status !== 'pending' || context.is_expired) {
    return jsonResponse({ error: 'this invite is no longer valid' }, 400)
  }

  // Direct-read the real (unmasked) owner_email + both verification
  // timestamps -- authoritative pre-check, defense in depth exactly
  // mirroring activate-portal-account's own direct-table pre-check
  // (the AUTHORITATIVE enforcement is still claim_sales_activation_
  // invite()'s own checks once a session exists).
  const { data: inviteRows, error: inviteError } = await admin
    .from('sales_tenant_activation_invites')
    .select('owner_email, email_verified_at, secret_verified_at')
    .eq('token_hash', await sha256Hex(rawToken))
    .limit(1)
  if (inviteError || !inviteRows || inviteRows.length === 0) {
    return jsonResponse({ error: 'invalid invite link' }, 400)
  }
  const verificationState = inviteRows[0]
  if (!verificationState.email_verified_at || !verificationState.secret_verified_at) {
    return jsonResponse({ error: 'email and activation code verification must both be completed first' }, 400)
  }

  // Create the auth user pre-confirmed -- zero outbound email, matching
  // this project's own established convention. Email is the invite's
  // own server-stored owner_email, never a client-supplied value.
  const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
    email: verificationState.owner_email,
    password,
    email_confirm: true,
  })

  if (createError) {
    const message = createError.message || 'could not create account'
    const status = message.toLowerCase().includes('already') || message.toLowerCase().includes('registered') ? 409 : 400
    // "Already registered" is NOT an error for this flow -- it is the
    // expected signal that this prospect already has a Mal3aby account.
    // Per the mandatory rule ("if the prospect already has an existing
    // account, link the existing account after verification instead of
    // creating a second one") and this codebase's own documented rule
    // ("never auto-link on a bare email-string match"), the frontend
    // must route the prospect to sign in as THEMSELVES, after which
    // claim_sales_activation_invite() (authenticated) links that real,
    // freshly-authenticated session -- never an automatic link derived
    // from the email string alone.
    return jsonResponse({ error: message, existing_account: status === 409 }, status)
  }

  const newUserId = createdUser.user?.id
  if (!newUserId) {
    return jsonResponse({ error: 'account creation failed' }, 500)
  }

  // No RPC call, no session returned here -- deliberately. See the
  // header comment: this function's only job is creating the identity.
  // The frontend now performs an ordinary signInWithPassword() with the
  // exact credentials just chosen, then calls claim_sales_activation_
  // invite() under that real session, which is the only place onboarding
  // actually runs.
  return jsonResponse({ user_id: newUserId })
})
