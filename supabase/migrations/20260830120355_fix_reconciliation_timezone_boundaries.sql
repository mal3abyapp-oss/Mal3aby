-- REPORTING ACCURACY & MANAGEMENT INSIGHT ACCEPTANCE (Stage B, B5,
-- final sweep, 2026-08-30): the last 2 real instances of the same bug
-- fixed repeatedly across today's batch, found via a final full-schema
-- grep for every remaining timestamptz-cast-to-::date comparison
-- pattern (the third and final hit, create_recurring_booking, is a
-- cosmetic text-description string build, not a comparison -- not
-- affected, left untouched).
--
-- gateway_reconciliation_report() (Gateway Health report, A11): 5
-- instances of `t.created_at::date between p_date_from and p_date_to`
-- on payment_gateway_transactions.created_at.
--
-- confirm_payment_reconciliation() -- MORE consequential than a
-- display-only report: this is a WRITE RPC. It computes a reconciled
-- total for a payment method/period and PERMANENTLY records it into
-- payment_reconciliations (the "manual confirmation that a payment
-- method's recorded total for a period matches its external source of
-- truth" record, per that table's own comment). The naive ::date cast
-- here means a staff member reconciling "August 30" against a bank
-- statement could have the computed total silently miss (or wrongly
-- include) transactions from the adjacent UTC day -- and that wrong
-- total gets written as a permanent, audited reconciliation record.
-- 2 instances: payments.received_at and refunds.refunded_at.
--
-- Both fixed with the same club_local_day_bounds() pattern as every
-- other fix in this batch. Both p_date_from/p_date_to (gateway report)
-- and p_period_start/p_period_end (reconciliation) are REQUIRED
-- (non-nullable, both functions already raise if end < start), so no
-- null-guard is needed here -- unlike the earlier Shop report fixes.
create or replace function public.gateway_reconciliation_report(p_club_id uuid, p_date_from date, p_date_to date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_result jsonb;
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (
    (p_club_id in (select public.user_club_ids()) and public.has_permission('payment.methods.view', p_club_id))
    or public.has_platform_support_access(p_club_id, false)
  ) then
    raise exception 'not authorized';
  end if;

  if p_date_to < p_date_from then
    raise exception 'p_date_to must be on or after p_date_from';
  end if;

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_date_from);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_date_to);

  select jsonb_build_object(
    -- Chain-level rollup: every gateway transaction in range, joined
    -- out to its payment/allocations/refunds -- READ-ONLY, this report
    -- never writes anything; it only surfaces what Finance's own
    -- tables already say.
    'transactions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'transaction_id', t.id,
        'gateway', t.gateway,
        'environment', t.environment,
        'status', t.status,
        'amount', t.amount,
        'currency', t.currency,
        'created_at', t.created_at,
        'payment_id', t.payment_id,
        'payment_amount', p.amount,
        'allocated_amount', alloc.total_allocated,
        'refunded_amount', ref.total_refunded,
        'provider_session_ref', t.provider_session_ref
      ) order by t.created_at desc)
      from public.payment_gateway_transactions t
      left join public.payments p on p.id = t.payment_id
      left join lateral (
        select coalesce(sum(pa.amount), 0) as total_allocated
        from public.payment_allocations pa where pa.payment_id = t.payment_id
      ) alloc on true
      left join lateral (
        select coalesce(sum(r.amount), 0) as total_refunded
        from public.refunds r where r.payment_id = t.payment_id and r.status = 'completed'
      ) ref on true
      where t.club_id = p_club_id
        and t.created_at >= v_range_start and t.created_at < v_range_end
    ), '[]'::jsonb),
    -- EXCEPTIONS ONLY: the operationally-actionable subset. Never a
    -- second source of truth -- purely "these rows disagree with each
    -- other, go look at them in Finance".
    'exceptions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'transaction_id', t.id,
        'exception_type', exc.exception_type,
        'detail', exc.detail
      ))
      from public.payment_gateway_transactions t
      left join public.payments p on p.id = t.payment_id
      cross join lateral (
        select case
          when t.status = 'succeeded' and t.payment_id is null then 'succeeded_transaction_no_payment'
          when t.payment_id is not null and not exists (
            select 1 from public.payment_allocations pa where pa.payment_id = t.payment_id
          ) then 'payment_no_allocation'
          when t.payment_id is not null and p.amount is distinct from t.amount then 'amount_mismatch_transaction_vs_payment'
          else null
        end as exception_type,
        case
          when t.status = 'succeeded' and t.payment_id is null then 'transaction marked succeeded but has no linked payment'
          when t.payment_id is not null and not exists (
            select 1 from public.payment_allocations pa where pa.payment_id = t.payment_id
          ) then 'linked payment has zero allocations'
          when t.payment_id is not null and p.amount is distinct from t.amount then
            format('transaction amount %s does not match payment amount %s', t.amount, p.amount)
          else null
        end as detail
      ) exc
      where t.club_id = p_club_id
        and t.created_at >= v_range_start and t.created_at < v_range_end
        and exc.exception_type is not null
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'total_transactions', (
        select count(*) from public.payment_gateway_transactions t
        where t.club_id = p_club_id and t.created_at >= v_range_start and t.created_at < v_range_end
      ),
      'succeeded_transactions', (
        select count(*) from public.payment_gateway_transactions t
        where t.club_id = p_club_id and t.created_at >= v_range_start and t.created_at < v_range_end and t.status = 'succeeded'
      ),
      'failed_transactions', (
        select count(*) from public.payment_gateway_transactions t
        where t.club_id = p_club_id and t.created_at >= v_range_start and t.created_at < v_range_end and t.status = 'failed'
      ),
      'pending_transactions', (
        select count(*) from public.payment_gateway_transactions t
        where t.club_id = p_club_id and t.created_at >= v_range_start and t.created_at < v_range_end and t.status = 'pending'
      )
    )
  ) into v_result;

  return v_result;
