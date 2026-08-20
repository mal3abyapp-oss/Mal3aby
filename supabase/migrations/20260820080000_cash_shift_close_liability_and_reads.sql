-- Phase D continued: close_cash_shift() now creates a liability row
-- when variance is nonzero (D10/D11), settlement/adjustment RPCs
-- (D12/D13/D14), and staff-facing read RPCs (D16).

begin;

-- D10/D11: extends the existing close_cash_shift() (20260817040000) --
-- its own variance math is unchanged, this only adds: on a negative
-- variance (shortage), create an employee_cash_liabilities row +
-- shortage_created ledger entry for the employee who OPENED the shift
-- (the person accountable for that drawer, not whoever happens to
-- close it, though today the same permission gate allows either -- a
-- shift is opened and closed by the same custody employee in the
-- common case). A positive variance (overage) is recorded too (D9),
-- but overage does not create a debt -- it's tracked for visibility/
-- reconciliation, never auto-settled against anything (that would be
-- inventing a policy the directive never asked for).
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
  v_liability_id uuid;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

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

  -- D10/D11: create the liability row + its opening ledger entry inside
  -- the SAME transaction as the status update above -- a shift can
  -- never end up closed with a shortage that wasn't recorded.
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

    insert into public.employee_cash_liability_ledger (liability_id, entry_type, amount, actor_id, reason)
    values (v_liability_id, 'shortage_created', v_variance, auth.uid(), p_notes);

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
$$;

