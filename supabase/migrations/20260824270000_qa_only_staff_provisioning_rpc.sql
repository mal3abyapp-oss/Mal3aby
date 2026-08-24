-- TEMPORARY QA-ONLY HELPER (2026-08-24): service-role-only staff
-- provisioning for this security audit's mandated LIVE staff-UI
-- walkthrough.
--
-- WHY THIS EXISTS: the audit directive requires actually logging into
-- the staff web application as real QA accounts across multiple roles
-- (Owner/Manager/Reception/Accountant/Coach/Scanner) and clicking
-- through the real UI -- not just RPC-level role impersonation. The
-- normal staff-onboarding path (plain /signup -> email confirmation
-- link -> owner calls invite_staff_member() from the UI) cannot be
-- completed end-to-end by an automated agent: email confirmation
-- requires clicking a real inbox link, and typing a password into the
-- login form is out of scope for what this agent will do directly
-- (see companion Edge Function qa-staff-provision for the
-- pre-confirmed-account half of this, using the standard Supabase
-- Admin API auth.admin.createUser(..., { email_confirm: true })
-- pattern already established and documented in this codebase's own
-- activate-portal-account Edge Function).
--
-- This RPC provides the second half: linking an already-created,
-- pre-confirmed QA auth user to a club with a given role, WITHOUT
-- going through invite_staff_member() (which requires a real caller
-- session via auth.uid() -- not available to a service-role admin
-- script with no logged-in user). It intentionally mirrors
-- invite_staff_member()'s exact club_memberships/membership_branches
-- upsert shape (supabase/migrations/20260821010000_staff_360_fix_
-- existing_rpc_gaps.sql:381-461) so QA accounts get provisioned
-- identically to how a real Owner would provision them -- this is not
-- a new/different membership-granting mechanism, just the same one
-- invoked from a trusted server context instead of from an
-- authenticated client session.
--
-- SAFETY BOUNDARIES (hard requirements):
--   * SECURITY DEFINER, granted ONLY to service_role. Revoked from
--     public/anon/authenticated explicitly below. Not reachable from
--     the browser or from any authenticated staff/customer session.
--   * p_email MUST match the 'qa-audit-' local-part prefix convention
--     enforced below -- this hard-fails the function for any other
--     email, so it cannot be used to grant a role to a real employee's
--     account even if service_role credentials were misused.
--   * p_role_key = 'platform_owner' is explicitly rejected, matching
--     invite_staff_member()'s own restriction.
--   * Every call is audit-logged via write_audit_log(), same as the
--     real invite_staff_member() path.
--
-- TEARDOWN: this migration is temporary and will be superseded by a
-- follow-up migration dropping this function once the current audit
-- round's live staff-UI walkthrough is complete and QA accounts are
-- deleted -- see the audit's own cleanup section for confirmation this
-- was actually removed, not left as permanent extra surface.

create or replace function public.qa_only_provision_staff_membership(
  p_email text,
  p_club_id uuid,
  p_role_key text,
  p_branch_ids uuid[] default null::uuid[]
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_target_user_id uuid;
  v_role_id uuid;
  v_membership_id uuid;
  v_branch_id uuid;
  v_default_custody boolean;
begin
  if p_email is null or lower(p_email) not like 'qa-audit-%' then
    raise exception 'this helper only provisions accounts whose email starts with qa-audit- -- refusing to touch a non-QA account';
  end if;

  if p_role_key = 'platform_owner' then
    raise exception 'not authorized';
  end if;

  select id into v_target_user_id
  from auth.users
  where lower(email) = lower(p_email)
  limit 1;

  if v_target_user_id is null then
    raise exception 'no auth account found for that QA email -- create it first via the qa-staff-provision Edge Function';
  end if;

  select id into v_role_id from public.roles where key = p_role_key;
  if v_role_id is null then
    raise exception 'unknown role';
  end if;

  select exists (
    select 1 from public.role_permissions rp
    join public.permissions p on p.id = rp.permission_id
    where rp.role_id = v_role_id and p.key = 'payment.create'
  ) into v_default_custody;

  insert into public.club_memberships (user_id, club_id, role_id, status, has_cash_custody)
  values (v_target_user_id, p_club_id, v_role_id, 'active', v_default_custody)
  on conflict (user_id, club_id, role_id)
    do update set status = 'active', updated_at = now()
  returning id into v_membership_id;

  delete from public.membership_branches where membership_id = v_membership_id;

  if p_branch_ids is not null then
    foreach v_branch_id in array p_branch_ids loop
      insert into public.membership_branches (membership_id, branch_id)
      values (v_membership_id, v_branch_id)
      on conflict do nothing;
    end loop;
  end if;

  perform public.write_audit_log(
    p_club_id, 'qa_audit.staff_provisioned', 'club_membership', v_membership_id,
    null, jsonb_build_object('role_key', p_role_key, 'branch_ids', p_branch_ids, 'email', p_email), null
  );

  return v_membership_id;
end;
$$;

comment on function public.qa_only_provision_staff_membership(text, uuid, text, uuid[]) is
  'TEMPORARY QA-ONLY (2026-08-24 security audit): service_role-only staff-membership provisioning for QA accounts (email must start with qa-audit-). Mirrors invite_staff_member()''s exact upsert shape but callable without a logged-in caller session. To be dropped once the current audit round''s live staff-UI walkthrough and QA cleanup are complete.';

revoke all on function public.qa_only_provision_staff_membership(text, uuid, text, uuid[]) from public;
revoke all on function public.qa_only_provision_staff_membership(text, uuid, text, uuid[]) from anon;
revoke all on function public.qa_only_provision_staff_membership(text, uuid, text, uuid[]) from authenticated;
grant execute on function public.qa_only_provision_staff_membership(text, uuid, text, uuid[]) to service_role;

-- Companion cleanup RPC: deprovision (hard-delete the club_membership +
-- membership_branches rows) for a QA-audit account -- same naming-
-- convention safety guard, same service_role-only grant.
create or replace function public.qa_only_deprovision_staff_membership(
  p_email text,
  p_club_id uuid
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_target_user_id uuid;
begin
  if p_email is null or lower(p_email) not like 'qa-audit-%' then
    raise exception 'this helper only deprovisions accounts whose email starts with qa-audit-';
  end if;

  select id into v_target_user_id from auth.users where lower(email) = lower(p_email) limit 1;
  if v_target_user_id is null then
    return;
  end if;

  delete from public.membership_branches
  where membership_id in (
    select id from public.club_memberships where user_id = v_target_user_id and club_id = p_club_id
  );
  delete from public.club_memberships where user_id = v_target_user_id and club_id = p_club_id;

  perform public.write_audit_log(
    p_club_id, 'qa_audit.staff_deprovisioned', 'club_membership', null, null,
    jsonb_build_object('email', p_email), null
  );
end;
$$;

comment on function public.qa_only_deprovision_staff_membership(text, uuid) is
  'TEMPORARY QA-ONLY (2026-08-24 security audit): reverses qa_only_provision_staff_membership. To be dropped once the current audit round is complete.';

revoke all on function public.qa_only_deprovision_staff_membership(text, uuid) from public;
revoke all on function public.qa_only_deprovision_staff_membership(text, uuid) from anon;
revoke all on function public.qa_only_deprovision_staff_membership(text, uuid) from authenticated;
grant execute on function public.qa_only_deprovision_staff_membership(text, uuid) to service_role;
