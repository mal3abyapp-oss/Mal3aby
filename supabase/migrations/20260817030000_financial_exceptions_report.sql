-- Gate 13 task #59: financial exception report -- discount/refund
-- transparency.
--
-- Audit finding: discount_amount (bookings), discount (invoices),
-- void invoices, and refunds (amount/reason/refunded_by) all exist and
-- are correctly captured server-side, but nowhere in the app could an
-- owner see an itemized list of exceptions -- only ever an aggregate
-- refunds_total number (get_revenue_report/get_executive_dashboard).
-- A discount is exactly the kind of thing that needs a "who, how much,
-- on what" trail for fraud/abuse review (Section AK-adjacent concern,
-- same spirit as the entitlement/upgrade transparency work already
-- built). Follows the same auth/permission convention as every other
-- report RPC (report.view).
create or replace function public.get_financial_exceptions_report(
  p_club_id uuid,
  p_start_date date,
  p_end_date date
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
    'total_discounts', coalesce((
      select sum(b.discount_amount) from public.bookings b
      where b.club_id = p_club_id and b.discount_amount > 0
        and b.created_at::date between p_start_date and p_end_date
    ), 0),
    'total_refunds', coalesce((
      select sum(r.amount) from public.refunds r
      join public.payments p on p.id = r.payment_id
      where p.club_id = p_club_id and r.status = 'completed'
        and r.refunded_at::date between p_start_date and p_end_date
    ), 0),
    'void_invoice_count', coalesce((
      select count(*) from public.invoices i
      where i.club_id = p_club_id and i.status = 'void'
        and i.created_at::date between p_start_date and p_end_date
    ), 0),
    'discounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'booking_id', d.booking_id,
        'invoice_number', d.invoice_number,
        'customer_name', d.customer_name,
        'discount_amount', d.discount_amount,
        'total_price', d.total_price,
        'applied_by', d.applied_by,
        'created_at', d.created_at
      ) order by d.created_at desc)
      from (
        select b.id as booking_id, i.invoice_number, c.full_name as customer_name,
               b.discount_amount, b.total_price, coalesce(pr.full_name, '—') as applied_by, b.created_at
        from public.bookings b
        left join public.invoices i on i.id = b.invoice_id
        left join public.customers c on c.id = b.customer_id
        left join public.profiles pr on pr.user_id = b.created_by
        where b.club_id = p_club_id and b.discount_amount > 0
          and b.created_at::date between p_start_date and p_end_date
      ) d
    ), '[]'::jsonb),
    'refunds', coalesce((
      select jsonb_agg(jsonb_build_object(
        'refund_id', r.refund_id,
        'amount', r.amount,
        'reason', r.reason,
        'refunded_by', r.refunded_by,
        'refunded_at', r.refunded_at,
        'customer_name', r.customer_name,
        'payment_method', r.payment_method
      ) order by r.refunded_at desc)
      from (
        select ref.id as refund_id, ref.amount, ref.reason, ref.refunded_at,
               coalesce(pr.full_name, '—') as refunded_by,
               coalesce(c.full_name, '—') as customer_name, p.method as payment_method
        from public.refunds ref
        join public.payments p on p.id = ref.payment_id
        left join public.customers c on c.id = p.customer_id
        left join public.profiles pr on pr.user_id = ref.refunded_by
        where p.club_id = p_club_id and ref.status = 'completed'
          and ref.refunded_at::date between p_start_date and p_end_date
      ) r
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.get_financial_exceptions_report(uuid, date, date) from public, anon;
grant execute on function public.get_financial_exceptions_report(uuid, date, date) to authenticated;

comment on function public.get_financial_exceptions_report(uuid, date, date) is
  'Gate 13 #59: itemized discount/refund/void exception list (who, how much, on what, when) -- not just an aggregate total. Same report.view permission gate as the other reports/* RPCs.';
