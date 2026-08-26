-- COMMERCIAL MODULE ARCHITECTURE, continued -- sale listing/detail read
-- RPCs.

create or replace function public.list_shop_sales(p_club_id uuid, p_status text default null, p_limit int default 50, p_offset int default 0)
returns table(
  sale_id uuid, invoice_number text, customer_name text, sold_by_name text,
  status text, total numeric, created_at timestamptz
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;

  return query
  select s.id, i.invoice_number, c.full_name, pr.full_name, s.status, i.total, s.created_at
  from public.shop_sales s
  join public.invoices i on i.id = s.invoice_id
  left join public.customers c on c.id = s.customer_id
  left join public.profiles pr on pr.user_id = s.sold_by
  where s.club_id = p_club_id
    and (p_status is null or s.status = p_status)
  order by s.created_at desc
  limit p_limit offset p_offset;
end;
$$;

revoke all on function public.list_shop_sales(uuid, text, int, int) from public;
revoke all on function public.list_shop_sales(uuid, text, int, int) from anon;
grant execute on function public.list_shop_sales(uuid, text, int, int) to authenticated;

create or replace function public.get_shop_sale_detail(p_sale_id uuid)
returns table(
  item_id uuid, product_name_ar text, variant_label text, quantity numeric,
  unit_price numeric, line_total numeric, returned_quantity numeric
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

  return query
  select si.id, p.name_ar, nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
         si.quantity, si.unit_price, si.line_total, si.returned_quantity
  from public.shop_sale_items si
  join public.shop_products p on p.id = si.product_id
  left join public.shop_product_variants v on v.id = si.variant_id
  where si.sale_id = p_sale_id;
end;
$$;

revoke all on function public.get_shop_sale_detail(uuid) from public;
revoke all on function public.get_shop_sale_detail(uuid) from anon;
grant execute on function public.get_shop_sale_detail(uuid) to authenticated;
