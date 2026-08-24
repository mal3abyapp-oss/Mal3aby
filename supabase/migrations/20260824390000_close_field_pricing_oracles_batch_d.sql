-- SYSTEMIC CROSS-TENANT EXISTENCE-ORACLE CLOSURE -- Batch D (field
-- pricing helpers, final batch): create_field_pricing_rules,
-- archive_field_pricing_rules. Same class and fix shape as batches
-- A/B/C. This closes the last of the RPCs identified in the original
-- sweep.
--
-- LIVE-PROVEN before this fix (real Coach account, member of exactly
-- one club, real foreign-existing-id vs real-nonexistent-id pairs):
--   create_field_pricing_rules: 'FORBIDDEN' vs 'FIELD_NOT_FOUND' -- DISTINGUISHABLE
--   archive_field_pricing_rules: 'FORBIDDEN' vs 'FIELD_NOT_FOUND' -- DISTINGUISHABLE
--
-- FIX: collapse lookup + club/permission (+ branch-access) check into
-- one WHERE clause per function. All downstream business logic
-- (pricing-rules-array validation, rule-count match check on both
-- insert and archive) preserved verbatim from the current live
-- definitions (re-read via pg_get_functiondef immediately before
-- writing this migration).

create or replace function public.create_field_pricing_rules(p_field_id uuid, p_rules jsonb, p_reason text default null::text)
returns SETOF pricing_rules
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_field public.fields; v_created jsonb;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED'; end if;

  select * into v_field
  from public.fields
  where id = p_field_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('pricing.update', club_id)
    and public.user_has_branch_access(club_id, branch_id)
  for share;

  if v_field.id is null then raise exception 'FIELD_NOT_FOUND_OR_NOT_AUTHORIZED'; end if;

  if p_rules is null or jsonb_typeof(p_rules) <> 'array' or jsonb_array_length(p_rules)=0 then
    raise exception 'PRICING_RULES_REQUIRED'; end if;

  with inserted as (
    insert into public.pricing_rules(club_id,field_id,day_of_week,date_specific,start_time,end_time,price_per_hour,priority)
    select v_field.club_id,p_field_id,r.day_of_week,r.date_specific,r.start_time,r.end_time,r.price_per_hour,r.priority
    from jsonb_to_recordset(p_rules) as r(day_of_week int,date_specific date,start_time time,end_time time,price_per_hour numeric,priority int)
    where r.price_per_hour > 0 and r.start_time < r.end_time
    returning *
  ) select coalesce(jsonb_agg(to_jsonb(inserted)),'[]'::jsonb) into v_created from inserted;
  if jsonb_array_length(v_created) <> jsonb_array_length(p_rules) then raise exception 'PRICING_RULE_INVALID'; end if;
  perform public.write_audit_log(v_field.club_id,'field_pricing.created','field',p_field_id,null,v_created,nullif(btrim(p_reason),''));
  return query select * from public.pricing_rules where id in (select (x->>'id')::uuid from jsonb_array_elements(v_created) x);
end
$$;

create or replace function public.archive_field_pricing_rules(p_field_id uuid, p_rule_ids uuid[], p_reason text default null::text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare v_field public.fields; v_before jsonb;
begin
  if auth.uid() is null then raise exception 'AUTHENTICATION_REQUIRED'; end if;

  select * into v_field
  from public.fields
  where id = p_field_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('pricing.update', club_id)
    and public.user_has_branch_access(club_id, branch_id)
  for share;

  if v_field.id is null then raise exception 'FIELD_NOT_FOUND_OR_NOT_AUTHORIZED'; end if;

  perform 1 from public.pricing_rules pr where pr.id=any(p_rule_ids) and pr.field_id=p_field_id for update;
  select coalesce(jsonb_agg(to_jsonb(pr)),'[]'::jsonb) into v_before
  from public.pricing_rules pr where pr.id=any(p_rule_ids) and pr.field_id=p_field_id;
  if jsonb_array_length(v_before) <> cardinality(p_rule_ids) then raise exception 'PRICING_RULE_NOT_FOUND'; end if;
  delete from public.pricing_rules where id=any(p_rule_ids) and field_id=p_field_id;
  perform public.write_audit_log(v_field.club_id,'field_pricing.archived','field',p_field_id,v_before,null,nullif(btrim(p_reason),''));
end
$$;

-- Both signatures unchanged -- in-place replace, grants untouched.
