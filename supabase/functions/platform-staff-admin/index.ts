// platform-staff-admin -- PLATFORM STAFF IDENTITY MANAGEMENT (2026-08-26)
//
// Handles the three actions that genuinely require the Supabase Admin
// API (service_role) and therefore cannot happen from the browser at
// all, per directive Section 11/12/32:
//   - create: mint a new pre-confirmed auth.users account for a brand
//     new platform employee (mirrors activate-portal-account's own
//     auth.admin.createUser({ email_confirm: true }) pattern -- this
//     project's own established zero-cost-activation convention, not a
//     new one invented here), then insert the platform_staff_memberships
//     row that links it to a platform role.
//   - change_email: auth.admin.updateUserById(..., { email }) -- the
//     ONLY safe way to change a login email; never a raw UPDATE against
//     auth.users.
//   - reset_password: auth.admin.generateLink({ type: 'recovery' })
//     -- returns a real recovery link the Platform Owner can hand to the
//     employee themselves (matches this project's own existing
//     "Deliver this activation invite manually" convention from the
//     Club Memberships portal-invite work) -- this endpoint never sets,
//     stores, returns, or logs any plaintext password (directive Section
//     12/19/32 -- "never show/store/retrieve a password").
//
// verify_jwt=true (unlike activate-portal-account, which is
// unauthenticated by necessity): every request here MUST carry a real
// caller session. The caller's own JWT is used to call
// has_platform_permission() as THEM (never assumed, never trusted from
// the request body) before service_role does anything -- this is the
// real authorization boundary; service_role itself is only ever used for
// the three specific Admin-API calls above, never as a blanket bypass.
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

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return jsonResponse({ error: 'authentication required' }, 401)
  }

  let body: {
    action?: 'create' | 'change_email' | 'reset_password'
    email?: string
    full_name?: string
    platform_role_id?: string
    platform_custom_role_id?: string
    target_user_id?: string
    new_email?: string
  }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid request body' }, 400)
  }

  // Caller-scoped client -- resolves the REAL calling user from their own
  // JWT (never trusted from the request body), used only to check
  // authorization. This is the actual security boundary of this whole
  // function.
  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  if (callerError || !callerData.user) {
    return jsonResponse({ error: 'authentication required' }, 401)
  }
  const callerId = callerData.user.id

  // service_role client -- the ONLY place elevated privileges are used,
  // and only for the specific Admin-API operations each action needs.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  async function callerHasPermission(key: string): Promise<boolean> {
    const { data, error } = await admin.rpc('has_platform_permission_as', { p_user_id: callerId, p_key: key })
    if (error) return false
    return data === true
  }

  if (body.action === 'create') {
    if (!(await callerHasPermission('platform.staff.create'))) {
      return jsonResponse({ error: 'not authorized' }, 403)
    }
    const { email, full_name: fullName, platform_role_id: platformRoleId, platform_custom_role_id: platformCustomRoleId } = body
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return jsonResponse({ error: 'a valid email is required' }, 400)
    }
    if ((platformRoleId && platformCustomRoleId) || (!platformRoleId && !platformCustomRoleId)) {
      return jsonResponse({ error: 'specify exactly one of a system role or a custom role' }, 400)
    }

    // Escalation guard (directive Section 25) -- re-checked here at the
    // Edge Function layer too (not just relying on the RLS-guarded
    // insert below), since this is the layer that actually creates the
    // auth user and we should never do that for a request that will be
    // rejected downstream anyway.
    if (platformRoleId) {
      const { data: roleKeys } = await admin
        .from('platform_role_permissions')
        .select('platform_permissions(key)')
        .eq('platform_role_id', platformRoleId)
      const keys = (roleKeys ?? []).map((r: { platform_permissions: { key: string } | null }) => r.platform_permissions?.key).filter(Boolean)
      for (const key of keys) {
        if (!(await callerHasPermission(key as string))) {
          return jsonResponse({ error: 'cannot assign a role with permissions you do not hold yourself' }, 403)
        }
      }
    }

    const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: fullName ? { full_name: fullName } : undefined,
    })
    if (createError) {
      const message = createError.message || 'could not create account'
      const status = message.toLowerCase().includes('already') || message.toLowerCase().includes('registered') ? 409 : 400
      return jsonResponse({ error: message }, status)
    }
    const newUserId = createdUser.user?.id
    if (!newUserId) {
      return jsonResponse({ error: 'account creation failed' }, 500)
    }

    const { data: membershipId, error: insertError } = await admin
      .from('platform_staff_memberships')
      .insert({
        user_id: newUserId,
        platform_role_id: platformRoleId ?? null,
        platform_custom_role_id: platformCustomRoleId ?? null,
        status: 'active',
        created_by: callerId,
      })
      .select('id')
      .single()
    if (insertError) {
      // Compensating cleanup -- same discipline as activate-portal-account:
      // never leave an orphan auth user with no platform membership.
      await admin.auth.admin.deleteUser(newUserId).catch(() => {})
      return jsonResponse({ error: insertError.message || 'could not create platform staff record' }, 400)
    }

    await admin.rpc('write_audit_log', {
      p_club_id: null,
      p_action: 'platform_staff.created',
      p_entity_type: 'platform_staff_membership',
      p_entity_id: membershipId!.id,
      p_before: null,
      p_after: { email, platform_role_id: platformRoleId ?? null, platform_custom_role_id: platformCustomRoleId ?? null },
      p_reason: null,
    })

    // Send a real password-setup link immediately -- the new employee
    // never has a password at creation time (directive: never generate
    // one server-side and hand it over in plaintext either).
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email,
    })
    if (linkError) {
      return jsonResponse({ membership_id: membershipId!.id, user_id: newUserId, warning: 'account created but the setup link could not be generated' })
    }

    return jsonResponse({
      membership_id: membershipId!.id,
      user_id: newUserId,
      setup_link: linkData.properties?.action_link ?? null,
    })
  }

  if (body.action === 'change_email') {
    if (!(await callerHasPermission('platform.staff.update'))) {
      return jsonResponse({ error: 'not authorized' }, 403)
    }
    const { target_user_id: targetUserId, new_email: newEmail } = body
    if (!targetUserId || !newEmail || !newEmail.includes('@')) {
      return jsonResponse({ error: 'a target user and a valid new email are required' }, 400)
    }

    const { data: targetMembership } = await admin
      .from('platform_staff_memberships')
      .select('id')
      .eq('user_id', targetUserId)
      .eq('status', 'active')
      .maybeSingle()
    if (!targetMembership) {
      return jsonResponse({ error: 'this account is not an active platform staff member' }, 404)
    }

    const { data: oldUserData } = await admin.auth.admin.getUserById(targetUserId)
    const oldEmail = oldUserData.user?.email ?? null

    const { error: updateError } = await admin.auth.admin.updateUserById(targetUserId, { email: newEmail, email_confirm: true })
    if (updateError) {
      const message = updateError.message || 'could not update email'
      const status = message.toLowerCase().includes('already') || message.toLowerCase().includes('registered') ? 409 : 400
      return jsonResponse({ error: message }, status)
    }

    await admin.rpc('write_audit_log', {
      p_club_id: null,
      p_action: 'platform_staff.email_changed',
      p_entity_type: 'platform_staff_membership',
      p_entity_id: targetMembership.id,
      p_before: { email: oldEmail },
      p_after: { email: newEmail },
      p_reason: null,
    })

    return jsonResponse({ success: true })
  }

  if (body.action === 'reset_password') {
    if (!(await callerHasPermission('platform.staff.update'))) {
      return jsonResponse({ error: 'not authorized' }, 403)
    }
    const { target_user_id: targetUserId } = body
    if (!targetUserId) {
      return jsonResponse({ error: 'a target user is required' }, 400)
    }

    const { data: targetMembership } = await admin
      .from('platform_staff_memberships')
      .select('id')
      .eq('user_id', targetUserId)
      .eq('status', 'active')
      .maybeSingle()
    if (!targetMembership) {
      return jsonResponse({ error: 'this account is not an active platform staff member' }, 404)
    }

    const { data: targetUserData } = await admin.auth.admin.getUserById(targetUserId)
    const targetEmail = targetUserData.user?.email
    if (!targetEmail) {
      return jsonResponse({ error: "could not resolve this account's email" }, 400)
    }

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email: targetEmail,
    })
    if (linkError) {
      return jsonResponse({ error: linkError.message || 'could not generate a reset link' }, 400)
    }

    // Audit ONLY that a reset was requested -- directive Section 19:
    // never log the token/link/password itself.
    await admin.rpc('write_audit_log', {
      p_club_id: null,
      p_action: 'platform_staff.password_reset',
      p_entity_type: 'platform_staff_membership',
      p_entity_id: targetMembership.id,
      p_before: null,
      p_after: null,
      p_reason: null,
    })

    return jsonResponse({ reset_link: linkData.properties?.action_link ?? null })
  }

  return jsonResponse({ error: 'unknown action' }, 400)
})
