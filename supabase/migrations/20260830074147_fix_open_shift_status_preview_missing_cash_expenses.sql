-- FULL SAAS ACCEPTANCE SWEEP (2026-08-30) -- real regression caught by
-- live UI verification (Club Owner journey pass, cash-shift flow):
-- close_cash_shift() was fixed in 20260830010000_expenses_feature.sql
-- to subtract cash_expenses from expected_cash, but its sibling
-- get_open_cash_shift_status() -- the live "expected cash in drawer
-- right now" preview shown on the close-shift screen BEFORE the
-- person actually clicks confirm -- was missed entirely. Confirmed
-- live: with a 500 EGP opening float and a 100 EGP cash expense
-- recorded against the open shift, the preview showed 500.00 EGP
-- expected (wrong) while close_cash_shift() itself would have correctly
-- computed 400.00 EGP. A real cashier counting an honest 400 EGP in the
-- drawer against this wrong 500 EGP preview would believe they were
-- short before ever reaching the (correct) confirmation step. Adds the
-- exact same cash_expenses term, computed with the exact same
-- fallback-linking pattern already used for cash_collected/
-- cash_refunded in this same function and for cash_expenses in
-- close_cash_shift(). Every other line is unchanged from the live
-- definition.
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
  v_cash_expenses numeric;
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

  select coalesce(sum(e.amount), 0) into v_cash_expenses
  from public.expenses e
  where e.payment_method = 'cash' and e.status = 'recorded'
    and (
      e.cash_shift_id = p_shift_id
      or (
        e.cash_shift_id is null
        and e.branch_id = v_shift.branch_id
        and e.created_at >= v_shift.opened_at and e.created_at <= now()
      )
    );

  return jsonb_build_object(
    'opening_float', v_shift.opening_float,
    'cash_collected', v_cash_collected,
    'cash_refunded', v_cash_refunded,
    'cash_expenses', v_cash_expenses,
    'expected_cash', v_shift.opening_float + v_cash_collected - v_cash_refunded - v_cash_expenses
  );
end;
$function$;
