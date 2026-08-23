// activate-portal-account -- CUSTOMER ACCOUNT / CLUB PORTAL: ZERO-COST
// ACTIVATION (2026-08-23).
//
// Deployed with verify_jwt=false (see deploy_edge_function's own
// verify_jwt parameter) -- deliberately: this is the very first
// entrypoint an unauthenticated first-time customer reaches, holding
// only the opaque invite token from a WhatsApp link, with no Supabase
// session/JWT to present. This function implements its OWN
// authentication instead: every request is validated against the real
// credential (the portal_invites token, hashed and compared
// server-side), exactly the same pattern already used by this
// project's other public token-gated RPCs (verify_booking_qr_public,
// verify_invoice_public).
//
// WHY THIS EDGE FUNCTION EXISTS (real production finding, not
// speculative): the original design called client-side
// supabase.auth.signUp() directly from ActivateAccountPage.tsx, then
// claim_portal_invite() once the resulting session existed. Live-tested
// against the real hosted project (gxkrtlvpjwxhcqdisyob) and confirmed
// via auth.users (email_confirmed_at/confirmation_sent_at columns) that
// this project's Auth email-confirmation is genuinely enabled -- the
// local supabase/config.toml's `enable_confirmations = false` does NOT
// reflect the live hosted project's actual setting (a documented class
// of live-vs-git drift already flagged elsewhere in this codebase's own
// audits). signUp() therefore tries to send a confirmation email on
// every attempt, and repeatedly hit Supabase's built-in outbound-email
// rate limit during live testing (zero rows for any test email ever
// appeared in auth.users -- the send failure blocked user creation
// entirely, not just the email).
//
// The zero-additional-cost fix, fully consistent with the amendment's
// own rules (Supabase Auth remains the sole password authority; no new
// paid provider; no custom password storage): perform account creation
// with the Supabase service_role key via auth.admin.createUser(...,
// { email_confirm: true }) -- the exact same "pre-confirmed, no email
// sent" pattern this project's own QA fixture accounts were already
// created with (auth.users shows confirmation_sent_at: null,
// confirmed_at set within milliseconds of created_at for every existing
// QA account -- proof this pattern is already this project's own
// convention, not something invented here). Zero SMTP quota consumed,
// zero new cost, zero new provider.
//
// This function does NOT trust anything from the client except the raw
// invite token and the customer-chosen email/password -- customer
// identity is derived exclusively from the token, server-side, via the
// same claim_portal_invite_service() RPC that enforces every invariant
// claim_portal_invite() itself does (pending/unexpired/phone-verified,
// idempotent, ownership-checked) -- just parameterized to accept an
// explicit p_user_id, because this call happens BEFORE any session
// exists for the brand-new user. That RPC is granted to service_role
// ONLY (never anon/authenticated), so it is not a bypass of the
// ownership model -- it is reachable exclusively from this trusted
// server context, which itself only ever passes the user id IT just
// created two lines above.
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'method not allowed' }, 405)
  }

  let body: { raw_token?: string; email?: string; password?: string }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid request body' }, 400)
  }

  const { raw_token: rawToken, email, password } = body

  if (!rawToken || typeof rawToken !== 'string' || rawToken.length < 32) {
    return jsonResponse({ error: 'invalid invite link' }, 400)
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return jsonResponse({ error: 'a valid email is required' }, 400)
  }
  if (!password || typeof password !== 'string' || password.length < 8) {
    return jsonResponse({ error: 'password must be at least 8 characters' }, 400)
  }

  // service_role client -- the ONLY place in this whole feature that
  // uses elevated privileges, and only for the two operations that
  // genuinely require them: creating a pre-confirmed auth user, and
  // calling the service_role-only linking RPC below.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // Re-validate the invite is genuinely claimable BEFORE creating any
  // auth user -- avoids creating an orphan account for a request that
  // was never going to succeed anyway (invalid/expired/not-yet-phone-
  // verified token). The authoritative, atomic check still happens
  // inside claim_portal_invite_service() below regardless.
  const { data: inviteRows, error: inviteError } = await admin.rpc('get_portal_invite_context', { p_raw_token: rawToken })
  if (inviteError || !inviteRows || inviteRows.length === 0) {
    return jsonResponse({ error: 'invalid invite link' }, 400)
  }
  const invite = inviteRows[0]
  if (invite.status !== 'pending' || invite.is_expired) {
    return jsonResponse({ error: 'this invite is no longer valid' }, 400)
  }

  // Create the auth user pre-confirmed -- zero outbound email, zero
  // cost, matching this project's own existing QA-account creation
  // convention (confirmed via auth.users inspection before writing
  // this function).
  const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (createError) {
    // Supabase Admin API surfaces a real, specific error for a
    // duplicate email (unlike the client signUp() anti-enumeration
    // behavior) -- safe to relay directly, matching the amendment's
    // section 15 rule (never auto-link on a bare email-string match).
    const message = createError.message || 'could not create account'
    const status = message.toLowerCase().includes('already') || message.toLowerCase().includes('registered') ? 409 : 400
    return jsonResponse({ error: message }, status)
  }

  const newUserId = createdUser.user?.id
  if (!newUserId) {
    return jsonResponse({ error: 'account creation failed' }, 500)
  }

  // Atomic customer link -- service_role-only RPC (see the new
  // migration) mirroring claim_portal_invite()'s exact body, just
  // parameterized to accept an explicit user id since no session
  // exists yet for this brand-new user.
  const { data: linkedCustomerId, error: claimError } = await admin.rpc(
    'claim_portal_invite_service',
    { p_raw_token: rawToken, p_user_id: newUserId },
  )

  if (claimError) {
    // Compensating cleanup: the auth user was created but linking
    // failed (e.g. a genuine race where the invite got consumed by a
    // parallel attempt between the pre-check above and now, or the
    // customer already has a different linked account in this club).
    // Delete the just-created orphan auth user rather than leaving a
    // dangling, never-linked account behind -- amendment section 14's
    // explicit "do not leave Auth User created but Customer link
    // missing" requirement.
    await admin.auth.admin.deleteUser(newUserId).catch(() => {})
    return jsonResponse({ error: claimError.message || 'this invite could not be claimed' }, 400)
  }

  // No session is returned -- the frontend signs in immediately with
  // the exact email/password the customer just chose
  // (supabase.auth.signInWithPassword), which is itself a completely
  // normal, already-proven Supabase Auth flow and needs no special
  // handling here.
  return jsonResponse({ customer_id: linkedCustomerId })
})
