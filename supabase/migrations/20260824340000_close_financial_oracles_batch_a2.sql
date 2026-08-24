-- SYSTEMIC CROSS-TENANT EXISTENCE-ORACLE CLOSURE -- Batch A2
-- (Financial integrity, part 2 of 4): close_cash_shift,
-- settle_employee_cash_liability, adjust_employee_cash_liability,
-- reverse_employee_cash_liability. Same class, same fix shape as
-- Batch A1 -- see 20260824330000_close_financial_oracles_batch_a1.sql
-- for the full rationale.
--
-- LIVE-PROVEN before this fix (real Coach account, member of exactly
-- one club, real foreign-existing-id vs real-nonexistent-id pairs):
--   close_cash_shift: 'not authorized' vs 'shift not found' -- DISTINGUISHABLE
--   settle_employee_cash_liability: 'not authorized' vs 'liability not found' -- DISTINGUISHABLE
--   adjust_employee_cash_liability: 'not authorized -- ...' vs 'liability not found' -- DISTINGUISHABLE
--   reverse_employee_cash_liability: 'not authorized -- ...' vs 'liability not found' -- DISTINGUISHABLE
--
-- FIX: collapse lookup + club/permission check into one WHERE clause
-- per function. All downstream business logic (shift-already-closed,
-- negative-closing-count, variance/liability creation, self-
-- settlement/self-reversal/self-adjustment block, idempotency-key
-- replay, outstanding-balance cap) preserved verbatim from the
-- current live definitions (re-read via pg_get_functiondef
-- immediately before writing this migration).

create or replace function public.close_cash_shift(p_shift_id uuid, p_closing_count numeric, p_notes text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
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

create or replace function public.settle_employee_cash_liability(p_liability_id uuid, p_amount numeric, p_reason text default null::text, p_idempotency_key text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
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

  select * into v_liability
  from public.employee_cash_liabilities
  where id = p_liability_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('payment.create', club_id)
  for update;

  if v_liability.id is null then
    raise exception 'liability not found or you do not have permission to settle it';
  end if;

  if v_liability.employee_id = auth.uid() then
    raise exception 'you cannot settle your own liability -- ask another authorized staff member';
  end if;

  if p_idempotency_key is not null then
    begin
      insert into public.employee_cash_liability_settlement_keys (idempotency_key, liability_id)
      values (p_idempotency_key, p_liability_id);
    exception when unique_violation then
      select * into v_liability from public.employee_cash_liabilities where id = p_liability_id;
      return jsonb_build_object('outstanding', v_liability.outstanding, 'status', v_liability.status, 'idempotent_replay', true);
    end;
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

create or replace function public.adjust_employee_cash_liability(p_liability_id uuid, p_amount numeric, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
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

  select * into v_liability
  from public.employee_cash_liabilities
  where id = p_liability_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('payment.refund', club_id)
  for update;

  if v_liability.id is null then
    raise exception 'liability not found or you do not have permission to adjust it';
  end if;

  if v_liability.employee_id = auth.uid() then
    raise exception 'you cannot adjust your own liability -- ask another authorized staff member';
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

create or replace function public.reverse_employee_cash_liability(p_liability_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_liability record;
  v_reversal_amount numeric;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'a reason is required to reverse a liability';
  end if;

  select * into v_liability
  from public.employee_cash_liabilities
  where id = p_liability_id
    and club_id in (select public.user_club_ids())
    and public.has_permission('payment.refund', club_id)
  for update;

  if v_liability.id is null then
    raise exception 'liability not found or you do not have permission to reverse it';
  end if;

  if v_liability.employee_id = auth.uid() then
    raise exception 'you cannot reverse your own liability -- ask another authorized staff member';
  end if;

  if v_liability.outstanding <= 0 then
    raise exception 'nothing outstanding to reverse';
  end if;

  v_reversal_amount := v_liability.outstanding;

  insert into public.employee_cash_liability_ledger (liability_id, entry_type, amount, actor_id, reason)
  values (p_liability_id, 'reversal', -v_reversal_amount, auth.uid(), p_reason);

  update public.employee_cash_liabilities
  set outstanding = 0,
      status = 'settled',
      updated_at = now()
  where id = p_liability_id;

  perform public.write_audit_log(
    v_liability.club_id, 'employee_cash_liability.reversed', 'employee_cash_liability', p_liability_id,
    jsonb_build_object('outstanding', v_liability.outstanding),
    jsonb_build_object('outstanding', 0, 'reversed_amount', v_reversal_amount),
    p_reason
  );

  return jsonb_build_object('outstanding', 0, 'status', 'settled');
end;
$$;

-- All 4 signatures unchanged -- in-place replace, grants untouched.
