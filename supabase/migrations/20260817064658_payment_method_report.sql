-- Master Payment Directive task #87: get_payment_method_report().
--
-- The frontend (ReportsPage.tsx's PaymentMethodReportTab, added ahead
-- of this migration in the same task) needs collected/refunded/net per
-- payment method, with counts -- the actual reconciliation dimension a
-- manager checks at day/period close (cash drawer count vs. card
-- terminal batch vs. bank account). get_revenue_report() already has a
-- by_method breakdown but only revenue, no refund netting per method
-- and no counts -- this is a purpose-built report for the
-- reconciliation use case, following the exact same convention
-- (auth check, report.view permission, jsonb_build_object shape) as
-- get_revenue_report()/get_collections_report() rather than
-- introducing a new pattern.
create or replace function public.get_payment_method_report(
  p_club_id uuid,
  p_start_date date,
  p_end_date date,
  p_branch_id uuid default null
)
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

  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)) then
    raise exception 'not authorized';
  end if;

  if p_end_date < p_start_date then
    raise exception 'p_end_date must be on or after p_start_date';
  end if;

  select jsonb_build_object(
    'total_collected', coalesce((
      select sum(p.amount) from public.payments p
      where p.club_id = p_club_id and p.status = 'completed'
        and p.received_at::date between p_start_date and p_end_date
        and (p_branch_id is null or p.branch_id = p_branch_id)
    ), 0),
    'total_refunded', coalesce((
      select sum(r.amount) from public.refunds r
      join public.payments p on p.id = r.payment_id
      where p.club_id = p_club_id and r.status = 'completed'
        and r.refunded_at::date between p_start_date and p_end_date
        and (p_branch_id is null or p.branch_id = p_branch_id)
    ), 0),
    'by_method', coalesce((
      select jsonb_agg(jsonb_build_object(
        'method', x.method,
        'collected', x.collected,
        'collected_count', x.collected_count,
        'refunded', x.refunded,
        'refunded_count', x.refunded_count,
        'net', x.collected - x.refunded
      ) order by x.collected desc)
      from (
        select
          c.method,
          coalesce(c.collected, 0) as collected,
          coalesce(c.collected_count, 0) as collected_count,
          coalesce(r.refunded, 0) as refunded,
          coalesce(r.refunded_count, 0) as refunded_count
        from (
          select p.method, sum(p.amount) as collected, count(*) as collected_count
          from public.payments p
          where p.club_id = p_club_id and p.status = 'completed'
            and p.received_at::date between p_start_date and p_end_date
            and (p_branch_id is null or p.branch_id = p_branch_id)
          group by p.method
        ) c
        full outer join (
          -- Refunds are netted against the METHOD they were originally
          -- collected under (rp.method), not any method on the refund
          -- itself -- refunds has no method column of its own; a
          -- refund is always a reversal of a specific payment, so it
          -- always nets against that payment's method.
          select rp.method, sum(r.amount) as refunded, count(*) as refunded_count
          from public.refunds r
          join public.payments rp on rp.id = r.payment_id
          where rp.club_id = p_club_id and r.status = 'completed'
            and r.refunded_at::date between p_start_date and p_end_date
            and (p_branch_id is null or rp.branch_id = p_branch_id)
          group by rp.method
        ) r on r.method = c.method
      ) x
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_payment_method_report(uuid, date, date, uuid) from public, anon;
grant execute on function public.get_payment_method_report(uuid, date, date, uuid) to authenticated;

comment on function public.get_payment_method_report(uuid, date, date, uuid) is
  'Task #87: per-payment-method collected/refunded/net breakdown with counts, for reconciliation at day/period close (cash drawer vs. card terminal batch vs. bank account). Refunds netted against the method of the original payment (refunds has no method column of its own). full outer join so a method with only refunds and zero fresh collections in the period (or vice versa) still appears with the other side coalesced to 0, never silently dropped.';
