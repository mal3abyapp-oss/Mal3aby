-- The Academy UI already snapshots a membership price into subscriptions and
-- invoices, but create_enrollment_with_subscription accepts p_price from the
-- client. Enforce the approved master price at the database boundary so a
-- stale or malicious client cannot create a new subscription at an old price.
-- Existing subscriptions/invoices are untouched.

create or replace function public.enforce_academy_subscription_master_price()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_master_price numeric;
begin
  select g.subscription_price
    into v_master_price
  from public.enrollments e
  join public.groups g on g.id = e.group_id
  where e.id = new.enrollment_id
  for share of g;

  -- Legacy/advanced groups may intentionally have no approved product price.
  -- The simplified Membership flow always has one and must match it exactly.
  if v_master_price is not null and new.price is distinct from v_master_price then
    raise exception 'SUBSCRIPTION_PRICE_MUST_MATCH_MEMBERSHIP_PRICE';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_subscriptions_enforce_membership_price on public.subscriptions;
create trigger trg_subscriptions_enforce_membership_price
  before insert on public.subscriptions
  for each row execute function public.enforce_academy_subscription_master_price();

revoke all on function public.enforce_academy_subscription_master_price() from public, anon, authenticated;

comment on function public.enforce_academy_subscription_master_price() is
  'Ensures each new Academy subscription snapshots the current approved membership price; never mutates historical rows.';
