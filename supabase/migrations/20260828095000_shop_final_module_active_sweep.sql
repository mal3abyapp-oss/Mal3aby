-- SHOP MODULE UX HARDENING (2026-08-28) -- final completion of the
-- systematic module-active sweep. A full pg_proc sweep (grep every
-- function whose body references a shop_* table, not just functions
-- named list_shop_*/get_shop_*) found 6 more RPCs still missing
-- _shop_module_active(club_id), including one (list_shop_categories_all)
-- that this very session's own earlier fix (20260828080000) introduced
-- without the check -- an oversight in that migration, corrected here.
--
-- create_shop_product_variant, update_shop_product,
-- update_shop_product_variant: real write RPCs actively used by
-- ShopProductsPage.tsx's Add/Edit Product and Variants dialogs (built/
-- reviewed earlier this session) -- the same real gap as every other
-- write RPC already fixed.
--
-- get_shop_top_products: powers ReportShopPage.tsx's revenue/top-
-- products report. Gated on report.view (not shop.view) -- a much more
-- broadly-held permission across roles (accountants, managers) than
-- shop.view, making this arguably the widest-reaching instance of this
-- whole gap class.
--
-- get_customer_shop_purchases: powers the Customer 360 Shop-purchases
-- tab. Gated on customer.view, independent of any Shop permission --
-- same reasoning as get_shop_top_products.
--
-- list_shop_categories_all: this session's own new RPC (Manage
-- Categories dialog) -- missed the check when first written.
--
-- _apply_shop_inventory_movement_internal deliberately left unchanged:
-- it is an internal helper called only from within already-gated RPCs
-- (receive_shop_stock, transfer_shop_stock, adjust_shop_stock,
-- complete_shop_stock_count, return_shop_sale -- all confirmed to
-- already check _shop_module_active before calling it), so adding a
-- second check here would be redundant, not a real gap.

create or replace function public.create_shop_product_variant(p_product_id uuid, p_size text default null, p_color text default null, p_sku text default null, p_barcode text default null, p_price_override numeric default null)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_club_id uuid;
  v_id uuid;
  v_via_support boolean;
