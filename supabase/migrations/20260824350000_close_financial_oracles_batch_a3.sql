-- SYSTEMIC CROSS-TENANT EXISTENCE-ORACLE CLOSURE -- Batch A3
-- (Financial/staff-privilege integrity, part 3 of 4):
-- set_staff_cash_custody, deactivate_staff_member,
-- reactivate_staff_member, update_payment_method_config. Same class,
-- same fix shape as batches A1/A2.
--
-- LIVE-PROVEN before this fix (real Coach account, member of exactly
-- one club, real foreign-existing-id vs real-nonexistent-id pairs):
--   set_staff_cash_custody: 'not authorized' vs 'membership not found' -- DISTINGUISHABLE
--   deactivate_staff_member: 'not authorized' vs 'membership not found' -- DISTINGUISHABLE
--   reactivate_staff_member: 'not authorized' vs 'membership not found' -- DISTINGUISHABLE
--   update_payment_method_config: 'FORBIDDEN' vs 'PAYMENT_METHOD_NOT_FOUND' -- DISTINGUISHABLE
--
-- FIX: collapse lookup + club/permission check into one WHERE clause
-- per function. All downstream business logic (open-cash-shift block
-- on custody removal / on suspension, name/details validation)
-- preserved verbatim from the current live definitions (re-read via
-- pg_get_functiondef immediately before writing this migration).

create or replace function public.set_staff_cash_custody(p_membership_id uuid, p_has_custody boolean)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_membership record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership
  from public.club_memberships
  where id = p_membership_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('staff.update', club_id);

  if v_membership.id is null then
    raise exception 'membership not found or you do not have permission to update it';
  end if;

  if p_has_custody = false and v_membership.has_cash_custody = true then
    if exists (
      select 1 from public.cash_shifts
      where opened_by = v_membership.user_id and club_id = v_membership.club_id and status = 'open'
    ) then
      raise exception 'this employee has an open cash shift -- close it before removing cash custody';
    end if;
  end if;

  update public.club_memberships set has_cash_custody = p_has_custody, updated_at = now()
  where id = p_membership_id;

  perform public.write_audit_log(
    v_membership.club_id, 'staff.cash_custody.set', 'club_membership', p_membership_id,
    jsonb_build_object('has_cash_custody', v_membership.has_cash_custody),
    jsonb_build_object('has_cash_custody', p_has_custody),
    null
  );
end;
$$;

create or replace function public.deactivate_staff_member(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_membership record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership
  from public.club_memberships
  where id = p_membership_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('staff.update', club_id);

  if v_membership.id is null then
    raise exception 'membership not found or you do not have permission to update it';
  end if;

  if exists (
    select 1 from public.cash_shifts
    where opened_by = v_membership.user_id and club_id = v_membership.club_id and status = 'open'
  ) then
    raise exception 'this employee has an open cash shift -- close it before suspending';
  end if;

  update public.club_memberships
  set status = 'inactive', updated_at = now()
  where id = p_membership_id;

  perform public.write_audit_log(
    v_membership.club_id, 'staff.suspended', 'club_membership', p_membership_id,
    jsonb_build_object('status', v_membership.status),
    jsonb_build_object('status', 'inactive'),
    null
  );
end;
$$;

create or replace function public.reactivate_staff_member(p_membership_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_membership record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership
  from public.club_memberships
  where id = p_membership_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('staff.update', club_id);

  if v_membership.id is null then
    raise exception 'membership not found or you do not have permission to update it';
  end if;

  update public.club_memberships
  set status = 'active', updated_at = now()
  where id = p_membership_id;

  perform public.write_audit_log(
    v_membership.club_id, 'staff.reactivated', 'club_membership', p_membership_id,
    jsonb_build_object('status', v_membership.status),
    jsonb_build_object('status', 'active'),
    null
  );
end;
$$;

create or replace function public.update_payment_method_config(
  p_config_id uuid, p_provider text, p_name_ar text, p_name_en text,
  p_instructions_ar text, p_instructions_en text, p_details jsonb,
  p_customer_visible boolean, p_is_active boolean, p_reason text default null::text
)
returns payment_method_configs
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.payment_method_configs;
  v_after public.payment_method_configs;
begin
  select * into v_before
  from public.payment_method_configs
  where id = p_config_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('payment.methods.manage', club_id)
  for update;

  if v_before.id is null then raise exception 'PAYMENT_METHOD_NOT_FOUND_OR_NOT_AUTHORIZED'; end if;
  if nullif(btrim(p_name_ar), '') is null or nullif(btrim(p_name_en), '') is null then
    raise exception 'PAYMENT_METHOD_NAME_REQUIRED';
  end if;
  if p_details is null or jsonb_typeof(p_details) <> 'object' then
    raise exception 'PAYMENT_METHOD_DETAILS_INVALID';
  end if;

  update public.payment_method_configs
  set provider = nullif(btrim(p_provider), ''),
      name_ar = btrim(p_name_ar),
      name_en = btrim(p_name_en),
      instructions_ar = nullif(btrim(p_instructions_ar), ''),
      instructions_en = nullif(btrim(p_instructions_en), ''),
      details = p_details,
      customer_visible = p_customer_visible,
      is_active = p_is_active
  where id = p_config_id
  returning * into v_after;

  perform public.write_audit_log(v_before.club_id, 'payment_method.updated',
    'payment_method_config', v_before.id, to_jsonb(v_before), to_jsonb(v_after),
    nullif(btrim(p_reason), ''));
  return v_after;
end;
$$;

-- All 4 signatures unchanged -- in-place replace, grants untouched.
