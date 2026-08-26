-- COMMERCIAL MODULE ARCHITECTURE, continued -- Customer 360 integration
-- (directive Section 19/57). Reuses the canonical customer identity
-- (customers.id) exclusively -- no second Shop-specific customer
-- profile. Returns sale + line + return-state, enough for a single
-- flat "Products purchased" table without a second round trip per row.
create or replace function public.get_customer_shop_purchases(p_club_id uuid, p_customer_id uuid)
returns table(
  sale_id uuid, invoice_id uuid, invoice_number text, sale_status text,
  product_name_ar text, variant_label text, quantity numeric, unit_price numeric,
  line_total numeric, returned_quantity numeric, created_at timestamptz
)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('customer.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not exists (select 1 from public.customers where id = p_customer_id and club_id = p_club_id) then
    raise exception 'customer not found in this club';
  end if;

  return query
  select s.id, i.id, i.invoice_number, s.status,
         p.name_ar, nullif(trim(both ' ' from coalesce(v.size, '') || ' ' || coalesce(v.color, '')), ''),
         si.quantity, si.unit_price, si.line_total, si.returned_quantity, s.created_at
  from public.shop_sales s
  join public.invoices i on i.id = s.invoice_id
  join public.shop_sale_items si on si.sale_id = s.id
  join public.shop_products p on p.id = si.product_id
  left join public.shop_product_variants v on v.id = si.variant_id
  where s.club_id = p_club_id and s.customer_id = p_customer_id
  order by s.created_at desc;
end;
$$;

revoke all on function public.get_customer_shop_purchases(uuid, uuid) from public;
revoke all on function public.get_customer_shop_purchases(uuid, uuid) from anon;
grant execute on function public.get_customer_shop_purchases(uuid, uuid) to authenticated;
