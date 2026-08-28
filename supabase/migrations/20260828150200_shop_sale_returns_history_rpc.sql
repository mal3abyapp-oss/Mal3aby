-- Commerce Pro C5: get_shop_sale_returns_history(p_sale_id) -- prior
-- return/refund history for a sale, needed by both the new non-
-- printable Sale Detail panel (plan Section 3) and the rebuilt Returns
-- UX (plan Section 4, "prior refunds" in the refund summary). Neither
-- get_shop_sale_detail (item lines only, no return-event history) nor
-- get_shop_sale_invoice_data (invoice header + payments, no returns)
-- carries this -- a genuinely new read, not a duplicate of either.
--
-- One row per shop_sale_return, with its lines aggregated into a jsonb
-- array (a return can cover multiple sale items in one submission) and
-- its linked refund amount/method/status joined in when one exists
-- (p_refund_amount was optional on return_shop_sale from the start --
-- a restock-only return with no refund is valid and must show refund
-- data as null, not 0).
create or replace function public.get_shop_sale_returns_history(p_sale_id uuid)
returns table(
  return_id uuid,
  processed_by_name text,
  restock boolean,
  reason text,
  created_at timestamptz,
  refund_amount numeric,
  refund_method text,
  refund_status text,
  lines jsonb
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
begin
  select club_id into v_club_id from public.shop_sales where id = p_sale_id;
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
    sr.id,
    pr.full_name,
    sr.restock,
    sr.reason,
    sr.created_at,
    r.amount,
    pay.method,
    r.status,
    (
      select coalesce(jsonb_agg(jsonb_build_object(
        'sale_item_id', sri.sale_item_id,
        'quantity', sri.quantity,
        'product_name_ar', p.name_ar,
        'variant_label', nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), '')
      )), '[]'::jsonb)
      from public.shop_sale_return_items sri
      join public.shop_sale_items si on si.id = sri.sale_item_id
      join public.shop_products p on p.id = si.product_id
      left join public.shop_product_variants v on v.id = si.variant_id
      where sri.return_id = sr.id
    )
  from public.shop_sale_returns sr
  left join public.profiles pr on pr.user_id = sr.processed_by
  left join public.refunds r on r.id = sr.refund_payment_id
  left join public.payments pay on pay.id = r.payment_id
  where sr.sale_id = p_sale_id
  order by sr.created_at desc;
end;
$$;

revoke all on function public.get_shop_sale_returns_history(uuid) from public;
revoke all on function public.get_shop_sale_returns_history(uuid) from anon;
grant execute on function public.get_shop_sale_returns_history(uuid) to authenticated;
