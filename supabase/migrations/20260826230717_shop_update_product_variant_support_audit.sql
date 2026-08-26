-- MASTER ADMIN + SHOP INTEGRATION, continued -- same v_via_support
-- dual-audit fix applied to update_shop_product/create_shop_product_variant.
create or replace function public.update_shop_product(
  p_product_id uuid,
  p_name_ar text,
  p_name_en text default null,
  p_category_id uuid default null,
  p_description text default null,
  p_base_price numeric default 0,
  p_sku text default null,
  p_barcode text default null,
  p_image_url text default null,
  p_reorder_level integer default null,
  p_status text default 'active'
)
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

create or replace function public.create_shop_product_variant(
  p_product_id uuid,
  p_size text default null,
  p_color text default null,
  p_sku text default null,
  p_barcode text default null,
  p_price_override numeric default null
)
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
