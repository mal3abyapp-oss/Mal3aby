-- Phase E RPCs: renewal (E4) and expiry (E5 -- ACTIVE/DUE/EXPIRED/
-- CANCELLED). Both build on the schema fix in the prior migration
-- (subscriptions_one_non_terminal_per_enrollment) that made a genuine
-- new-period renewal possible for the first time.

begin;

-- E4: creates a NEW subscription row for the same enrollment -- never
-- touches the prior period's row. Only callable once the current
-- subscription for that enrollment has reached a terminal status
-- (expired/cancelled) -- the partial unique index would reject a
-- second non-terminal row anyway, but this gives a clear error instead
-- of a raw constraint-violation message.
create or replace function public.renew_academy_subscription(
  p_enrollment_id uuid,
  p_start_date date,
  p_end_date date,
  p_price numeric,
  p_discount numeric default 0
)
returns table(subscription_id uuid, invoice_id uuid)
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_enrollment record;
  v_club_id uuid;
  v_branch_id uuid;
  v_current_status text;
  v_net_price numeric;
  v_billing_customer_id uuid;
  v_invoice_number text;
  v_invoice_id uuid;
  v_subscription_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select e.* into v_enrollment from public.enrollments e where e.id = p_enrollment_id;
  if v_enrollment.id is null then
    raise exception 'enrollment not found';
  end if;
  v_club_id := v_enrollment.club_id;

  select g.branch_id into v_branch_id from public.groups g where g.id = v_enrollment.group_id;

  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('enrollment.create', v_club_id)) then
    raise exception 'not authorized';
  end if;

  if not public.club_write_allowed(v_club_id, 'new_commitment') then
    raise exception 'club subscription does not allow new commitments';
  end if;

  if v_enrollment.status != 'active' then
    raise exception 'cannot renew a subscription for an enrollment that is not active';
  end if;

  select status into v_current_status from public.subscriptions
  where enrollment_id = p_enrollment_id
  order by created_at desc limit 1;

  if v_current_status is not null and v_current_status in ('pending', 'active', 'frozen') then
    raise exception 'this enrollment already has an active or pending subscription -- it must reach expired/cancelled before renewing';
  end if;

  if p_end_date <= p_start_date then
    raise exception 'end date must be after start date';
  end if;

  v_net_price := round(greatest(p_price - p_discount, 0), 2);

  v_billing_customer_id := coalesce(
    v_enrollment.guardian_id,
    (select gl.customer_id from public.guardian_links gl where gl.player_id = v_enrollment.player_id and gl.is_primary limit 1)
  );
  if v_billing_customer_id is null then
    raise exception 'no billing guardian: link a primary guardian to this player first';
  end if;

  v_invoice_number := public.issue_invoice_number(v_branch_id, v_club_id);
  insert into public.invoices (club_id, branch_id, invoice_number, customer_id, status, subtotal, discount, total, issued_at, created_by)
  values (v_club_id, v_branch_id, v_invoice_number, v_billing_customer_id, 'issued', p_price, p_discount, v_net_price, now(), auth.uid())
  returning id into v_invoice_id;

  insert into public.invoice_items (invoice_id, description, reference_type, reference_id, quantity, unit_price, line_total)
  values (v_invoice_id, 'تجديد اشتراك شهري', 'subscription', p_enrollment_id, 1, p_price, v_net_price);

  insert into public.subscriptions (club_id, enrollment_id, plan_type, start_date, end_date, price, discount, status, invoice_id, created_by)
  values (v_club_id, p_enrollment_id, 'monthly', p_start_date, p_end_date, p_price, p_discount, 'pending', v_invoice_id, auth.uid())
  returning id into v_subscription_id;

  perform public.write_audit_log(
    v_club_id, 'subscription.renew', 'subscription', v_subscription_id, null,
    jsonb_build_object('enrollment_id', p_enrollment_id, 'start_date', p_start_date, 'end_date', p_end_date, 'price', p_price),
    null
  );

  return query select v_subscription_id, v_invoice_id;
end;
$$;

revoke execute on function public.renew_academy_subscription(uuid, date, date, numeric, numeric) from public, anon;
grant execute on function public.renew_academy_subscription(uuid, date, date, numeric, numeric) to authenticated;

-- E5: an active/pending subscription whose end_date has passed moves
-- to 'expired' -- read-only status derivation exposed via a function
-- (not a stored generated column, since 'today' changes without a
-- write happening) so the UI can show DUE (ending soon) vs EXPIRED
-- (already past) without a cron dependency for the common read path,
-- while a scheduled sweep (below) performs the actual status
-- transition for anything that depends on subscriptions.status itself
-- (e.g. renewal's own "must be terminal" check).
create or replace function public.get_academy_subscription_display_status(p_status text, p_end_date date)
returns text
language sql
immutable
as $$
  select case
    when p_status in ('expired', 'cancelled', 'frozen') then p_status
    when p_end_date < current_date then 'expired'
    when p_end_date <= current_date + interval '7 days' then 'due'
    else p_status
  end
$$;

-- Scheduled sweep: transitions any active/pending subscription whose
-- end_date has passed into 'expired'. SECURITY DEFINER, no auth.uid()
-- check -- intended to be called by pg_cron (system context), same
-- pattern as expire_stale_booking_holds().
create or replace function public.expire_due_academy_subscriptions()
returns int
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_count int;
begin
  perform set_config('app.allow_subscription_status_transition', 'true', true);

  with expired as (
    update public.subscriptions
    set status = 'expired'
    where status in ('active', 'pending') and end_date < current_date
    returning id, club_id
  )
  select count(*) into v_count from expired;

  return v_count;
end;
$$;

revoke execute on function public.expire_due_academy_subscriptions() from public, anon, authenticated;

commit;
