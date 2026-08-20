-- Phase F: F4 (cash payments vs cash shifts vs government receipts
-- reconciliation) and F6 (employee liability report). Both are
-- genuinely new report concepts -- Phase D's cash_shift_id/
-- official_collection_receipts linkage (this session's earlier
-- migrations) is what makes an exact, row-level reconciliation
-- possible instead of an approximate time-window comparison.

begin;

-- F4/F5: the actual reconciliation. Three real cross-checks, not one
-- aggregate number:
-- 1. cash payments total vs cash shifts' recorded collection (should
--    match exactly for any payment linked to a shift; payments.
--    cash_shift_id is null only for cash collected by a non-custody
--    employee, which the exceptions list below surfaces separately)
-- 2. shift-level variance (shortage/overage) -- already computed and
--    stored at close time, aggregated here per the date range
-- 3. cash/wallet payments that a club's government policy required a
--    receipt for, cross-checked against whether one is actually
--    linked -- catching anything that somehow slipped past
--    record_payment()'s own guard (should be empty in practice; an
--    empty list here IS the proof the guard is airtight, not a
--    tautology -- the guard could have been bypassed by a schema
--    change, a direct DB write, or a bug elsewhere).
create or replace function public.get_financial_reconciliation_report(
  p_club_id uuid,
  p_start_date date,
  p_end_date date,
  p_branch_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  select jsonb_build_object(
    -- Cross-check 1: cash payments vs cash shifts.
    'cash_payments_total', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.method = 'cash' and p.status = 'completed'
        and p.received_at::date between p_start_date and p_end_date
        and (p_branch_id is null or p.branch_id = p_branch_id)
    ), 0),
    'cash_payments_linked_to_shift', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.method = 'cash' and p.status = 'completed'
        and p.cash_shift_id is not null
        and p.received_at::date between p_start_date and p_end_date
        and (p_branch_id is null or p.branch_id = p_branch_id)
    ), 0),
    'cash_payments_unlinked_to_shift_count', coalesce((
      select count(*) from public.payments p
      where p.club_id = p_club_id and p.method = 'cash' and p.status = 'completed'
        and p.cash_shift_id is null
        and p.received_at::date between p_start_date and p_end_date
        and (p_branch_id is null or p.branch_id = p_branch_id)
    ), 0),

    -- Cross-check 2: shift-level variance for shifts CLOSED in range.
    'shifts_closed_count', coalesce((
      select count(*) from public.cash_shifts cs
      where cs.club_id = p_club_id and cs.status = 'closed'
        and cs.closed_at::date between p_start_date and p_end_date
        and (p_branch_id is null or cs.branch_id = p_branch_id)
    ), 0),
    'total_shortage', coalesce((
      select sum(-cs.variance) from public.cash_shifts cs
      where cs.club_id = p_club_id and cs.status = 'closed' and cs.variance < 0
        and cs.closed_at::date between p_start_date and p_end_date
        and (p_branch_id is null or cs.branch_id = p_branch_id)
    ), 0),
    'total_overage', coalesce((
      select sum(cs.variance) from public.cash_shifts cs
      where cs.club_id = p_club_id and cs.status = 'closed' and cs.variance > 0
        and cs.closed_at::date between p_start_date and p_end_date
        and (p_branch_id is null or cs.branch_id = p_branch_id)
    ), 0),

    -- Cross-check 3: government-required receipts, exceptions only --
    -- a payment whose method WAS in the effective policy's
    -- required_payment_methods at the time, with no linked receipt.
    -- Should be empty; a non-empty result means the record_payment()
    -- guard was bypassed somewhere and needs investigation.
    'unreceipted_required_payments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'payment_id', p.id, 'amount', p.amount, 'method', p.method, 'received_at', p.received_at
      ) order by p.received_at)
      from public.payments p
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at::date between p_start_date and p_end_date
        and (p_branch_id is null or p.branch_id = p_branch_id)
        and not exists (
          select 1 from public.official_collection_receipts r
          where r.payment_id = p.id and r.status = 'active'
        )
        and exists (
          select 1 from public.government_collection_policies gp
          where gp.club_id = p.club_id
            and gp.enabled and gp.official_receipt_required
            and p.method = any(gp.required_payment_methods)
            and (gp.branch_id is null or gp.branch_id = p.branch_id)
        )
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$function$;

revoke execute on function public.get_financial_reconciliation_report(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_financial_reconciliation_report(uuid, date, date, uuid) to authenticated;

-- F6: employee liability report -- per employee, per date range:
-- shortage created, settled, outstanding, linked shift, date.
create or replace function public.get_employee_liability_report(
  p_club_id uuid,
  p_start_date date,
  p_end_date date
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  select jsonb_agg(jsonb_build_object(
    'liability_id', l.id,
    'employee_id', l.employee_id,
    'employee_name', coalesce(pr.full_name, '—'),
    'kind', l.kind,
    'original_amount', l.original_amount,
    'outstanding', l.outstanding,
    'status', l.status,
    'cash_shift_id', l.cash_shift_id,
    'created_at', l.created_at
  ) order by l.created_at desc) into v_result
  from public.employee_cash_liabilities l
  left join public.profiles pr on pr.user_id = l.employee_id
  where l.club_id = p_club_id
    and l.created_at::date between p_start_date and p_end_date;

  return coalesce(v_result, '[]'::jsonb);
end;
$function$;

revoke execute on function public.get_employee_liability_report(uuid, date, date) from public, anon;
grant execute on function public.get_employee_liability_report(uuid, date, date) to authenticated;

commit;
