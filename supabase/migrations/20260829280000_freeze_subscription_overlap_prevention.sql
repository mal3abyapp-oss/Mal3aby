-- SAAS ACCEPTANCE REVIEW -- Club Owner journey audit findings D2/D3
-- (2026-08-29), P2: freeze_subscription() allowed creating overlapping
-- date ranges for the same subscription with no check at all, which
-- then caused two downstream problems: (1)
-- get_subscription_effective_end_date() SUMS every freeze's duration
-- rather than unioning overlapping ranges, so two overlapping freezes
-- overstate the effective expiry extension by the overlap amount; (2)
-- unfreeze_subscription() only resolves the single most-recent
-- "current" freeze row (order by start_date desc limit 1), silently
-- orphaning any earlier overlapping freeze row still active in the
-- table.
--
-- The cleanest fix for both symptoms is to prevent the root cause:
-- reject a new freeze whose date range overlaps any existing,
-- non-expired freeze on the same subscription. This keeps the
-- existing single-row-resolution logic in
-- get_subscription_effective_end_date()/unfreeze_subscription()
-- correct by construction (there is never more than one relevant
-- freeze row to resolve), rather than rewriting both of those to
-- handle a multi-freeze-overlap case that shouldn't be reachable in
-- the first place.
create or replace function public.freeze_subscription(p_subscription_id uuid, p_start_date date, p_end_date date, p_reason text DEFAULT NULL::text, p_extends_expiry boolean DEFAULT true)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sub record;
  v_branch_id uuid;
  v_freeze_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_sub
  from public.subscriptions
  where id = p_subscription_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('subscription.freeze.create', club_id);

  if v_sub.id is null then
    raise exception 'subscription not found or you do not have permission to freeze it';
  end if;

  select g.branch_id into v_branch_id
  from public.enrollments e
  join public.groups g on g.id = e.group_id
  where e.id = v_sub.enrollment_id;

  if not public.user_has_branch_access(v_sub.club_id, v_branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if v_sub.status not in ('active', 'frozen') then
    raise exception 'only an active subscription can be frozen';
  end if;

  if p_end_date <= p_start_date then
    raise exception 'end date must be after start date';
  end if;

  if exists (
    select 1 from public.subscription_freezes
    where subscription_id = p_subscription_id
      and daterange(start_date, end_date, '[]') && daterange(p_start_date, p_end_date, '[]')
  ) then
    raise exception 'this freeze period overlaps an existing freeze on this subscription -- unfreeze or adjust the existing one first';
  end if;

  insert into public.subscription_freezes (club_id, subscription_id, start_date, end_date, reason, extends_expiry, created_by)
  values (v_sub.club_id, p_subscription_id, p_start_date, p_end_date, p_reason, p_extends_expiry, auth.uid())
  returning id into v_freeze_id;

  perform set_config('app.allow_subscription_status_transition', 'true', true);
  update public.subscriptions set status = 'frozen' where id = p_subscription_id;

  perform public.write_audit_log(v_sub.club_id, 'subscription.freeze', 'subscription', p_subscription_id, null, jsonb_build_object('start_date', p_start_date, 'end_date', p_end_date, 'extends_expiry', p_extends_expiry), p_reason);

  return v_freeze_id;
end;
$function$;
