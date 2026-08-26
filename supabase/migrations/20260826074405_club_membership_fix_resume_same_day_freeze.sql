-- Fix: resume_club_membership crashed when the open freeze started TODAY
-- -- truncating its end_date to today produced end_date <= start_date,
-- violating the strict end_date > start_date check constraint. A freeze
-- that started today and is resumed today is a legitimate zero-net-effect
-- case (delete it), not an error -- caught live during Club Membership
-- freeze/resume test matrix before reaching any real customer.
create or replace function public.resume_club_membership(
  p_membership_subscription_id uuid,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sub record;
  v_open_freeze record;
  v_today date;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select s.* into v_sub
  from public.club_membership_subscriptions s
  where s.id = p_membership_subscription_id
    and s.club_id in (select public.user_club_ids())
    and public.has_permission('club_membership.freeze', s.club_id)
  for update;

  if v_sub.id is null then
    raise exception 'club membership not found or you do not have permission to resume it';
  end if;

  if v_sub.status != 'frozen' then
    raise exception 'membership is not currently frozen';
  end if;

  select (day_start at time zone (select timezone from public.clubs where id = v_sub.club_id))::date
    into v_today
    from public.club_local_day_bounds(v_sub.club_id, current_date);

  select * into v_open_freeze from public.club_membership_freezes
  where membership_subscription_id = p_membership_subscription_id and end_date >= v_today
  order by start_date desc
  limit 1
  for update;

  if v_open_freeze.id is not null then
    -- A freeze that has not started yet (future start_date), OR one that
    -- started TODAY (truncating end_date to v_today would produce
    -- end_date <= start_date, violating the table's strict end_date >
    -- start_date check -- a same-day freeze-then-resume is a legitimate
    -- zero-net-effect case, not an error), is deleted entirely rather
    -- than truncated to an invalid zero/negative-length range.
    if v_open_freeze.start_date >= v_today then
      delete from public.club_membership_freezes where id = v_open_freeze.id;
    else
      update public.club_membership_freezes set end_date = v_today where id = v_open_freeze.id;
    end if;
  end if;

  perform set_config('app.allow_club_membership_status_transition', 'true', true);
  update public.club_membership_subscriptions set status = 'active' where id = p_membership_subscription_id;

  perform public.write_audit_log(
    v_sub.club_id, 'club_membership.resumed', 'club_membership_subscription', p_membership_subscription_id, null,
    jsonb_build_object('ended_freeze_id', v_open_freeze.id),
    p_reason
  );
end;
$$;
