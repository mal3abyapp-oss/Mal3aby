-- Audited lifecycle operations for mutable product definitions.
-- Financial and operational history deliberately remains immutable: academy
-- subscriptions and invoices keep their captured price when a membership's
-- future-sale price changes.

create or replace function public.update_payment_method_config(
  p_config_id uuid,
  p_provider text,
  p_name_ar text,
  p_name_en text,
  p_instructions_ar text,
  p_instructions_en text,
  p_details jsonb,
  p_customer_visible boolean,
  p_is_active boolean,
  p_reason text default null
)
returns public.payment_method_configs
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before public.payment_method_configs;
  v_after public.payment_method_configs;
begin
  select * into v_before
  from public.payment_method_configs
  where id = p_config_id
  for update;

  if v_before.id is null then raise exception 'PAYMENT_METHOD_NOT_FOUND'; end if;
  if not public.has_permission('payment.methods.manage', v_before.club_id) then
    raise exception 'FORBIDDEN';
  end if;
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

revoke all on function public.update_payment_method_config(uuid, text, text, text, text, text, jsonb, boolean, boolean, text) from public, anon;
grant execute on function public.update_payment_method_config(uuid, text, text, text, text, text, jsonb, boolean, boolean, text) to authenticated;

create or replace function public.update_academy_membership(
  p_group_id uuid,
  p_name text,
  p_capacity integer,
  p_subscription_price numeric,
  p_status text,
  p_reason text default null
)
returns public.groups
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before public.groups;
  v_after public.groups;
begin
  select * into v_before from public.groups where id = p_group_id for update;
  if v_before.id is null then raise exception 'ACADEMY_MEMBERSHIP_NOT_FOUND'; end if;
  if not public.has_permission('academy.program.manage', v_before.club_id) then
    raise exception 'FORBIDDEN';
  end if;
  if nullif(btrim(p_name), '') is null then raise exception 'MEMBERSHIP_NAME_REQUIRED'; end if;
  if p_capacity < 1 then raise exception 'MEMBERSHIP_CAPACITY_INVALID'; end if;
  if p_subscription_price is null or p_subscription_price < 0 then
    raise exception 'MEMBERSHIP_PRICE_INVALID';
  end if;
  if p_status not in ('active', 'closed') then raise exception 'MEMBERSHIP_STATUS_INVALID'; end if;

  update public.groups
  set name = btrim(p_name), capacity = p_capacity,
      subscription_price = p_subscription_price, status = p_status
  where id = p_group_id
  returning * into v_after;

  perform public.write_audit_log(v_before.club_id, 'academy_membership.updated',
    'academy_membership', v_before.id, to_jsonb(v_before), to_jsonb(v_after),
    nullif(btrim(p_reason), ''));
  return v_after;
end;
$$;

revoke all on function public.update_academy_membership(uuid, text, integer, numeric, text, text) from public, anon;
grant execute on function public.update_academy_membership(uuid, text, integer, numeric, text, text) to authenticated;

create or replace function public.update_platform_plan(
  p_plan_id uuid,
  p_name_ar text,
  p_price numeric,
  p_reason text default null
)
returns public.platform_plans
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before public.platform_plans;
  v_after public.platform_plans;
begin
  if not public.is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  if nullif(btrim(p_name_ar), '') is null then raise exception 'PLAN_NAME_REQUIRED'; end if;
  if p_price is null or p_price <= 0 then raise exception 'PLAN_PRICE_INVALID'; end if;
  select * into v_before from public.platform_plans where id = p_plan_id for update;
  if v_before.id is null then raise exception 'PLAN_NOT_FOUND'; end if;

  update public.platform_plans set name_ar = btrim(p_name_ar), price = p_price
  where id = p_plan_id returning * into v_after;
  perform public.write_audit_log(null, 'platform_plan.updated', 'platform_plan',
    v_before.id, to_jsonb(v_before), to_jsonb(v_after), nullif(btrim(p_reason), ''));
  return v_after;
end;
$$;

revoke all on function public.update_platform_plan(uuid, text, numeric, text) from public, anon;
grant execute on function public.update_platform_plan(uuid, text, numeric, text) to authenticated;
