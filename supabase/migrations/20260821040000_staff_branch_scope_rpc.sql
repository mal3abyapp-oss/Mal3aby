-- Directive section 2/13: branch access must be editable on an
-- existing membership, not only settable at invite time. Audit found
-- membership_branches writes only happened inside invite_staff_member
-- -- no standalone RPC to change branch scope afterward.
create or replace function public.set_staff_branch_scope(
  p_club_id uuid,
  p_membership_id uuid,
  p_branch_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_membership record;
  v_branch_id uuid;
  v_before jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id and club_id = p_club_id;
  if v_membership.id is null then
    raise exception 'staff member not found';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_branch_ids is not null and array_length(p_branch_ids, 1) > 0 then
    if exists (
      select 1 from unnest(p_branch_ids) bid
      where not exists (select 1 from public.branches b where b.id = bid and b.club_id = p_club_id)
    ) then
      raise exception 'one or more branches do not belong to this club';
    end if;
  end if;

  select coalesce(jsonb_agg(branch_id), '[]'::jsonb) into v_before
  from public.membership_branches where membership_id = p_membership_id;

  delete from public.membership_branches where membership_id = p_membership_id;

  if p_branch_ids is not null then
    foreach v_branch_id in array p_branch_ids loop
      insert into public.membership_branches (membership_id, branch_id)
      values (p_membership_id, v_branch_id)
      on conflict do nothing;
    end loop;
  end if;

  perform public.write_audit_log(
    p_club_id, 'staff.branch_scope.set', 'club_membership', p_membership_id,
    jsonb_build_object('branch_ids', v_before),
    jsonb_build_object('branch_ids', to_jsonb(p_branch_ids)),
    null
  );
end;
$function$;

revoke all on function public.set_staff_branch_scope(uuid, uuid, uuid[]) from public;
revoke all on function public.set_staff_branch_scope(uuid, uuid, uuid[]) from anon;
grant execute on function public.set_staff_branch_scope(uuid, uuid, uuid[]) to authenticated;

-- Directive section 7: Edit Employee must cover Name/Phone/Email/Role
-- too. Name/email live on profiles/auth.users; role change is a
-- distinct, higher-consequence action (changes what the membership
-- CAN do) from branch/custody/status edits, so it gets its own RPC
-- with its own audit action name rather than being folded into a
-- generic "edit membership" RPC.
create or replace function public.set_staff_role(
  p_club_id uuid,
  p_membership_id uuid,
  p_role_key text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_membership record;
  v_new_role_id uuid;
  v_old_role_key text;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id and club_id = p_club_id;
  if v_membership.id is null then
    raise exception 'staff member not found';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('staff.update', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_role_key = 'platform_owner' then
    raise exception 'not authorized';
  end if;

  select id into v_new_role_id from public.roles where key = p_role_key;
  if v_new_role_id is null then
    raise exception 'unknown role';
  end if;

  select key into v_old_role_key from public.roles where id = v_membership.role_id;

  -- The unique constraint is (user_id, club_id, role_id) -- changing
  -- role_id on this membership could collide with another membership
  -- row this same person already holds for the target role. Surface
  -- that as a clear conflict rather than a raw constraint error.
  if exists (
    select 1 from public.club_memberships
    where user_id = v_membership.user_id and club_id = p_club_id and role_id = v_new_role_id and id != p_membership_id
  ) then
    raise exception 'this person already has a separate membership with that role in this club';
  end if;

  update public.club_memberships set role_id = v_new_role_id, updated_at = now()
  where id = p_membership_id;

  perform public.write_audit_log(
    p_club_id, 'staff.role_changed', 'club_membership', p_membership_id,
    jsonb_build_object('role_key', v_old_role_key),
    jsonb_build_object('role_key', p_role_key),
    null
  );
end;
$function$;

revoke all on function public.set_staff_role(uuid, uuid, text) from public;
revoke all on function public.set_staff_role(uuid, uuid, text) from anon;
grant execute on function public.set_staff_role(uuid, uuid, text) to authenticated;
