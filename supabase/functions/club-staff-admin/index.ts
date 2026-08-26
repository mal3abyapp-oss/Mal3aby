// club-staff-admin -- CLUB STAFF ONBOARDING: NEW-ACCOUNT CREATION
// (2026-08-26)
//
// invite_staff_member() (existing RPC, unchanged) already handles Mode
// A -- linking an EXISTING auth.users account to a club. This function
// adds Mode B, the genuinely missing path (directive Section 20/23):
// creating a brand-new employee who has never used Mal3aby at all.
// Mirrors platform-staff-admin's own three-action shape exactly, scoped
// to a club instead of the platform domain:
//   - create: auth.admin.createUser({ email_confirm: true }) (this
//     project's own established zero-cost-activation convention -- see
//     activate-portal-account/platform-staff-admin) + a service-role-only
//     create_club_staff_membership_service() RPC call (mirrors
//     invite_staff_member()'s own business rules exactly, see that
//     migration's own comment), then a real Supabase recovery
//     action_link handed back to the caller -- never a password.
//   - change_email / reset_password: identical Admin-API pattern to
//     platform-staff-admin, scoped by has_permission_as(..., 'staff.update',
//     p_club_id) instead of the platform-domain check.
//
// verify_jwt=true: every request carries a real caller session. The
// caller's own JWT resolves their real identity via a separate
// caller-scoped client, checked with has_permission_as() BEFORE any
// service_role action -- this is the real authorization boundary, same
// discipline as platform-staff-admin and activate-portal-account before
// it.
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
    club_id?: string
    email?: string
    full_name?: string
    role_key?: string
    custom_role_id?: string
    branch_ids?: string[]
    target_user_id?: string
    target_membership_id?: string
    new_email?: string
  }
  try {
    body = await req.json()
  } catch {
    return jsonResponse({ error: 'invalid request body' }, 400)
  }

  const clubId = body.club_id
  if (!clubId) {
    return jsonResponse({ error: 'club_id is required' }, 400)
  }

  // Caller-scoped client -- resolves the REAL calling user from their own
  // JWT (never trusted from the request body).
  const callerClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
  })
  const { data: callerData, error: callerError } = await callerClient.auth.getUser()
  if (callerError || !callerData.user) {
    return jsonResponse({ error: 'authentication required' }, 401)
  }
  const callerId = callerData.user.id

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  async function callerHasPermission(key: string): Promise<boolean> {
    const { data, error } = await admin.rpc('has_permission_as', { p_user_id: callerId, p_key: key, p_club_id: clubId })
    if (error) return false
    return data === true
  }

  if (body.action === 'create') {
    if (!(await callerHasPermission('staff.create'))) {
      return jsonResponse({ error: 'not authorized' }, 403)
    }
    const { email, full_name: fullName, role_key: roleKey, custom_role_id: customRoleId, branch_ids: branchIds } = body
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return jsonResponse({ error: 'a valid email is required' }, 400)
    }
    if ((roleKey && customRoleId) || (!roleKey && !customRoleId)) {
      return jsonResponse({ error: 'specify exactly one of a system role or a custom role' }, 400)
    }
    if (roleKey === 'platform_owner') {
      return jsonResponse({ error: 'not authorized' }, 403)
    }

    // Escalation guard (mirrors invite_staff_member()'s own
    // permission_set_escalates() check, re-applied at this layer since
    // this is the layer that actually creates the auth user).
    let permissionKeys: string[] = []
    if (customRoleId) {
      const { data: rows } = await admin
        .from('club_role_permissions')
        .select('permissions(key)')
        .eq('club_role_id', customRoleId)
      permissionKeys = (rows ?? []).map((r: { permissions: { key: string } | null }) => r.permissions?.key).filter((k): k is string => !!k)
    } else {
      const { data: roleRow } = await admin.from('roles').select('id').eq('key', roleKey).maybeSingle()
      if (!roleRow) {
        return jsonResponse({ error: 'unknown role' }, 400)
      }
      const { data: rows } = await admin
        .from('role_permissions')
        .select('permissions(key)')
        .eq('role_id', roleRow.id)
      permissionKeys = (rows ?? []).map((r: { permissions: { key: string } | null }) => r.permissions?.key).filter((k): k is string => !!k)
    }
    for (const key of permissionKeys) {
      if (!(await callerHasPermission(key))) {
        return jsonResponse({ error: 'cannot assign a role with permissions you do not hold yourself' }, 403)
      }
    }

    const { data: createdUser, error: createError } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: fullName ? { full_name: fullName } : undefined,
    })
    if (createError) {
      const message = createError.message || 'could not create account'
      // Directive Section 26 -- a friendly, actionable message instead
      // of the raw Auth error, letting the frontend offer switching to
      // the existing-account (Mode A) flow.
      if (message.toLowerCase().includes('already') || message.toLowerCase().includes('registered')) {
        return jsonResponse({ error: 'account_exists', message: 'An account already exists with this email. You can link it to this club instead.' }, 409)
      }
      return jsonResponse({ error: message }, 400)
    }
    const newUserId = createdUser.user?.id
    if (!newUserId) {
      return jsonResponse({ error: 'account creation failed' }, 500)
    }

    // profiles row is auto-created by the existing handle_new_user()
    // trigger on auth.users insert, reading raw_user_meta_data->>'full_name'
    // -- already matches the user_metadata passed to createUser() above,
    // so no separate profiles write is needed here (same as
    // platform-staff-admin's own create action).

    const { data: membershipId, error: membershipError } = await admin.rpc('create_club_staff_membership_service', {
      p_actor_id: callerId,
      p_club_id: clubId,
      p_user_id: newUserId,
      p_role_key: roleKey ?? null,
      p_custom_role_id: customRoleId ?? null,
      p_branch_ids: branchIds ?? null,
    })
    if (membershipError) {
      // Compensating cleanup -- never leave an orphan auth user with no
      // club membership (same discipline as activate-portal-account and
      // platform-staff-admin before it).
      await admin.auth.admin.deleteUser(newUserId).catch(() => {})
      return jsonResponse({ error: membershipError.message || 'could not create staff membership' }, 400)
    }

    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: 'recovery',
      email,
    })
    if (linkError) {
      return jsonResponse({ membership_id: membershipId, user_id: newUserId, warning: 'account created but the setup link could not be generated' })
    }

    return jsonResponse({
      membership_id: membershipId,
      user_id: newUserId,
      setup_link: linkData.properties?.action_link ?? null,
    })
  }

  if (body.action === 'change_email') {
    if (!(await callerHasPermission('staff.update'))) {
      return jsonResponse({ error: 'not authorized' }, 403)
    }
    const { target_user_id: targetUserId, target_membership_id: targetMembershipId, new_email: newEmail } = body
    if (!targetUserId || !targetMembershipId || !newEmail || !newEmail.includes('@')) {
      return jsonResponse({ error: 'a target membership/user and a valid new email are required' }, 400)
    }

    const { data: targetMembership } = await admin
      .from('club_memberships')
      .select('id')
      .eq('id', targetMembershipId)
      .eq('user_id', targetUserId)
      .eq('club_id', clubId)
      .maybeSingle()
    if (!targetMembership) {
      return jsonResponse({ error: 'this account is not staff at this club' }, 404)
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
      p_club_id: clubId,
      p_action: 'staff.email_changed',
      p_entity_type: 'club_membership',
      p_entity_id: targetMembership.id,
      p_before: { email: oldEmail },
      p_after: { email: newEmail },
      p_reason: null,
    })

    return jsonResponse({ success: true })
  }

  if (body.action === 'reset_password') {
    if (!(await callerHasPermission('staff.update'))) {
      return jsonResponse({ error: 'not authorized' }, 403)
    }
    const { target_user_id: targetUserId, target_membership_id: targetMembershipId } = body
    if (!targetUserId || !targetMembershipId) {
      return jsonResponse({ error: 'a target membership and user are required' }, 400)
    }

    const { data: targetMembership } = await admin
      .from('club_memberships')
      .select('id')
      .eq('id', targetMembershipId)
      .eq('user_id', targetUserId)
      .eq('club_id', clubId)
      .maybeSingle()
    if (!targetMembership) {
      return jsonResponse({ error: 'this account is not staff at this club' }, 404)
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

    // Audit ONLY that a reset/resend happened -- never the token/link.
    await admin.rpc('write_audit_log', {
      p_club_id: clubId,
      p_action: 'staff.password_reset',
      p_entity_type: 'club_membership',
      p_entity_id: targetMembership.id,
      p_before: null,
      p_after: null,
      p_reason: null,
    })

    return jsonResponse({ reset_link: linkData.properties?.action_link ?? null })
  }

  return jsonResponse({ error: 'unknown action' }, 400)
})
