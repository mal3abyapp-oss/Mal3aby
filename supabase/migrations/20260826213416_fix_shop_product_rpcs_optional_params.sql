-- Fixes a real build-gate failure caught by npm run build (tsc -b,
-- not just --noEmit -- same class of discrepancy this project has hit
-- before): create_shop_product/update_shop_product/
-- create_shop_product_variant had several params with no `default`
-- clause even though the function body already treats them as
-- optional (`if p_category_id is not null then ...`). The Supabase
-- type generator maps a no-default param to a required, non-nullable
-- TS argument -- correct for genuinely required params, but wrong here
-- since these were always meant to be optional. Adding `default null`
-- (bodies unchanged -- they already handle null correctly) makes the
-- generated types `?:` optional, matching actual intent.
create or replace function public.create_shop_product(
  p_club_id uuid,
  p_name_ar text,
  p_name_en text default null,
  p_category_id uuid default null,
  p_description text default null,
  p_base_price numeric default 0,
  p_has_variants boolean default false,
  p_sku text default null,
  p_barcode text default null,
  p_image_url text default null,
  p_reorder_level integer default null
)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_id uuid;
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', p_club_id)
          or public.has_platform_support_access(p_club_id, true)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  if p_name_ar is null or trim(p_name_ar) = '' then
    raise exception 'a product name is required';
  end if;
  if p_base_price < 0 then
    raise exception 'price cannot be negative';
  end if;
  if p_category_id is not null and not exists (select 1 from public.shop_categories where id = p_category_id and club_id = p_club_id) then
    raise exception 'category does not belong to this club';
  end if;

  insert into public.shop_products (club_id, category_id, name_ar, name_en, description, base_price, has_variants, sku, barcode, image_url, reorder_level, created_by)
  values (p_club_id, p_category_id, p_name_ar, p_name_en, p_description, p_base_price, p_has_variants, nullif(p_sku, ''), nullif(p_barcode, ''), p_image_url, p_reorder_level, auth.uid())
  returning id into v_id;

  perform public.write_audit_log(p_club_id, 'product.created', 'shop_product', v_id, null, jsonb_build_object('name_ar', p_name_ar, 'base_price', p_base_price), null);
  return v_id;
end;
$$;

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
