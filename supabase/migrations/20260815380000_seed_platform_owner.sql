-- Final Release Gate (2026-08-15): grant the real platform_owner
-- membership. There is no self-service "become platform owner" flow
-- (correctly, by design -- see Phase 2's is_platform_owner() comment,
-- "modeled as a permission check", never a client-reachable RPC), so
-- this is a one-time, explicitly-authorized data seed, done via
-- migration rather than an untracked raw insert so it stays in the
-- repo's audit trail.
--
-- club_memberships.club_id is NOT NULL by schema, but is_platform_owner()
-- only checks role_key = 'platform_owner' on any active membership row --
-- the specific club_id attached is incidental to the role's actual
-- (global) authority, matching the existing pattern used by every other
-- platform_owner-gated policy in this codebase.
--
-- Target: moustafa.elsafy2@gmail.com, confirmed via real signup + email
-- click during the pre-release verification pass (see docs/PROJECT_STATE.md).
do $$
declare
  v_user_id uuid;
  v_club_id uuid;
  v_role_id uuid;
begin
  select id into v_user_id from auth.users where email = 'moustafa.elsafy2@gmail.com';
  if v_user_id is null then
    raise exception 'moustafa.elsafy2@gmail.com not found in auth.users -- confirm the account exists before applying this migration';
  end if;

  select id into v_club_id from public.clubs
  where id in (select club_id from public.club_memberships where user_id = v_user_id)
  order by created_at asc limit 1;
  if v_club_id is null then
    raise exception 'target user has no existing club_memberships row to anchor the required club_id';
  end if;

  select id into v_role_id from public.roles where key = 'platform_owner';

  insert into public.club_memberships (user_id, club_id, role_id, status)
  values (v_user_id, v_club_id, v_role_id, 'active')
  on conflict do nothing;
end $$;
