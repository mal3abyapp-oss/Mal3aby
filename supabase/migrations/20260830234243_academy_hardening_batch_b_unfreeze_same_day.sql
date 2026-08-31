-- ACADEMY OPERATIONS FULL AUTONOMOUS PRODUCTION HARDENING, Batch B:
-- fixes AC8, discovered live while testing AC3's fix in the same
-- session (pre-existing, not introduced by AC3).
--
-- unfreeze_subscription() unfreezing a subscription on the SAME DAY
-- its freeze started attempted `UPDATE subscription_freezes SET
-- end_date = current_date` where start_date already equals
-- current_date -- violating subscription_freezes_valid_period: CHECK
-- (end_date > start_date). Live-reproduced: freeze_subscription(...,
-- p_start_date := current_date, ...) then immediately
-- unfreeze_subscription(...) raised a raw constraint-violation error
-- and left the subscription stuck in 'frozen' status (the whole
-- transaction correctly rolled back -- no partial corruption -- but
-- the legitimate "I froze this by mistake, undo it right now" action
-- was completely blocked for any same-day freeze).
--
-- Fix: a freeze whose start_date is TODAY (not just strictly future)
-- represents zero elapsed frozen days -- deleting the row entirely is
-- correct, same as the existing future-start branch, rather than
-- trying to set end_date = current_date (which only ever produces a
-- valid range when start_date was strictly in the past).
create or replace function public.unfreeze_subscription(p_subscription_id uuid, p_reason text DEFAULT NULL::text)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_sub record;
  v_branch_id uuid;
  v_open_freeze record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_sub
  from public.subscriptions
  where id = p_subscription_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('subscription.freeze.create', club_id)
  for update;

  if v_sub.id is null then
    raise exception 'subscription not found or you do not have permission to unfreeze it';
  end if;

  select g.branch_id into v_branch_id
  from public.enrollments e
  join public.groups g on g.id = e.group_id
  where e.id = v_sub.enrollment_id;

  if not public.user_has_branch_access(v_sub.club_id, v_branch_id) then
    raise exception 'you do not have access to this branch';
  end if;

  if v_sub.status != 'frozen' then
    raise exception 'subscription is not currently frozen';
  end if;

  select * into v_open_freeze from public.subscription_freezes
  where subscription_id = p_subscription_id and end_date >= current_date
  order by start_date desc
  limit 1
  for update;

  if v_open_freeze.id is not null and v_open_freeze.end_date > current_date then
    -- AC8 fix: start_date >= current_date (today OR future) both
    -- represent zero effectively-elapsed frozen days as of "now" --
    -- delete the row entirely. Only a freeze that genuinely started
    -- in the past gets its end_date trimmed to today (the only case
    -- where end_date = current_date > start_date is a valid range).
    if v_open_freeze.start_date >= current_date then
      delete from public.subscription_freezes where id = v_open_freeze.id;
    else
      update public.subscription_freezes set end_date = current_date where id = v_open_freeze.id;
    end if;
  end if;

  perform set_config('app.allow_subscription_status_transition', 'true', true);
  update public.subscriptions set status = 'active' where id = p_subscription_id;

  perform public.write_audit_log(
    v_sub.club_id, 'subscription.unfreeze', 'subscription', p_subscription_id, null,
    jsonb_build_object('ended_freeze_id', v_open_freeze.id),
    p_reason
  );
end;
$function$;
