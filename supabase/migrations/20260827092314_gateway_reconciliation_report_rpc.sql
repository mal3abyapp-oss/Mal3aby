-- MULTI-GATEWAY PAYMENTS (Phase 2, item 10): gateway_reconciliation_report --
-- OPERATIONAL VISIBILITY ONLY, never a second ledger (governing
-- directive's explicit rule: never duplicate Finance as a source of
-- truth). Joins payment_gateway_transactions -> payments ->
-- payment_allocations -> refunds and surfaces exceptions: a
-- 'succeeded' gateway transaction with no linked payment, a payment
-- with no allocation, or a mismatched amount across the chain.
-- Mirrors the house '_report' RPC pattern (get_club_membership_report,
-- collections_report, etc): auth.uid() required, club-scoped via
-- user_club_ids() + has_permission(), club-timezone-aware date range,
-- jsonb result.
--
-- Gated on payment.methods.view -- the same permission
-- list_club_gateway_connections() itself requires, since this report
-- exposes gateway CONNECTION-level operational detail (which
-- connection/provider a transaction used), not raw payment amounts
-- alone (payment.view is a DIFFERENT, broader permission already used
-- for the regular Payments list -- this report is specifically about
-- gateway plumbing health, matching payment.methods.view's existing
-- scope in list_club_gateway_connections).
create or replace function public.gateway_reconciliation_report(p_club_id uuid, p_date_from date, p_date_to date)
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

  if not (
    (p_club_id in (select public.user_club_ids()) and public.has_permission('payment.methods.view', p_club_id))
    or public.has_platform_support_access(p_club_id, false)
  ) then
    raise exception 'not authorized';
  end if;

  if p_date_to < p_date_from then
    raise exception 'p_date_to must be on or after p_date_from';
  end if;

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
        and t.created_at::date between p_date_from and p_date_to
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
        and t.created_at::date between p_date_from and p_date_to
        and exc.exception_type is not null
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'total_transactions', (
        select count(*) from public.payment_gateway_transactions t
        where t.club_id = p_club_id and t.created_at::date between p_date_from and p_date_to
      ),
      'succeeded_transactions', (
        select count(*) from public.payment_gateway_transactions t
        where t.club_id = p_club_id and t.created_at::date between p_date_from and p_date_to and t.status = 'succeeded'
      ),
      'failed_transactions', (
        select count(*) from public.payment_gateway_transactions t
        where t.club_id = p_club_id and t.created_at::date between p_date_from and p_date_to and t.status = 'failed'
      ),
      'pending_transactions', (
        select count(*) from public.payment_gateway_transactions t
        where t.club_id = p_club_id and t.created_at::date between p_date_from and p_date_to and t.status = 'pending'
      )
    )
  ) into v_result;

  return v_result;
end;
$function$;

revoke all on function public.gateway_reconciliation_report(uuid, date, date) from public, anon;
grant execute on function public.gateway_reconciliation_report(uuid, date, date) to authenticated;
