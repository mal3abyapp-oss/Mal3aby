-- FULL PRODUCT E2E ACCEPTANCE (D-E2E-001, P0): an invited staff member
-- created via create_club_staff_membership_service() could never
-- actually gain access. The introducing migration
-- (20260826124736_club_staff_invite_pending_status.sql) documented the
-- intended design in its own comment: "grants nothing until the row is
-- flipped to 'active' on first login" -- but no code anywhere (RPC,
-- trigger, edge function, or client) ever performed that flip. The
-- invited staff member's real first sign-in hit LoginPage.tsx's
-- hasAnyActiveMembership() check (.eq('status','active')), which
-- excludes 'invited' rows exactly like "no membership at all" and
-- routed them to /onboarding (create a brand-new club) -- reproducing
-- the same class of defect as the already-fixed Final Pre-Release
-- Verification bug, just for the 'invited' state specifically.
--
-- Fix: a real, governed activation RPC, callable only by an
-- authenticated session for ITS OWN auth.uid() (never another user's
-- membership -- no admin/service-role bypass surface here), called from
-- LoginPage.tsx immediately after a successful signInWithPassword() and
-- before the routing checks. Idempotent (a no-op when nothing is
-- 'invited') and safe to call unconditionally on every login.
create or replace function public.activate_my_invited_memberships()
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_count integer;
  v_row record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_count := 0;
  for v_row in
    update public.club_memberships
    set status = 'active'
    where user_id = auth.uid()
      and status = 'invited'
    returning id, club_id
  loop
    v_count := v_count + 1;
    perform public.write_audit_log(
      v_row.club_id, 'staff.membership_activated_on_login', 'club_membership', v_row.id, null,
      jsonb_build_object('user_id', auth.uid()), null
    );
  end loop;

  return v_count;
end;
$$;

comment on function public.activate_my_invited_memberships() is
  'Called client-side (LoginPage.tsx) immediately after a successful sign-in. Flips every INVITED club_memberships row belonging to the caller''s own auth.uid() to ACTIVE -- the missing half of the invited-staff-onboarding design (see D-E2E-001). Idempotent no-op when nothing is invited. Strictly self-scoped: cannot activate another user''s membership.';

revoke all on function public.activate_my_invited_memberships() from public;
revoke all on function public.activate_my_invited_memberships() from anon;
grant execute on function public.activate_my_invited_memberships() to authenticated;
