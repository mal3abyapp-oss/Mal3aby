-- Gate 13 task #62: cash shift / cash drawer -- lean V1.
--
-- Scope decision: a real point-of-sale cash-drawer feature (multiple
-- drawers, denominations breakdown, mid-shift drops) is out of scope for
-- a lean V1. What's genuinely needed and cheap to build correctly: one
-- open cash shift per branch at a time, an opening float, a closing
-- count, and a variance calculation against what payments.method='cash'
-- actually says should be in the drawer -- the same reconciliation
-- discipline retail cash handling requires, expressed as narrowly as
-- possible. Follows this schema's established RLS/permission
-- conventions throughout (has_permission('payment.create', ...) to
-- open/close, same as recording a payment; report.view to browse
-- history, same as every reports/* RPC).

create table public.cash_shifts (
  id uuid primary key default gen_random_uuid(),
  club_id uuid not null references public.clubs(id),
  branch_id uuid not null references public.branches(id),
  opened_by uuid not null references auth.users(id),
  opened_at timestamptz not null default now(),
  opening_float numeric not null check (opening_float >= 0),
  closed_by uuid references auth.users(id),
  closed_at timestamptz,
  closing_count numeric check (closing_count >= 0),
  expected_cash numeric,
  variance numeric,
  notes text,
  status text not null default 'open' check (status in ('open', 'closed')),
  constraint cash_shifts_closed_fields_together check (
    (status = 'open' and closed_by is null and closed_at is null and closing_count is null)
    or
    (status = 'closed' and closed_by is not null and closed_at is not null and closing_count is not null)
  )
);

-- The actual operational guarantee: at most one OPEN shift per branch at
-- a time, so "how much cash should be in the drawer right now" is always
-- an unambiguous question. A partial unique index (not a table-level
-- constraint) since it only needs to hold among open shifts.
create unique index cash_shifts_one_open_per_branch on public.cash_shifts (branch_id) where status = 'open';

alter table public.cash_shifts enable row level security;

create policy "cash_shifts_select_own_club" on public.cash_shifts
  for select using (club_id in (select public.user_club_ids()));

-- No direct INSERT/UPDATE policy -- open_cash_shift()/close_cash_shift()
-- are the only write path (SECURITY DEFINER, same pattern as
-- record_payment()), so the opening float, closing count, and variance
-- can never be edited outside the intended flow.

comment on table public.cash_shifts is
  'Gate 13 #62: lean V1 cash shift / drawer reconciliation. One open shift per branch (enforced by cash_shifts_one_open_per_branch). expected_cash/variance are computed and frozen at close time from payments.method=''cash'' minus refunds during the shift window, not recomputed later.';

create or replace function public.open_cash_shift(
  p_club_id uuid,
  p_branch_id uuid,
  p_opening_float numeric
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('payment.create', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if not exists (select 1 from public.branches where id = p_branch_id and club_id = p_club_id) then
    raise exception 'branch not found in this club';
  end if;

  if p_opening_float < 0 then
    raise exception 'opening float cannot be negative';
  end if;

  if exists (select 1 from public.cash_shifts where branch_id = p_branch_id and status = 'open') then
    raise exception 'a cash shift is already open for this branch';
  end if;

  insert into public.cash_shifts (club_id, branch_id, opened_by, opening_float)
  values (p_club_id, p_branch_id, auth.uid(), p_opening_float)
  returning id into v_shift_id;

  perform public.write_audit_log(
    p_club_id, 'cash_shift.open', 'cash_shift', v_shift_id, null,
    jsonb_build_object('branch_id', p_branch_id, 'opening_float', p_opening_float), null
  );

  return v_shift_id;
end;
$$;

revoke execute on function public.open_cash_shift(uuid, uuid, numeric) from public, anon;
grant execute on function public.open_cash_shift(uuid, uuid, numeric) to authenticated;

create or replace function public.close_cash_shift(
  p_shift_id uuid,
  p_closing_count numeric,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift record;
  v_cash_collected numeric;
  v_cash_refunded numeric;
  v_expected numeric;
  v_variance numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  -- FOR UPDATE: without this, two concurrent close_cash_shift() calls on
  -- the same shift could both read status='open' before either commits
  -- its UPDATE, letting the shift be "closed" twice with two different
  -- variance calculations. Locking the row here serializes them -- the
  -- second call blocks until the first commits, then correctly sees
  -- status='closed' and raises.
  select * into v_shift from public.cash_shifts where id = p_shift_id for update;
  if v_shift.id is null then
    raise exception 'shift not found';
  end if;

  if not (v_shift.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_shift.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_shift.status != 'open' then
    raise exception 'this shift is already closed';
  end if;

  if p_closing_count < 0 then
    raise exception 'closing count cannot be negative';
  end if;

  select coalesce(sum(p.amount), 0) into v_cash_collected
  from public.payments p
  where p.branch_id = v_shift.branch_id and p.method = 'cash' and p.status = 'completed'
    and p.received_at >= v_shift.opened_at and p.received_at <= now();

  select coalesce(sum(r.amount), 0) into v_cash_refunded
  from public.refunds r
  join public.payments p on p.id = r.payment_id
  where p.branch_id = v_shift.branch_id and p.method = 'cash' and r.status = 'completed'
    and r.refunded_at >= v_shift.opened_at and r.refunded_at <= now();

  v_expected := v_shift.opening_float + v_cash_collected - v_cash_refunded;
  v_variance := p_closing_count - v_expected;

  update public.cash_shifts
  set status = 'closed', closed_by = auth.uid(), closed_at = now(),
      closing_count = p_closing_count, expected_cash = v_expected, variance = v_variance, notes = p_notes
  where id = p_shift_id;

  perform public.write_audit_log(
    v_shift.club_id, 'cash_shift.close', 'cash_shift', p_shift_id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object('closing_count', p_closing_count, 'expected_cash', v_expected, 'variance', v_variance),
    p_notes
  );

  return jsonb_build_object('expected_cash', v_expected, 'closing_count', p_closing_count, 'variance', v_variance);
end;
$$;

revoke execute on function public.close_cash_shift(uuid, numeric, text) from public, anon;
grant execute on function public.close_cash_shift(uuid, numeric, text) to authenticated;

-- Read-only "what should be in the drawer right now" for an OPEN shift --
-- the same computation close_cash_shift() does, exposed so the UI can
-- show a live running total before the shift is actually closed.
create or replace function public.get_open_cash_shift_status(p_shift_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_shift record;
  v_cash_collected numeric;
  v_cash_refunded numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_shift from public.cash_shifts where id = p_shift_id;
  if v_shift.id is null then
    raise exception 'shift not found';
  end if;

  if not (v_shift.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_shift.club_id)) then
    raise exception 'not authorized';
  end if;

  select coalesce(sum(p.amount), 0) into v_cash_collected
  from public.payments p
  where p.branch_id = v_shift.branch_id and p.method = 'cash' and p.status = 'completed'
    and p.received_at >= v_shift.opened_at and p.received_at <= now();

  select coalesce(sum(r.amount), 0) into v_cash_refunded
  from public.refunds r
  join public.payments p on p.id = r.payment_id
  where p.branch_id = v_shift.branch_id and p.method = 'cash' and r.status = 'completed'
    and r.refunded_at >= v_shift.opened_at and r.refunded_at <= now();

  return jsonb_build_object(
    'opening_float', v_shift.opening_float,
    'cash_collected', v_cash_collected,
    'cash_refunded', v_cash_refunded,
    'expected_cash', v_shift.opening_float + v_cash_collected - v_cash_refunded
  );
end;
$$;

revoke execute on function public.get_open_cash_shift_status(uuid) from public, anon;
grant execute on function public.get_open_cash_shift_status(uuid) to authenticated;
