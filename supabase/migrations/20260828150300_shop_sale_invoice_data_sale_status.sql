-- Commerce Pro C5: get_shop_sale_invoice_data gains sale_status,
-- distinct from invoice_status.
--
-- BUG FOUND DURING C5 SELF-REVIEW: the new SaleDetailDialog (Sales page
-- non-printable detail panel, plan Section 3) needs to know whether a
-- sale can still be returned (shop_sales.status in ('completed',
-- 'partially_returned'), the same check return_shop_sale itself
-- enforces). get_shop_sale_invoice_data's existing invoice_status
-- column is i.status (invoices.status: 'draft'/'issued'/'void') --
-- confirmed via direct read of this RPC's own live definition just
-- above -- NOT shop_sales.status ('draft'/'completed'/'cancelled'/
-- 'partially_returned'/'returned'). These are two different state
-- machines on two different tables; conflating them would have shown
-- the wrong status badge and driven the wrong "can this be returned"
-- decision in the UI. Fixed by exposing the real shop_sales.status
-- as a new, separate, appended column -- invoice_status is left
-- completely unchanged (still i.status, for anything that genuinely
-- wants the invoice's own draft/issued/void state).
--
-- CORRECTION (orchestrator review, applying this migration live): the
-- comment below was wrong, and its cited precedent was itself the
-- ALREADY-BROKEN original version of that migration, not the corrected
-- one. Postgres rejects CREATE OR REPLACE for any RETURNS TABLE shape
-- change, appended column or not -- confirmed live applying this exact
-- migration unmodified: "ERROR: 42P13: cannot change return type of
-- existing function." This is now the THIRD time this same mistake has
-- been made across C1/C4/C5 -- see COMMERCE_PRO_UPGRADE_PLAN.md
-- Section 2, invariant 8, added after this fix specifically so it stops
-- recurring in C6-C10. Fixed with the same explicit DROP FUNCTION +
-- grant re-statement pattern used for the prior two instances.
drop function if exists public.get_shop_sale_invoice_data(uuid);

create function public.get_shop_sale_invoice_data(p_sale_id uuid)
returns table(
  sale_id uuid,
  club_id uuid,
  invoice_id uuid,
  invoice_number text,
  branch_id uuid,
  branch_name text,
  location_name text,
  customer_id uuid,
  customer_name text,
  customer_mobile text,
  sold_by_name text,
  created_at timestamptz,
  subtotal numeric,
  discount_amount numeric,
  discount_reason text,
  total numeric,
  invoice_status text,
  payments jsonb,
  sale_status text
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  select s.club_id into v_club_id from public.shop_sales s where s.id = p_sale_id;
  if v_club_id is null then
    raise exception 'sale not found';
  end if;
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', v_club_id)
          or public.has_platform_support_access(v_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select
    s.id,
    s.club_id,
    i.id,
    i.invoice_number,
    i.branch_id,
    b.name,
    l.name,
    s.customer_id,
    c.full_name,
    c.mobile_display,
    pr.full_name,
    s.created_at,
    i.subtotal,
    s.discount_amount,
    s.discount_reason,
    i.total,
    i.status,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'payment_id', pay.id,
        'amount', pay.amount,
        'method', pay.method,
        'reference', pay.reference,
        'received_at', pay.received_at,
        'received_by_name', rp.full_name
      ) order by pay.received_at)
      from public.payment_allocations pa
      join public.payments pay on pay.id = pa.payment_id
      left join public.profiles rp on rp.user_id = pay.received_by
      where pa.invoice_id = i.id
    ), '[]'::jsonb),
    s.status
  from public.shop_sales s
  join public.invoices i on i.id = s.invoice_id
  join public.branches b on b.id = i.branch_id
  join public.shop_inventory_locations l on l.id = s.location_id
  left join public.customers c on c.id = s.customer_id
  left join public.profiles pr on pr.user_id = s.sold_by
  where s.id = p_sale_id;
end;
$$;

revoke all on function public.get_shop_sale_invoice_data(uuid) from public, anon;
grant execute on function public.get_shop_sale_invoice_data(uuid) to authenticated;
