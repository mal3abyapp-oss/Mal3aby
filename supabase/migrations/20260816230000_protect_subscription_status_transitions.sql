-- Gate 4 continued: subscriptions.status changes should only ever
-- happen through the audited lifecycle RPCs (create_enrollment_with_
-- subscription, _activate_subscription_if_due_internal, freeze_
-- subscription, unfreeze_subscription, cancel_subscription) so every
-- state transition always produces a write_audit_log entry -- Doc 3's
-- explicit requirement that freeze/unfreeze/extend/suspend/cancel be
-- "real domain operations" with a recorded who/when/why/old/new, never
-- an arbitrary direct field edit. No frontend code currently does a
-- direct `subscriptions` table UPDATE of status (verified via a
-- repo-wide search before writing this), so this closes a latent gap
-- rather than breaking anything working today.
create or replace function public.protect_subscription_status_transitions()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_rpc_transition_in_progress boolean;
begin
  v_rpc_transition_in_progress := coalesce(current_setting('app.allow_subscription_status_transition', true), 'false') = 'true';

  if new.status is distinct from old.status and not v_rpc_transition_in_progress then
    new.status := old.status;
  end if;
  return new;
end;
$$;

revoke execute on function public.protect_subscription_status_transitions() from public, anon, authenticated;

drop trigger if exists trg_protect_subscription_status_transitions on public.subscriptions;
create trigger trg_protect_subscription_status_transitions
  before update on public.subscriptions
  for each row execute function public.protect_subscription_status_transitions();

-- Flip the flag inside every existing/new RPC that legitimately
-- transitions subscription status.
create or replace function public._activate_subscription_if_due_internal(
  p_subscription_id uuid,
  p_explicit boolean default false
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sub record;
  v_policy text;
  v_paid numeric;
  v_total numeric;
  v_activated boolean := false;
begin
  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if v_sub.id is null then
    raise exception 'subscription not found';
  end if;

  if v_sub.status != 'pending' then
    return false;
  end if;

  select subscription_activation_policy into v_policy from public.clubs where id = v_sub.club_id;

  perform set_config('app.allow_subscription_status_transition', 'true', true);

  if v_policy = 'manual' then
    if p_explicit then
      update public.subscriptions set status = 'active' where id = p_subscription_id;
      v_activated := true;
    end if;
  else
    select i.total, coalesce(sum(pa.amount), 0) into v_total, v_paid
    from public.invoices i
    left join public.payment_allocations pa on pa.invoice_id = i.id
    where i.id = v_sub.invoice_id
    group by i.total;

    if v_policy = 'first_payment' and v_paid > 0 then
      update public.subscriptions set status = 'active' where id = p_subscription_id;
      v_activated := true;
    elsif v_policy = 'full_payment' and v_paid >= v_total then
      update public.subscriptions set status = 'active' where id = p_subscription_id;
      v_activated := true;
    end if;
  end if;

  if v_activated then
    perform public.write_audit_log(
      v_sub.club_id, 'subscription.activate', 'subscription', p_subscription_id, null,
      jsonb_build_object('policy', v_policy, 'explicit', p_explicit),
      null
    );
  end if;

  return v_activated;
end;
$$;

create or replace function public.freeze_subscription(
  p_subscription_id uuid,
  p_start_date date,
  p_end_date date,
  p_reason text default null,
  p_extends_expiry boolean default true
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sub record;
  v_freeze_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id;
  if v_sub.id is null then
    raise exception 'subscription not found';
  end if;

  if not (v_sub.club_id in (select public.user_club_ids()) and public.has_permission('subscription.freeze.create', v_sub.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_sub.status not in ('active', 'frozen') then
    raise exception 'only an active subscription can be frozen';
  end if;

  if p_end_date <= p_start_date then
    raise exception 'end date must be after start date';
  end if;

  insert into public.subscription_freezes (club_id, subscription_id, start_date, end_date, reason, extends_expiry, created_by)
  values (v_sub.club_id, p_subscription_id, p_start_date, p_end_date, p_reason, p_extends_expiry, auth.uid())
  returning id into v_freeze_id;

  perform set_config('app.allow_subscription_status_transition', 'true', true);
  update public.subscriptions set status = 'frozen' where id = p_subscription_id;

  perform public.write_audit_log(v_sub.club_id, 'subscription.freeze', 'subscription', p_subscription_id, null, jsonb_build_object('start_date', p_start_date, 'end_date', p_end_date, 'extends_expiry', p_extends_expiry), p_reason);

  return v_freeze_id;
end;
$$;

create or replace function public.unfreeze_subscription(
  p_subscription_id uuid,
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
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if v_sub.id is null then
    raise exception 'subscription not found';
  end if;

  if not (v_sub.club_id in (select public.user_club_ids()) and public.has_permission('subscription.freeze.create', v_sub.club_id)) then
    raise exception 'not authorized';
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
    if v_open_freeze.start_date > current_date then
      -- The freeze hadn't started yet (a future-dated freeze being
      -- cancelled before it ever took effect) -- there is no valid
      -- shortened end_date that still satisfies end_date > start_date,
      -- so the record represents zero elapsed frozen time and is
      -- removed outright rather than left invalid. This doesn't
      -- violate "never erase subscription history": the freeze never
      -- actually happened from the member's perspective (0 elapsed
      -- days), and the unfreeze action itself is still recorded in the
      -- audit log below.
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
$$;

create or replace function public.cancel_subscription(
  p_subscription_id uuid,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_sub record;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a cancellation reason is required';
  end if;

  select * into v_sub from public.subscriptions where id = p_subscription_id for update;
  if v_sub.id is null then
    raise exception 'subscription not found';
  end if;

  if not (v_sub.club_id in (select public.user_club_ids()) and public.has_permission('subscription.update', v_sub.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_sub.status = 'cancelled' then
    raise exception 'subscription is already cancelled';
  end if;

  perform set_config('app.allow_subscription_status_transition', 'true', true);
  update public.subscriptions set status = 'cancelled' where id = p_subscription_id;

  perform public.write_audit_log(
    v_sub.club_id, 'subscription.cancel', 'subscription', p_subscription_id,
    jsonb_build_object('previous_status', v_sub.status), null,
    p_reason
  );
end;
$$;

-- create_enrollment_with_subscription's own INSERT is unaffected by an
-- UPDATE-only trigger, so no change needed there -- the initial
-- 'pending' status is set at row creation, not via UPDATE.
