-- PLATFORM OWNER CONTROL IMPLEMENTATION -- Phase 4, continued: extend
-- update_platform_plan() to accept the new optional default_modules/
-- default_branch_limit/default_field_limit/default_academy_limit
-- columns added in 20260828230000_plan_entitlement_seeding.sql, so the
-- Platform Owner's existing plan-edit dialog can actually set them.
-- New parameters appended with defaults so this remains backward-
-- compatible with any caller still passing the old 4-arg form (none
-- exist outside PlatformPlansPage.tsx, updated in the same phase, but
-- kept safe regardless). Return type is public.platform_plans (the
-- table's row type) -- unaffected by the standing DROP-FUNCTION-for-
-- RETURNS-TABLE-shape-change invariant, since this is a composite table
-- type that already picked up the new nullable columns via ALTER TABLE,
-- not a function-declared RETURNS TABLE(...) shape.
create or replace function public.update_platform_plan(
  p_plan_id uuid,
  p_name_ar text,
  p_price numeric,
  p_reason text default null,
  p_default_modules text[] default null,
  p_default_branch_limit integer default null,
  p_default_field_limit integer default null,
  p_default_academy_limit integer default null
)
returns public.platform_plans
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before public.platform_plans;
  v_after public.platform_plans;
  v_module text;
begin
  if not public.is_platform_owner() then raise exception 'FORBIDDEN'; end if;
  if nullif(btrim(p_name_ar), '') is null then raise exception 'PLAN_NAME_REQUIRED'; end if;
  if p_price is null or p_price <= 0 then raise exception 'PLAN_PRICE_INVALID'; end if;
  select * into v_before from public.platform_plans where id = p_plan_id for update;
  if v_before.id is null then raise exception 'PLAN_NOT_FOUND'; end if;

  if p_default_modules is not null then
    foreach v_module in array p_default_modules loop
      if v_module not in ('fields', 'academy', 'shop', 'club_membership') then
        raise exception 'unknown module in default_modules: %', v_module;
      end if;
    end loop;
  end if;

  update public.platform_plans set
    name_ar = btrim(p_name_ar),
    price = p_price,
    default_modules = p_default_modules,
    default_branch_limit = p_default_branch_limit,
    default_field_limit = p_default_field_limit,
    default_academy_limit = p_default_academy_limit
  where id = p_plan_id returning * into v_after;
  perform public.write_audit_log(null, 'platform_plan.updated', 'platform_plan',
    v_before.id, to_jsonb(v_before), to_jsonb(v_after), nullif(btrim(p_reason), ''));
  return v_after;
end;
$$;

revoke all on function public.update_platform_plan(uuid, text, numeric, text, text[], integer, integer, integer) from public, anon;
grant execute on function public.update_platform_plan(uuid, text, numeric, text, text[], integer, integer, integer) to authenticated;

-- Drop the old 4-arg signature -- fully replaced, not overloaded (same
-- convention used elsewhere in this codebase, e.g.
-- create_platform_subscription's own header comment), to avoid two
-- divergent code paths for the same action. Frontend updated in the
-- same phase to call the new 8-arg signature.
drop function if exists public.update_platform_plan(uuid, text, numeric, text);
