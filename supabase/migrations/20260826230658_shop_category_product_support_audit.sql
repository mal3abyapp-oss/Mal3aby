-- MASTER ADMIN + SHOP INTEGRATION, continued -- same v_via_support
-- dual-audit fix applied to catalog CRUD RPCs.
create or replace function public.create_shop_category(p_club_id uuid, p_name_ar text, p_name_en text default null)
returns uuid
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_id uuid;
  v_via_support boolean;
begin
  v_via_support := not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', p_club_id))
    and public.has_platform_support_access(p_club_id, true);
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', p_club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  if p_name_ar is null or trim(p_name_ar) = '' then
    raise exception 'a category name is required';
  end if;

  insert into public.shop_categories (club_id, name_ar, name_en, created_by)
  values (p_club_id, p_name_ar, p_name_en, auth.uid())
  returning id into v_id;

  perform public.write_audit_log(p_club_id, 'shop_category.created', 'shop_category', v_id, null, jsonb_build_object('name_ar', p_name_ar), null);
  if v_via_support then
    perform public.write_audit_log_as_support(p_club_id, 'shop_category.created', 'shop_category', v_id, null, jsonb_build_object('name_ar', p_name_ar), null);
  end if;
  return v_id;
end;
$$;

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
  v_via_support boolean;
begin
  v_via_support := not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', p_club_id))
    and public.has_platform_support_access(p_club_id, true);
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', p_club_id) or v_via_support) then
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
  if v_via_support then
    perform public.write_audit_log_as_support(p_club_id, 'product.created', 'shop_product', v_id, null, jsonb_build_object('name_ar', p_name_ar, 'base_price', p_base_price), null);
  end if;
  return v_id;
end;
$$;