begin
  select club_id into v_club_id from public.shop_products where id = p_product_id;
  if v_club_id is null then
    raise exception 'product not found';
  end if;
  v_via_support := not (v_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', v_club_id))
    and public.has_platform_support_access(v_club_id, true);
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', v_club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  if p_price_override is not null and p_price_override < 0 then
    raise exception 'price cannot be negative';
  end if;

  insert into public.shop_product_variants (product_id, club_id, size, color, sku, barcode, price_override)
  values (p_product_id, v_club_id, nullif(p_size, ''), nullif(p_color, ''), nullif(p_sku, ''), nullif(p_barcode, ''), p_price_override)
  returning id into v_id;

  perform public.write_audit_log(v_club_id, 'product.variant_created', 'shop_product_variant', v_id, null, jsonb_build_object('product_id', p_product_id, 'size', p_size, 'color', p_color), null);
  if v_via_support then
    perform public.write_audit_log_as_support(v_club_id, 'product.variant_created', 'shop_product_variant', v_id, null, jsonb_build_object('product_id', p_product_id, 'size', p_size, 'color', p_color), null);
  end if;
  return v_id;
end;
$$;

create or replace function public.update_shop_product(p_product_id uuid, p_name_ar text, p_name_en text default null, p_category_id uuid default null, p_description text default null, p_base_price numeric default 0, p_sku text default null, p_barcode text default null, p_image_url text default null, p_reorder_level integer default null, p_status text default 'active')
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.shop_products;
  v_via_support boolean;
begin
  select * into v_before from public.shop_products where id = p_product_id;
  if v_before.id is null then
    raise exception 'product not found';
  end if;
  v_via_support := not (v_before.club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', v_before.club_id))
    and public.has_platform_support_access(v_before.club_id, true);
  if not (v_before.club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', v_before.club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_before.club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  if p_status not in ('active', 'archived') then
    raise exception 'invalid status';
  end if;
  if p_base_price < 0 then
    raise exception 'price cannot be negative';
  end if;

  update public.shop_products
  set name_ar = p_name_ar, name_en = p_name_en, category_id = p_category_id, description = p_description,
      base_price = p_base_price, sku = nullif(p_sku, ''), barcode = nullif(p_barcode, ''),
      image_url = p_image_url, reorder_level = p_reorder_level, status = p_status, updated_at = now()
  where id = p_product_id;

  perform public.write_audit_log(
    v_before.club_id, 'product.updated', 'shop_product', p_product_id,
    to_jsonb(v_before), jsonb_build_object('name_ar', p_name_ar, 'base_price', p_base_price, 'status', p_status),
    null
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_before.club_id, 'product.updated', 'shop_product', p_product_id,
      to_jsonb(v_before), jsonb_build_object('name_ar', p_name_ar, 'base_price', p_base_price, 'status', p_status),
      null
    );
  end if;
end;
$$;

create or replace function public.update_shop_product_variant(p_variant_id uuid, p_size text default null, p_color text default null, p_sku text default null, p_barcode text default null, p_price_override numeric default null, p_status text default 'active')
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.shop_product_variants;
  v_via_support boolean;
begin
  select * into v_before from public.shop_product_variants where id = p_variant_id;
  if v_before.id is null then
    raise exception 'variant not found';
  end if;
  v_via_support := not (v_before.club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', v_before.club_id))
    and public.has_platform_support_access(v_before.club_id, true);
  if not (v_before.club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', v_before.club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_before.club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  if p_status not in ('active', 'archived') then
    raise exception 'invalid status';
  end if;
  if p_price_override is not null and p_price_override < 0 then
    raise exception 'price cannot be negative';
  end if;

  update public.shop_product_variants
  set size = nullif(p_size, ''), color = nullif(p_color, ''), sku = nullif(p_sku, ''),
      barcode = nullif(p_barcode, ''), price_override = p_price_override, status = p_status
  where id = p_variant_id;

  perform public.write_audit_log(
    v_before.club_id, 'product.variant_updated', 'shop_product_variant', p_variant_id,
    to_jsonb(v_before), jsonb_build_object('size', p_size, 'color', p_color, 'status', p_status),
    null
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      v_before.club_id, 'product.variant_updated', 'shop_product_variant', p_variant_id,
      to_jsonb(v_before), jsonb_build_object('size', p_size, 'color', p_color, 'status', p_status),
      null
    );
  end if;
end;
$$;

create or replace function public.get_shop_top_products(p_club_id uuid, p_start_date date default null, p_end_date date default null, p_limit integer default 10)
returns table(product_id uuid, product_name_ar text, units_sold numeric, units_returned numeric, revenue numeric)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('report.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select
    p.id,
    p.name_ar,
    coalesce(sum(si.quantity), 0) as units_sold,
    coalesce(sum(si.returned_quantity), 0) as units_returned,
    coalesce(sum(ii.line_total), 0) as revenue
  from public.shop_products p
  join public.shop_sale_items si on si.product_id = p.id
  join public.shop_sales s on s.id = si.sale_id
  join public.invoice_items ii on ii.id = si.invoice_item_id
  where p.club_id = p_club_id
    and s.status in ('completed', 'partially_returned', 'returned')
    and (p_start_date is null or s.created_at::date >= p_start_date)
    and (p_end_date is null or s.created_at::date <= p_end_date)
  group by p.id, p.name_ar
  order by units_sold desc
  limit p_limit;
end;
$$;

create or replace function public.get_customer_shop_purchases(p_club_id uuid, p_customer_id uuid)
returns table(sale_id uuid, invoice_id uuid, invoice_number text, sale_status text, product_name_ar text, variant_label text, quantity numeric, unit_price numeric, line_total numeric, returned_quantity numeric, created_at timestamptz)
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
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
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

create or replace function public.list_shop_categories_all(p_club_id uuid)
returns table(category_id uuid, name_ar text, name_en text, status text)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  return query select c.id, c.name_ar, c.name_en, c.status from public.shop_categories c where c.club_id = p_club_id order by c.status, c.name_ar;
end;
$$;
