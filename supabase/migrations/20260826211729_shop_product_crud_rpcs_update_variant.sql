-- COMMERCIAL MODULE ARCHITECTURE, continued -- product update + variant
-- create RPCs.

create or replace function public.update_shop_product(
  p_product_id uuid,
  p_name_ar text,
  p_name_en text,
  p_category_id uuid,
  p_description text,
  p_base_price numeric,
  p_sku text,
  p_barcode text,
  p_image_url text,
  p_reorder_level integer,
  p_status text
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.shop_products;
begin
  select * into v_before from public.shop_products where id = p_product_id;
  if v_before.id is null then
    raise exception 'product not found';
  end if;
  if not (v_before.club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', v_before.club_id)
          or public.has_platform_support_access(v_before.club_id, true)) then
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
end;
$$;

revoke all on function public.update_shop_product(uuid, text, text, uuid, text, numeric, text, text, text, integer, text) from public;
revoke all on function public.update_shop_product(uuid, text, text, uuid, text, numeric, text, text, text, integer, text) from anon;
grant execute on function public.update_shop_product(uuid, text, text, uuid, text, numeric, text, text, text, integer, text) to authenticated;

create or replace function public.create_shop_product_variant(
  p_product_id uuid,
  p_size text,
  p_color text,
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
begin
  select club_id into v_club_id from public.shop_products where id = p_product_id;
  if v_club_id is null then
    raise exception 'product not found';
  end if;
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', v_club_id)
          or public.has_platform_support_access(v_club_id, true)) then
    raise exception 'not authorized';
  end if;
  if p_price_override is not null and p_price_override < 0 then
    raise exception 'price cannot be negative';
  end if;

  insert into public.shop_product_variants (product_id, club_id, size, color, sku, barcode, price_override)
  values (p_product_id, v_club_id, nullif(p_size, ''), nullif(p_color, ''), nullif(p_sku, ''), nullif(p_barcode, ''), p_price_override)
  returning id into v_id;

  perform public.write_audit_log(v_club_id, 'product.variant_created', 'shop_product_variant', v_id, null, jsonb_build_object('product_id', p_product_id, 'size', p_size, 'color', p_color), null);
  return v_id;
end;
$$;

revoke all on function public.create_shop_product_variant(uuid, text, text, text, text, numeric) from public;
revoke all on function public.create_shop_product_variant(uuid, text, text, text, text, numeric) from anon;
grant execute on function public.create_shop_product_variant(uuid, text, text, text, text, numeric) to authenticated;