-- D12/D13: partial or full settlement. Never edits `outstanding`
-- directly -- inserts a negative ledger entry, then recomputes
-- `outstanding` as a sum over the whole ledger in the same statement,
-- so the cached column can never drift from the ledger it's derived
-- from.
create or replace function public.settle_employee_cash_liability(
  p_liability_id uuid,
  p_amount numeric,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_liability record;
  v_new_outstanding numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_amount <= 0 then
    raise exception 'settlement amount must be positive';
  end if;

  select * into v_liability from public.employee_cash_liabilities where id = p_liability_id for update;
  if v_liability.id is null then
    raise exception 'liability not found';
  end if;

  if not (v_liability.club_id in (select public.user_club_ids()) and public.has_permission('payment.create', v_liability.club_id)) then
    raise exception 'not authorized';
  end if;

  if v_liability.status = 'settled' then
    raise exception 'this liability is already fully settled';
  end if;

  if p_amount > v_liability.outstanding then
    raise exception 'settlement amount (%) exceeds the outstanding balance (%)', p_amount, v_liability.outstanding;
  end if;

  insert into public.employee_cash_liability_ledger (liability_id, entry_type, amount, actor_id, reason)
  values (p_liability_id, 'settlement', -p_amount, auth.uid(), p_reason);

  v_new_outstanding := v_liability.outstanding - p_amount;

  update public.employee_cash_liabilities
  set outstanding = v_new_outstanding,
      status = case when v_new_outstanding <= 0 then 'settled' else 'outstanding' end,
      updated_at = now()
  where id = p_liability_id;

  perform public.write_audit_log(
    v_liability.club_id, 'employee_cash_liability.settled', 'employee_cash_liability', p_liability_id,
    jsonb_build_object('outstanding', v_liability.outstanding),
    jsonb_build_object('outstanding', v_new_outstanding, 'settlement_amount', p_amount),
    p_reason
  );

  return jsonb_build_object('outstanding', v_new_outstanding, 'status', case when v_new_outstanding <= 0 then 'settled' else 'outstanding' end);
end;
$$;

revoke execute on function public.settle_employee_cash_liability(uuid, numeric, text) from public, anon;
grant execute on function public.settle_employee_cash_liability(uuid, numeric, text) to authenticated;

-- D14: authorized adjustment -- manager/owner only, reason required,
-- audited. Can move the balance either direction (a positive amount
-- increases outstanding, e.g. correcting an under-recorded shortage; a
-- negative amount decreases it, e.g. forgiving part of a debt) --
-- deliberately distinct from settle_employee_cash_liability(), which
-- always represents the employee actually paying money.
create or replace function public.adjust_employee_cash_liability(
  p_liability_id uuid,
  p_amount numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_liability record;
  v_new_outstanding numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required for a liability adjustment';
  end if;

  if p_amount = 0 then
    raise exception 'adjustment amount cannot be zero';
  end if;

  select * into v_liability from public.employee_cash_liabilities where id = p_liability_id for update;
  if v_liability.id is null then
    raise exception 'liability not found';
  end if;

  -- D14: "Manager/Owner only" -- a distinct, higher bar than the
  -- payment.create gate settlement/creation use, since this can move a
  -- balance without any actual cash changing hands.
  if not (v_liability.club_id in (select public.user_club_ids()) and public.has_permission('payment.refund', v_liability.club_id)) then
    raise exception 'not authorized -- liability adjustments require manager/owner authorization';
  end if;

  v_new_outstanding := v_liability.outstanding + p_amount;
  if v_new_outstanding < 0 then
    raise exception 'adjustment would make the outstanding balance negative';
  end if;

  insert into public.employee_cash_liability_ledger (liability_id, entry_type, amount, actor_id, reason)
  values (p_liability_id, 'adjustment', p_amount, auth.uid(), p_reason);

  update public.employee_cash_liabilities
  set outstanding = v_new_outstanding,
      status = case when v_new_outstanding <= 0 then 'settled' else 'outstanding' end,
      updated_at = now()
  where id = p_liability_id;

  perform public.write_audit_log(
    v_liability.club_id, 'employee_cash_liability.adjusted', 'employee_cash_liability', p_liability_id,
    jsonb_build_object('outstanding', v_liability.outstanding),
    jsonb_build_object('outstanding', v_new_outstanding, 'adjustment_amount', p_amount),
    p_reason
  );

  return jsonb_build_object('outstanding', v_new_outstanding, 'status', case when v_new_outstanding <= 0 then 'settled' else 'outstanding' end);
end;
$$;

revoke execute on function public.adjust_employee_cash_liability(uuid, numeric, text) from public, anon;
grant execute on function public.adjust_employee_cash_liability(uuid, numeric, text) to authenticated;

-- D16: staff profile visibility -- custody flag, active shift,
-- outstanding/total shortage, settled amount, last shift, full
-- liability history. One RPC, one round trip, since a staff detail
-- view needs all of this together.
create or replace function public.get_staff_cash_profile(p_membership_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_membership record;
  v_active_shift record;
  v_last_shift record;
  v_outstanding_total numeric;
  v_settled_total numeric;
  v_liabilities jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  select * into v_membership from public.club_memberships where id = p_membership_id;
  if v_membership.id is null then
    raise exception 'membership not found';
  end if;

  if not (v_membership.club_id in (select public.user_club_ids()) and public.has_permission('staff.update', v_membership.club_id)) then
    raise exception 'not authorized';
  end if;

  select id, branch_id, opened_at, opening_float into v_active_shift
  from public.cash_shifts
  where opened_by = v_membership.user_id and club_id = v_membership.club_id and status = 'open'
  limit 1;

  select id, branch_id, opened_at, closed_at, variance into v_last_shift
  from public.cash_shifts
  where opened_by = v_membership.user_id and club_id = v_membership.club_id and status = 'closed'
  order by closed_at desc limit 1;

  select coalesce(sum(outstanding), 0) into v_outstanding_total
  from public.employee_cash_liabilities
  where employee_id = v_membership.user_id and club_id = v_membership.club_id and kind = 'shortage' and status = 'outstanding';

  select coalesce(sum(original_amount - outstanding), 0) into v_settled_total
  from public.employee_cash_liabilities
  where employee_id = v_membership.user_id and club_id = v_membership.club_id and kind = 'shortage';

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'kind', kind, 'original_amount', original_amount, 'outstanding', outstanding,
    'status', status, 'cash_shift_id', cash_shift_id, 'created_at', created_at
  ) order by created_at desc), '[]'::jsonb) into v_liabilities
  from public.employee_cash_liabilities
  where employee_id = v_membership.user_id and club_id = v_membership.club_id;

  return jsonb_build_object(
    'has_cash_custody', v_membership.has_cash_custody,
    'active_shift', case when v_active_shift.id is not null then jsonb_build_object(
      'id', v_active_shift.id, 'branch_id', v_active_shift.branch_id,
      'opened_at', v_active_shift.opened_at, 'opening_float', v_active_shift.opening_float
    ) else null end,
    'last_shift', case when v_last_shift.id is not null then jsonb_build_object(
      'id', v_last_shift.id, 'branch_id', v_last_shift.branch_id,
      'opened_at', v_last_shift.opened_at, 'closed_at', v_last_shift.closed_at, 'variance', v_last_shift.variance
    ) else null end,
    'outstanding_shortage_total', v_outstanding_total,
    'settled_total', v_settled_total,
    'liabilities', v_liabilities
  );
end;
$$;

revoke execute on function public.get_staff_cash_profile(uuid) from public, anon;
grant execute on function public.get_staff_cash_profile(uuid) to authenticated;

-- D17: open-shift age visibility -- every open shift for the club, with
-- its age, for an admin-facing warning list. Not an auto-close (D17:
-- "Do not auto-close silently") -- purely informational.
create or replace function public.get_open_cash_shifts(p_club_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('payment.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', cs.id, 'branch_id', cs.branch_id, 'opened_by', cs.opened_by,
    'opened_by_name', p.full_name, 'opened_at', cs.opened_at,
    'opening_float', cs.opening_float,
    'age_hours', round(extract(epoch from (now() - cs.opened_at)) / 3600.0, 1)
  ) order by cs.opened_at asc), '[]'::jsonb) into v_result
  from public.cash_shifts cs
  left join public.profiles p on p.user_id = cs.opened_by
  where cs.club_id = p_club_id and cs.status = 'open';

  return v_result;
end;
$$;

revoke execute on function public.get_open_cash_shifts(uuid) from public, anon;
grant execute on function public.get_open_cash_shifts(uuid) to authenticated;

commit;
