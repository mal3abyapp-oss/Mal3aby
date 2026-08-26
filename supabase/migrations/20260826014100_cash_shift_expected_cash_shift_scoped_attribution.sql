-- CASH CUSTODY & SHIFT LIFECYCLE audit -- confirmed defect fix.
--
-- close_cash_shift() and get_open_cash_shift_status() computed
-- expected_cash purely from a branch + time-window heuristic
-- (payments/refunds on this branch with received_at/refunded_at
-- between shift.opened_at and now()), even though payments.cash_shift_id
-- and refunds.cash_shift_id already exist and are correctly populated
-- by record_payment()/create_refund() -- confirmed live via
-- get_staff_shift_detail() (the shift detail screen) and
-- get_financial_reconciliation_report() (which even tracks a
-- cash_payments_unlinked_to_shift_count metric), both of which already
-- treat cash_shift_id as the real source of truth.
--
-- Proven defect (live fixture, cleaned up after): a refund issued
-- against a PREVIOUS, already-closed shift's payment, while a NEW
-- shift is open on the same branch, was being subtracted from the NEW
-- shift's expected_cash purely because the refund's timestamp fell
-- inside the new shift's open window -- confirmed live: a shift with
-- zero opening float, zero payments, and zero refunds of its own
-- showed expected_cash = -30 due to an unrelated prior shift's refund.
-- This is a genuine cross-employee/cross-shift misattribution that
-- could produce a false shortage or false overage against an innocent
-- employee.
--
-- Also proven: switching to a STRICT cash_shift_id-only filter would
-- be a worse regression -- live data shows 72 of 89 completed cash
-- payments (81%) have cash_shift_id IS NULL, almost entirely legacy
-- payments recorded before the cash-shift gate went live
-- (create_booking_internal_cash_shift_gate, applied 2026-08-20); after
-- that gate, essentially zero new unlinked custody-cash payments exist
-- (confirmed live: exactly one, at the exact cutover moment). A pure
-- cash_shift_id filter would silently exclude legitimate legacy/
-- non-custody cash from expected_cash.
--
-- Fix: compute cash_collected/cash_refunded as the union of (a) rows
-- correctly linked via cash_shift_id = this shift, and (b) unlinked
-- rows (cash_shift_id IS NULL) matched by the EXISTING branch+time-
-- window heuristic, preserved unchanged for backward compatibility.
-- A linked row can never double-count into another shift's window
-- (it is only ever matched by its own cash_shift_id, never falls into
-- the "unlinked" branch), which is exactly what eliminates the
-- cross-shift refund leak proven above, while unlinked/legacy rows
-- keep exactly their current (already correct-for-that-case) behavior.
--
-- Same signatures/return shapes -- safe in-place CREATE OR REPLACE,
-- no new overload, grants unaffected.
create or replace function public.get_open_cash_shift_status(p_shift_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
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
  where p.method = 'cash' and p.status = 'completed'
    and (
      p.cash_shift_id = p_shift_id
      or (
        p.cash_shift_id is null
        and p.branch_id = v_shift.branch_id
        and p.received_at >= v_shift.opened_at and p.received_at <= now()
      )
    );

  select coalesce(sum(r.amount), 0) into v_cash_refunded
  from public.refunds r
  join public.payments p on p.id = r.payment_id
  where p.method = 'cash' and r.status = 'completed'
    and (
      r.cash_shift_id = p_shift_id
      or (
        r.cash_shift_id is null
        and p.branch_id = v_shift.branch_id
        and r.refunded_at >= v_shift.opened_at and r.refunded_at <= now()
      )
    );

  return jsonb_build_object(
    'opening_float', v_shift.opening_float,
    'cash_collected', v_cash_collected,
    'cash_refunded', v_cash_refunded,
    'expected_cash', v_shift.opening_float + v_cash_collected - v_cash_refunded
  );
end;
$function$;

create or replace function public.close_cash_shift(p_shift_id uuid, p_closing_count numeric, p_notes text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_shift record;
  v_cash_collected numeric;
  v_cash_refunded numeric;
  v_expected numeric;
  v_variance numeric;
  v_liability_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_shift
  from public.cash_shifts
  where id = p_shift_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('payment.create', club_id)
  for update;

  if v_shift.id is null then
    raise exception 'shift not found or you do not have permission to close it';
  end if;

  if v_shift.status != 'open' then
    raise exception 'this shift is already closed';
  end if;

  if p_closing_count < 0 then
    raise exception 'closing count cannot be negative';
  end if;

  select coalesce(sum(p.amount), 0) into v_cash_collected
  from public.payments p
  where p.method = 'cash' and p.status = 'completed'
    and (
      p.cash_shift_id = p_shift_id
      or (
        p.cash_shift_id is null
        and p.branch_id = v_shift.branch_id
        and p.received_at >= v_shift.opened_at and p.received_at <= now()
      )
    );

  select coalesce(sum(r.amount), 0) into v_cash_refunded
  from public.refunds r
  join public.payments p on p.id = r.payment_id
  where p.method = 'cash' and r.status = 'completed'
    and (
      r.cash_shift_id = p_shift_id
      or (
        r.cash_shift_id is null
        and p.branch_id = v_shift.branch_id
        and r.refunded_at >= v_shift.opened_at and r.refunded_at <= now()
      )
    );

  v_expected := v_shift.opening_float + v_cash_collected - v_cash_refunded;
  v_variance := p_closing_count - v_expected;

  update public.cash_shifts
  set status = 'closed', closed_by = auth.uid(), closed_at = now(),
      closing_count = p_closing_count, expected_cash = v_expected, variance = v_variance, notes = p_notes
  where id = p_shift_id;

  if v_variance < 0 then
    insert into public.employee_cash_liabilities (club_id, branch_id, cash_shift_id, employee_id, kind, original_amount, outstanding, status)
    values (v_shift.club_id, v_shift.branch_id, p_shift_id, v_shift.opened_by, 'shortage', abs(v_variance), abs(v_variance), 'outstanding')
    returning id into v_liability_id;

    insert into public.employee_cash_liability_ledger (liability_id, entry_type, amount, actor_id, reason)
    values (v_liability_id, 'shortage_created', abs(v_variance), auth.uid(), p_notes);

    perform public.write_audit_log(
      v_shift.club_id, 'employee_cash_liability.shortage_created', 'employee_cash_liability', v_liability_id,
      null, jsonb_build_object('employee_id', v_shift.opened_by, 'amount', abs(v_variance), 'cash_shift_id', p_shift_id), p_notes
    );
  elsif v_variance > 0 then
    insert into public.employee_cash_liabilities (club_id, branch_id, cash_shift_id, employee_id, kind, original_amount, outstanding, status)
    values (v_shift.club_id, v_shift.branch_id, p_shift_id, v_shift.opened_by, 'overage', v_variance, v_variance, 'outstanding')
    returning id into v_liability_id;

    -- Bugfix (found live during this audit): this ledger entry was
    -- previously typed 'shortage_created' even in the overage branch
    -- -- a copy-paste artifact from the shortage branch above, now
    -- corrected to its own distinct entry_type so the ledger accurately
    -- reflects what actually happened.
    insert into public.employee_cash_liability_ledger (liability_id, entry_type, amount, actor_id, reason)
    values (v_liability_id, 'overage_recorded', v_variance, auth.uid(), p_notes);

    perform public.write_audit_log(
      v_shift.club_id, 'employee_cash_liability.overage_recorded', 'employee_cash_liability', v_liability_id,
      null, jsonb_build_object('employee_id', v_shift.opened_by, 'amount', v_variance, 'cash_shift_id', p_shift_id), p_notes
    );
  end if;

  perform public.write_audit_log(
    v_shift.club_id, 'cash_shift.close', 'cash_shift', p_shift_id,
    jsonb_build_object('status', 'open'),
    jsonb_build_object('closing_count', p_closing_count, 'expected_cash', v_expected, 'variance', v_variance),
    p_notes
  );

  return jsonb_build_object('expected_cash', v_expected, 'closing_count', p_closing_count, 'variance', v_variance, 'liability_id', v_liability_id);
end;
$function$;