end;
$function$;

create or replace function public.confirm_payment_reconciliation(p_club_id uuid, p_method text, p_period_start date, p_period_end date, p_branch_id uuid DEFAULT NULL::uuid, p_note text DEFAULT NULL::text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_total numeric;
  v_id uuid;
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_method not in ('cash', 'card', 'bank_transfer', 'wallet', 'other') then
    raise exception 'invalid payment method';
  end if;

  if p_period_end < p_period_start then
    raise exception 'p_period_end must be on or after p_period_start';
  end if;

  select day_start into v_range_start from public.club_local_day_bounds(p_club_id, p_period_start);
  select day_end into v_range_end from public.club_local_day_bounds(p_club_id, p_period_end);

  select coalesce(sum(p.amount), 0)
    - coalesce((
        select sum(r.amount) from public.refunds r
        join public.payments rp on rp.id = r.payment_id
        where rp.club_id = p_club_id and rp.method = p_method and r.status = 'completed'
          and r.refunded_at >= v_range_start and r.refunded_at < v_range_end
          and (p_branch_id is null or rp.branch_id = p_branch_id)
      ), 0)
  into v_total
  from public.payments p
  where p.club_id = p_club_id and p.method = p_method and p.status = 'completed'
    and p.received_at >= v_range_start and p.received_at < v_range_end
    and (p_branch_id is null or p.branch_id = p_branch_id);

  insert into public.payment_reconciliations (club_id, branch_id, method, period_start, period_end, reconciled_total, note, reconciled_by)
  values (p_club_id, p_branch_id, p_method, p_period_start, p_period_end, v_total, p_note, auth.uid())
  returning id into v_id;

  perform public.write_audit_log(
    p_club_id, 'payment.reconciliation_confirmed', 'payment_reconciliations', v_id, null,
    jsonb_build_object('method', p_method, 'period_start', p_period_start, 'period_end', p_period_end, 'reconciled_total', v_total),
    p_note
  );

  return v_id;
end;
$function$;
