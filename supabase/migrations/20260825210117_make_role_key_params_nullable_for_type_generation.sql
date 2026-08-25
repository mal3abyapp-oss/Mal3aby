-- STAFF ACCESS CONTROL & CUSTOM ROLES -- type-generation ergonomics fix.
--
-- p_role_key had no DEFAULT, so Postgres's type generator marks it as
-- a required, non-nullable `string` parameter -- even though the
-- function body always accepted and correctly handled a NULL value
-- (that's exactly how "use the custom-role branch instead" is
-- signaled). Adding `default null` makes the parameter's real,
-- always-supported nullability visible to the generated TypeScript
-- types, matching p_custom_role_id's existing pattern. Purely a
-- signature-metadata change -- the function body is byte-for-byte
-- identical to the previous migration, and adding a DEFAULT to an
-- already-existing parameter does not change the function's identity
-- signature, so this is a safe in-place CREATE OR REPLACE (confirmed
-- live: overload_count stayed 1 for both functions, grants preserved
-- unchanged) -- not a repeat of the orphaned-overload bug this session
-- already found and fixed once.
create or replace function public.invite_staff_member(
  p_club_id uuid,
  p_email text,
  p_role_key text default null,
  p_branch_ids uuid[] default null::uuid[],
  p_custom_role_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_target_user_id uuid;
  v_role_id uuid;
  v_membership_id uuid;
  v_branch_id uuid;
  v_default_custody boolean;
  v_was_existing boolean;
  v_prior_status text;
  v_custom_role public.club_roles;
begin
  if not public.has_permission('staff.create', p_club_id) then
    raise exception 'not authorized';
  end if;

  if (p_role_key is not null) = (p_custom_role_id is not null) then
    raise exception 'specify exactly one of a system role or a custom role';
  end if;

  select id into v_target_user_id
  from auth.users
  where lower(email) = lower(p_email)
  limit 1;

  if v_target_user_id is null then
    raise exception 'no account found for that email -- the person must sign up first';
  end if;

  if p_custom_role_id is not null then
    select * into v_custom_role from public.club_roles where id = p_custom_role_id and club_id = p_club_id;
    if v_custom_role.id is null then
      raise exception 'custom role not found in this club';
    end if;
    if not v_custom_role.is_active then
      raise exception 'this custom role is disabled';
    end if;
    if public.permission_set_escalates(p_club_id, (select array_agg(p.key) from public.club_role_permissions crp join public.permissions p on p.id = crp.permission_id where crp.club_role_id = p_custom_role_id)) then
      raise exception 'not authorized to assign a role with permissions you do not hold';
    end if;

    select coalesce(bool_or(p.key = 'payment.create'), false) into v_default_custody
    from public.club_role_permissions crp join public.permissions p on p.id = crp.permission_id
    where crp.club_role_id = p_custom_role_id;

    select id, status into v_membership_id, v_prior_status
    from public.club_memberships
    where user_id = v_target_user_id and club_id = p_club_id and custom_role_id = p_custom_role_id;
    v_was_existing := v_membership_id is not null;

    insert into public.club_memberships (user_id, club_id, role_id, custom_role_id, status, has_cash_custody)
    values (v_target_user_id, p_club_id, null, p_custom_role_id, 'active', v_default_custody)
    on conflict (user_id, club_id, custom_role_id) where custom_role_id is not null
      do update set status = 'active', updated_at = now()
    returning id into v_membership_id;
  else
    if p_role_key = 'platform_owner' then
      raise exception 'not authorized';
    end if;

    select id into v_role_id from public.roles where key = p_role_key;
    if v_role_id is null then
      raise exception 'unknown role';
    end if;

    if public.permission_set_escalates(p_club_id, (select array_agg(p.key) from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = v_role_id)) then
      raise exception 'not authorized to assign a role with permissions you do not hold';
    end if;

    select exists (
      select 1 from public.role_permissions rp
      join public.permissions p on p.id = rp.permission_id
      where rp.role_id = v_role_id and p.key = 'payment.create'
    ) into v_default_custody;

    select id, status into v_membership_id, v_prior_status
    from public.club_memberships
    where user_id = v_target_user_id and club_id = p_club_id and role_id = v_role_id;
    v_was_existing := v_membership_id is not null;

    insert into public.club_memberships (user_id, club_id, role_id, status, has_cash_custody)
    values (v_target_user_id, p_club_id, v_role_id, 'active', v_default_custody)
    on conflict (user_id, club_id, role_id)
      do update set status = 'active', updated_at = now()
    returning id into v_membership_id;
  end if;

  delete from public.membership_branches where membership_id = v_membership_id;

  if p_branch_ids is not null then
    foreach v_branch_id in array p_branch_ids loop
      insert into public.membership_branches (membership_id, branch_id)
      values (v_membership_id, v_branch_id)
      on conflict do nothing;
    end loop;
  end if;

  perform public.write_audit_log(
    p_club_id,
    case when v_was_existing then 'staff.membership_reactivated' else 'staff.invited' end,
    'club_membership', v_membership_id,
    case when v_was_existing then jsonb_build_object('status', v_prior_status) else null end,
    jsonb_build_object('role_key', p_role_key, 'custom_role_id', p_custom_role_id, 'branch_ids', p_branch_ids, 'status', 'active'),
    null
  );

  return v_membership_id;
end;
$function$;

create or replace function public.set_staff_role(
  p_club_id uuid,
  p_membership_id uuid,
  p_role_key text default null,
  p_custom_role_id uuid default null
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
  v_custom_role public.club_roles;
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

  if (p_role_key is not null) = (p_custom_role_id is not null) then
    raise exception 'specify exactly one of a system role or a custom role';
  end if;

  if p_role_key != 'club_owner' or p_custom_role_id is not null then
    if public.club_would_lose_last_owner(p_club_id, p_membership_id) then
      raise exception 'this is the club''s only active owner -- assign another owner first';
    end if;
  end if;

  perform set_config('mal3aby.role_change_authorized', 'true', true);

  if p_custom_role_id is not null then
    select * into v_custom_role from public.club_roles where id = p_custom_role_id and club_id = p_club_id;
    if v_custom_role.id is null then
      raise exception 'custom role not found in this club';
    end if;
    if not v_custom_role.is_active then
      raise exception 'this custom role is disabled';
    end if;
    if public.permission_set_escalates(p_club_id, (select array_agg(p.key) from public.club_role_permissions crp join public.permissions p on p.id = crp.permission_id where crp.club_role_id = p_custom_role_id)) then
      raise exception 'not authorized to assign a role with permissions you do not hold';
    end if;

    select r.key into v_old_role_key from public.roles r where r.id = v_membership.role_id;

    if exists (
      select 1 from public.club_memberships
      where user_id = v_membership.user_id and club_id = p_club_id and custom_role_id = p_custom_role_id and id != p_membership_id
    ) then
      raise exception 'this person already has a separate membership with that role in this club';
    end if;

    update public.club_memberships set role_id = null, custom_role_id = p_custom_role_id, updated_at = now()
    where id = p_membership_id;

    perform public.write_audit_log(
      p_club_id, 'staff.role_changed', 'club_membership', p_membership_id,
      jsonb_build_object('role_key', v_old_role_key),
      jsonb_build_object('custom_role_id', p_custom_role_id),
      null
    );
  else
    if p_role_key = 'platform_owner' then
      raise exception 'not authorized';
    end if;

    select id into v_new_role_id from public.roles where key = p_role_key;
    if v_new_role_id is null then
      raise exception 'unknown role';
    end if;

    if public.permission_set_escalates(p_club_id, (select array_agg(p.key) from public.role_permissions rp join public.permissions p on p.id = rp.permission_id where rp.role_id = v_new_role_id)) then
      raise exception 'not authorized to assign a role with permissions you do not hold';
    end if;

    select r.key into v_old_role_key from public.roles r where r.id = v_membership.role_id;

    if exists (
      select 1 from public.club_memberships
      where user_id = v_membership.user_id and club_id = p_club_id and role_id = v_new_role_id and id != p_membership_id
    ) then
      raise exception 'this person already has a separate membership with that role in this club';
    end if;

    update public.club_memberships set role_id = v_new_role_id, custom_role_id = null, updated_at = now()
    where id = p_membership_id;

    perform public.write_audit_log(
      p_club_id, 'staff.role_changed', 'club_membership', p_membership_id,
      jsonb_build_object('role_key', v_old_role_key),
      jsonb_build_object('role_key', p_role_key),
      null
    );
  end if;
end;
$function$;
