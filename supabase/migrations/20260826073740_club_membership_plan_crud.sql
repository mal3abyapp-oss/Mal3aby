-- CLUB MEMBERSHIPS domain -- Plan CRUD RPCs.
--
-- No hard delete of a plan with historical memberships -- archive/
-- deactivate only. plan.manage is owner-only per the directive's own
-- default-judgment rule (see club_membership_permissions.sql), enforced
-- here via has_permission('club_membership.plan.manage', ...).

create or replace function public.create_club_membership_plan(
  p_club_id uuid,
  p_name_ar text,
  p_name_en text,
  p_description text,
  p_price numeric,
  p_duration_value integer,
  p_duration_unit text,
  p_is_active boolean default true,
  p_is_public boolean default true,
  p_allow_renewal boolean default true,
  p_allow_freeze boolean default false,
  p_max_freeze_days_per_period integer default null,
  p_branch_scope text default 'all_branches',
  p_branch_ids uuid[] default null,
  p_sort_order integer default 0
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_plan_id uuid;
  v_branch_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('club_membership.plan.manage', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_name_ar is null or length(trim(p_name_ar)) = 0 then
    raise exception 'Arabic name is required';
  end if;

  if p_name_en is null or length(trim(p_name_en)) = 0 then
    raise exception 'English name is required';
  end if;

  if p_price < 0 then
    raise exception 'price must not be negative';
  end if;

  if p_duration_value <= 0 then
    raise exception 'duration value must be positive';
  end if;

  if p_duration_unit not in ('day', 'month', 'year') then
    raise exception 'invalid duration unit';
  end if;

  if p_branch_scope not in ('all_branches', 'selected_branches') then
    raise exception 'invalid branch scope';
  end if;

  if p_branch_scope = 'selected_branches' and (p_branch_ids is null or array_length(p_branch_ids, 1) = 0) then
    raise exception 'at least one branch must be selected when branch_scope is selected_branches';
  end if;

  insert into public.club_membership_plans (
    club_id, name_ar, name_en, description, price, duration_value, duration_unit,
    is_active, is_public, allow_renewal, allow_freeze, max_freeze_days_per_period,
    branch_scope, sort_order, created_by
  )
  values (
    p_club_id, trim(p_name_ar), trim(p_name_en), p_description, p_price, p_duration_value, p_duration_unit,
    p_is_active, p_is_public, p_allow_renewal, p_allow_freeze, p_max_freeze_days_per_period,
    p_branch_scope, p_sort_order, auth.uid()
  )
  returning id into v_plan_id;

  if p_branch_scope = 'selected_branches' then
    foreach v_branch_id in array p_branch_ids loop
      if not exists (select 1 from public.branches where id = v_branch_id and club_id = p_club_id) then
        raise exception 'branch % does not belong to this club', v_branch_id;
      end if;

      insert into public.club_membership_plan_branches (plan_id, branch_id)
      values (v_plan_id, v_branch_id)
      on conflict (plan_id, branch_id) do nothing;
    end loop;
  end if;

  perform public.write_audit_log(
    p_club_id, 'club_membership_plan.created', 'club_membership_plan', v_plan_id, null,
    jsonb_build_object('name_en', p_name_en, 'price', p_price, 'duration_value', p_duration_value, 'duration_unit', p_duration_unit),
    null
  );

  return v_plan_id;
end;
$$;

create or replace function public.update_club_membership_plan(
  p_plan_id uuid,
  p_name_ar text,
  p_name_en text,
  p_description text,
  p_price numeric,
  p_duration_value integer,
  p_duration_unit text,
  p_is_active boolean,
  p_is_public boolean,
  p_allow_renewal boolean,
  p_allow_freeze boolean,
  p_max_freeze_days_per_period integer,
  p_branch_scope text,
  p_branch_ids uuid[] default null,
  p_sort_order integer default 0
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_plan record;
  v_branch_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_plan from public.club_membership_plans where id = p_plan_id for update;

  if v_plan.id is null then
    raise exception 'plan not found';
  end if;

  if not (v_plan.club_id in (select public.user_club_ids()) and public.has_permission('club_membership.plan.manage', v_plan.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_plan.archived_at is not null then
    raise exception 'cannot edit an archived plan';
  end if;

  if p_name_ar is null or length(trim(p_name_ar)) = 0 then
    raise exception 'Arabic name is required';
  end if;

  if p_name_en is null or length(trim(p_name_en)) = 0 then
    raise exception 'English name is required';
  end if;

  if p_price < 0 then
    raise exception 'price must not be negative';
  end if;

  if p_duration_value <= 0 then
    raise exception 'duration value must be positive';
  end if;

  if p_duration_unit not in ('day', 'month', 'year') then
    raise exception 'invalid duration unit';
  end if;

  if p_branch_scope not in ('all_branches', 'selected_branches') then
    raise exception 'invalid branch scope';
  end if;

  if p_branch_scope = 'selected_branches' and (p_branch_ids is null or array_length(p_branch_ids, 1) = 0) then
    raise exception 'at least one branch must be selected when branch_scope is selected_branches';
  end if;

  -- NOTE: this updates the PLAN's live definition only. Existing
  -- club_membership_subscriptions rows carry their own immutable
  -- snapshot columns (protected by protect_club_membership_subscription_
  -- snapshot) and are never retroactively altered by this update --
  -- directive Section 8/28 historical-integrity requirement.
  update public.club_membership_plans set
    name_ar = trim(p_name_ar),
    name_en = trim(p_name_en),
    description = p_description,
    price = p_price,
    duration_value = p_duration_value,
    duration_unit = p_duration_unit,
    is_active = p_is_active,
    is_public = p_is_public,
    allow_renewal = p_allow_renewal,
    allow_freeze = p_allow_freeze,
    max_freeze_days_per_period = p_max_freeze_days_per_period,
    branch_scope = p_branch_scope,
    sort_order = p_sort_order,
    updated_at = now()
  where id = p_plan_id;

  delete from public.club_membership_plan_branches where plan_id = p_plan_id;

  if p_branch_scope = 'selected_branches' then
    foreach v_branch_id in array p_branch_ids loop
      if not exists (select 1 from public.branches where id = v_branch_id and club_id = v_plan.club_id) then
        raise exception 'branch % does not belong to this club', v_branch_id;
      end if;

      insert into public.club_membership_plan_branches (plan_id, branch_id)
      values (p_plan_id, v_branch_id)
      on conflict (plan_id, branch_id) do nothing;
    end loop;
  end if;

  perform public.write_audit_log(
    v_plan.club_id, 'club_membership_plan.updated', 'club_membership_plan', p_plan_id,
    jsonb_build_object('name_en', v_plan.name_en, 'price', v_plan.price, 'is_active', v_plan.is_active),
    jsonb_build_object('name_en', p_name_en, 'price', p_price, 'is_active', p_is_active),
    null
  );
end;
$$;

-- Archive (soft-delete equivalent) -- never a hard delete. Disabling a
-- plan must not cancel existing active memberships (directive Section
-- 29/30): this only prevents NEW purchases (sell_club_membership already
-- checks archived_at is null / is_active).
create or replace function public.archive_club_membership_plan(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_plan record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_plan from public.club_membership_plans where id = p_plan_id for update;

  if v_plan.id is null then
    raise exception 'plan not found';
  end if;

  if not (v_plan.club_id in (select public.user_club_ids()) and public.has_permission('club_membership.plan.manage', v_plan.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_plan.archived_at is not null then
    raise exception 'plan is already archived';
  end if;

  update public.club_membership_plans
  set archived_at = now(), is_active = false, updated_at = now()
  where id = p_plan_id;

  perform public.write_audit_log(
    v_plan.club_id, 'club_membership_plan.archived', 'club_membership_plan', p_plan_id,
    jsonb_build_object('was_active', v_plan.is_active), null,
    null
  );
end;
$$;

-- Restore an archived plan (reverses archive_club_membership_plan --
-- plan starts inactive on restore, staff must explicitly reactivate).
create or replace function public.restore_club_membership_plan(p_plan_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_plan record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_plan from public.club_membership_plans where id = p_plan_id for update;

  if v_plan.id is null then
    raise exception 'plan not found';
  end if;

  if not (v_plan.club_id in (select public.user_club_ids()) and public.has_permission('club_membership.plan.manage', v_plan.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_plan.archived_at is null then
    raise exception 'plan is not archived';
  end if;

  update public.club_membership_plans
  set archived_at = null, updated_at = now()
  where id = p_plan_id;

  perform public.write_audit_log(
    v_plan.club_id, 'club_membership_plan.restored', 'club_membership_plan', p_plan_id, null, null, null
  );
end;
$$;

grant execute on function public.create_club_membership_plan(uuid, text, text, text, numeric, integer, text, boolean, boolean, boolean, boolean, integer, text, uuid[], integer) to service_role, authenticated;
grant execute on function public.update_club_membership_plan(uuid, text, text, text, numeric, integer, text, boolean, boolean, boolean, boolean, integer, text, uuid[], integer) to service_role, authenticated;
grant execute on function public.archive_club_membership_plan(uuid) to service_role, authenticated;
grant execute on function public.restore_club_membership_plan(uuid) to service_role, authenticated;

revoke all on function public.create_club_membership_plan(uuid, text, text, text, numeric, integer, text, boolean, boolean, boolean, boolean, integer, text, uuid[], integer) from public, anon;
revoke all on function public.update_club_membership_plan(uuid, text, text, text, numeric, integer, text, boolean, boolean, boolean, boolean, integer, text, uuid[], integer) from public, anon;
revoke all on function public.archive_club_membership_plan(uuid) from public, anon;
revoke all on function public.restore_club_membership_plan(uuid) from public, anon;
