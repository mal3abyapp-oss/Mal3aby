-- Gate 4 (Memberships / Subscriptions / Operational Entitlements) --
-- scoping found real, existing subscription machinery is more mature
-- than a first read of Doc 3 suggested: subscriptions.status already
-- has a clean model (pending/active/frozen/expired/cancelled),
-- freeze_subscription() already exists with a proper history table
-- (subscription_freezes, never overwritten/erased) and reason/audit
-- logging, and get_subscription_effective_end_date() already correctly
-- sums all extends_expiry freeze periods.
--
-- Genuine gaps found (not assumed -- verified there is no existing RPC
-- for either): a frozen subscription had NO way back to active except
-- a direct table UPDATE via subscriptions_update RLS (bypassing
-- write_audit_log entirely, unlike every other subscription state
-- change in this schema), and there was no dedicated academy
-- subscription cancellation RPC at all (cancel_platform_subscription/
-- renew_platform_subscription exist but are for the PLATFORM/
-- commercial subscription -- a different concept, same naming
-- collision Doc 3 itself warns about).

-- ============================================================
-- unfreeze_subscription: returns a frozen subscription to active.
-- If unfreezing before the freeze's originally scheduled end_date, the
-- freeze record's end_date is shortened to today so
-- get_subscription_effective_end_date() doesn't keep crediting unused
-- freeze days the member never actually took -- the freeze HISTORY
-- itself is never deleted, only the still-open-ended portion is closed
-- out, matching this schema's own "never erase subscription history"
-- principle (a shortened freeze record still shows the real dates it
-- was active for).
-- ============================================================
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

  -- The most recent freeze record for this subscription that hasn't
  -- yet reached its own end_date is the one being ended early.
  select * into v_open_freeze from public.subscription_freezes
  where subscription_id = p_subscription_id and end_date >= current_date
  order by start_date desc
  limit 1
  for update;

  if v_open_freeze.id is not null and v_open_freeze.end_date > current_date then
    update public.subscription_freezes set end_date = current_date where id = v_open_freeze.id;
  end if;

  update public.subscriptions set status = 'active' where id = p_subscription_id;

  perform public.write_audit_log(
    v_sub.club_id, 'subscription.unfreeze', 'subscription', p_subscription_id, null,
    jsonb_build_object('ended_freeze_id', v_open_freeze.id),
    p_reason
  );
end;
$$;

revoke execute on function public.unfreeze_subscription(uuid, text) from public, anon;
grant execute on function public.unfreeze_subscription(uuid, text) to authenticated;

-- ============================================================
-- cancel_subscription: the missing dedicated academy-subscription
-- cancellation operation (distinct from cancel_platform_subscription,
-- which is the platform/commercial billing concept). Records a reason,
-- writes an audit log entry, and -- like every other lifecycle
-- operation in this schema -- never deletes the subscription row or
-- any of its history (freezes, payments, invoice) -- it only marks
-- status='cancelled', which every downstream read (entitlement checks,
-- reporting, the portal) can key off directly.
-- ============================================================
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

  update public.subscriptions set status = 'cancelled' where id = p_subscription_id;

  perform public.write_audit_log(
    v_sub.club_id, 'subscription.cancel', 'subscription', p_subscription_id,
    jsonb_build_object('previous_status', v_sub.status), null,
    p_reason
  );
end;
$$;

revoke execute on function public.cancel_subscription(uuid, text) from public, anon;
grant execute on function public.cancel_subscription(uuid, text) to authenticated;
