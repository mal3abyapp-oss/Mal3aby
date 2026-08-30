-- PRINTING PRODUCTION ACCEPTANCE (2026-08-30), Sections 8 + 16: two
-- real defects found in ShopInvoiceDocument.tsx while verifying the
-- Shop invoice's return/refund presentation.
--
-- (1) Section 16 violation: the frontend computed
--     `outstanding = max(0, sale.total - paid)` itself, from the raw
--     `payments` array get_shop_sale_invoice_data() already returned
--     -- a client-side recomputation of the exact formula this
--     session's earlier Financial Integrity pass already fixed twice
--     in get_invoice_payment_summary() (full-refund and Shop-return
--     double-counting). Reproducible: a sale partially paid then
--     fully returned before being paid off would show a phantom
--     "Outstanding" balance for merchandise already given back --
--     the identical bug class, just re-implemented a second time in
--     a screen that never adopted the authoritative RPC.
--
-- (2) Section 8 violation: shop_sale_items.returned_quantity was
--     fetched by the frontend but never rendered anywhere -- a
--     returned/partially-returned Shop sale's printed invoice looked
--     identical to an ordinary, fully-kept sale. No "Returned" state,
--     no per-line returned quantity, no refund total shown anywhere
--     in the document body.
--
-- Fix (this migration, RPC side only -- frontend fix follows in the
-- same commit): get_shop_sale_invoice_data() now returns the
-- authoritative paid/refunded/outstanding/payment_status by calling
-- get_invoice_payment_summary() internally (the single source of
-- truth already fixed twice this session), plus sale_status was
-- already being selected but never exposed in the RETURNS TABLE --
-- now it is, so the frontend can render a Returned/Partially Returned
-- banner instead of silently showing nothing.
drop function if exists public.get_shop_sale_invoice_data(uuid);

create or replace function public.get_shop_sale_invoice_data(p_sale_id uuid)
 returns table(
   sale_id uuid, club_id uuid, invoice_id uuid, invoice_number text, branch_id uuid,
   branch_name text, location_name text, customer_id uuid, customer_name text,
   customer_mobile text, sold_by_name text, created_at timestamp with time zone,
   subtotal numeric, discount_amount numeric, discount_reason text, total numeric,
   invoice_status text, payments jsonb, sale_status text,
   paid numeric, refunded numeric, outstanding numeric, payment_status text
 )
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_club_id uuid;
  v_invoice_id uuid;
  v_summary record;
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

  select s.invoice_id into v_invoice_id from public.shop_sales s where s.id = p_sale_id;
  select * into v_summary from public.get_invoice_payment_summary(array[v_invoice_id]) limit 1;

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
    s.status,
    coalesce(v_summary.paid, 0),
    coalesce(v_summary.refunded, 0),
    coalesce(v_summary.outstanding, 0),
    coalesce(v_summary.payment_status, 'unpaid')
  from public.shop_sales s
  join public.invoices i on i.id = s.invoice_id
  join public.branches b on b.id = i.branch_id
  join public.shop_inventory_locations l on l.id = s.location_id
  left join public.customers c on c.id = s.customer_id
  left join public.profiles pr on pr.user_id = s.sold_by
  where s.id = p_sale_id;
end;
$function$;

-- Re-grant exactly what the prior definition had (the drop above
-- removes all grants).
grant execute on function public.get_shop_sale_invoice_data(uuid) to authenticated;
