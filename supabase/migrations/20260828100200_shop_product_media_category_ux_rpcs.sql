-- COMMERCE PRO C1 (2026-08-28) -- RPC updates for Product Media +
-- Category UX. See COMMERCE_PRO_UPGRADE_PLAN.md Section 4 (Phase C1).
--
-- Every function body below is copied verbatim from its current live
-- definition (as of 20260828095000_shop_final_module_active_sweep.sql /
-- 20260828080000_shop_category_update_rpc.sql / 20260826230658_shop_category_product_support_audit.sql
-- / 20260826211854_shop_read_rpcs.sql -- the actual latest migrations
-- for each function, confirmed by reading them directly) with ONLY the
-- new image/display-order fields added. Auth checks, module-active
-- gates, and support-audit mirroring (write_audit_log_as_support) are
-- preserved exactly, not weakened or restructured, per the plan's own
-- instruction.
--
-- Where a new parameter is appended, the parameter type list changes,
-- so `create or replace function` on the new signature creates a
-- distinct overload rather than replacing in place -- the old
-- signature is explicitly dropped in each such case, matching this
-- project's established practice (e.g.
-- 20260826235307_drop_orphaned_return_shop_sale_overload.sql) of never
-- leaving two live overloads of the same RPC name.

begin;

-- ============================================================
-- create_shop_product: append p_image_urls (jsonb array of extra
-- image URLs). p_image_url (primary image) already existed.
-- ============================================================
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
  p_reorder_level integer default null,
  p_image_urls jsonb default '[]'::jsonb
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
  if p_image_urls is not null and jsonb_typeof(p_image_urls) <> 'array' then
    raise exception 'image_urls must be a jsonb array';
  end if;

  insert into public.shop_products (club_id, category_id, name_ar, name_en, description, base_price, has_variants, sku, barcode, image_url, reorder_level, image_urls, created_by)
  values (p_club_id, p_category_id, p_name_ar, p_name_en, p_description, p_base_price, p_has_variants, nullif(p_sku, ''), nullif(p_barcode, ''), p_image_url, p_reorder_level, coalesce(p_image_urls, '[]'::jsonb), auth.uid())
  returning id into v_id;

  perform public.write_audit_log(p_club_id, 'product.created', 'shop_product', v_id, null, jsonb_build_object('name_ar', p_name_ar, 'base_price', p_base_price), null);
  if v_via_support then
    perform public.write_audit_log_as_support(p_club_id, 'product.created', 'shop_product', v_id, null, jsonb_build_object('name_ar', p_name_ar, 'base_price', p_base_price), null);
  end if;
  return v_id;
end;
$$;

-- Old 11-arg signature is a distinct overload from the 12-arg one
-- above -- drop it explicitly.
drop function if exists public.create_shop_product(uuid, text, text, uuid, text, numeric, boolean, text, text, text, integer);

revoke all on function public.create_shop_product(uuid, text, text, uuid, text, numeric, boolean, text, text, text, integer, jsonb) from public;
revoke all on function public.create_shop_product(uuid, text, text, uuid, text, numeric, boolean, text, text, text, integer, jsonb) from anon;
grant execute on function public.create_shop_product(uuid, text, text, uuid, text, numeric, boolean, text, text, text, integer, jsonb) to authenticated;

-- ============================================================
-- update_shop_product: append p_image_urls.
-- ============================================================
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
  p_status text default 'active',
  p_image_urls jsonb default null
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
  if not public._shop_module_active(v_before.club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  if p_status not in ('active', 'archived') then
    raise exception 'invalid status';
  end if;
  if p_base_price < 0 then
    raise exception 'price cannot be negative';
  end if;
  if p_image_urls is not null and jsonb_typeof(p_image_urls) <> 'array' then
    raise exception 'image_urls must be a jsonb array';
  end if;

  update public.shop_products
  set name_ar = p_name_ar, name_en = p_name_en, category_id = p_category_id, description = p_description,
      base_price = p_base_price, sku = nullif(p_sku, ''), barcode = nullif(p_barcode, ''),
      image_url = p_image_url, reorder_level = p_reorder_level, status = p_status,
      image_urls = coalesce(p_image_urls, image_urls), updated_at = now()
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

-- Old 11-arg signature is a distinct overload from the 12-arg one
-- above -- drop it explicitly.
drop function if exists public.update_shop_product(uuid, text, text, uuid, text, numeric, text, text, text, integer, text);

revoke all on function public.update_shop_product(uuid, text, text, uuid, text, numeric, text, text, text, integer, text, jsonb) from public;
revoke all on function public.update_shop_product(uuid, text, text, uuid, text, numeric, text, text, text, integer, text, jsonb) from anon;
grant execute on function public.update_shop_product(uuid, text, text, uuid, text, numeric, text, text, text, integer, text, jsonb) to authenticated;

-- ============================================================
-- create_shop_category: append p_image_url, p_display_order.
-- ============================================================
create or replace function public.create_shop_category(
  p_club_id uuid,
  p_name_ar text,
  p_name_en text default null,
  p_image_url text default null,
  p_display_order integer default 0
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
    raise exception 'a category name is required';
  end if;

  insert into public.shop_categories (club_id, name_ar, name_en, image_url, display_order, created_by)
  values (p_club_id, p_name_ar, p_name_en, p_image_url, coalesce(p_display_order, 0), auth.uid())
  returning id into v_id;

  perform public.write_audit_log(p_club_id, 'shop_category.created', 'shop_category', v_id, null, jsonb_build_object('name_ar', p_name_ar), null);
  if v_via_support then
    perform public.write_audit_log_as_support(p_club_id, 'shop_category.created', 'shop_category', v_id, null, jsonb_build_object('name_ar', p_name_ar), null);
  end if;
  return v_id;
end;
$$;

-- The pre-C1 3-arg signature (uuid, text, text) is a distinct overload
-- from the 5-arg signature above -- drop it explicitly.
drop function if exists public.create_shop_category(uuid, text, text);

revoke all on function public.create_shop_category(uuid, text, text, text, integer) from public;
revoke all on function public.create_shop_category(uuid, text, text, text, integer) from anon;
grant execute on function public.create_shop_category(uuid, text, text, text, integer) to authenticated;

-- ============================================================
-- update_shop_category: append p_image_url, p_display_order.
-- ============================================================
create or replace function public.update_shop_category(
  p_category_id uuid,
  p_name_ar text default null,
  p_name_en text default null,
  p_status text default null,
  p_image_url text default null,
  p_display_order integer default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_club_id uuid;
  v_before jsonb;
  v_via_support boolean;
begin
  select c.club_id into v_club_id from public.shop_categories c where c.id = p_category_id;
  if v_club_id is null then
    raise exception 'category not found';
  end if;

  v_via_support := not (v_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', v_club_id))
    and public.has_platform_support_access(v_club_id, true);
  if not (v_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', v_club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(v_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  if p_status is not null and p_status not in ('active', 'archived') then
    raise exception 'invalid status: %', p_status;
  end if;
  if p_name_ar is not null and trim(p_name_ar) = '' then
    raise exception 'a category name is required';
  end if;

  select to_jsonb(c) into v_before from public.shop_categories c where c.id = p_category_id;

  update public.shop_categories
    set name_ar = coalesce(p_name_ar, name_ar),
        name_en = case when p_name_en is not null then nullif(p_name_en, '') else name_en end,
        status = coalesce(p_status, status),
        image_url = case when p_image_url is not null then nullif(p_image_url, '') else image_url end,
        display_order = coalesce(p_display_order, display_order)
    where id = p_category_id;

  perform public.write_audit_log(v_club_id, 'shop_category.updated', 'shop_category', p_category_id, v_before,
    jsonb_build_object('name_ar', p_name_ar, 'name_en', p_name_en, 'status', p_status, 'display_order', p_display_order), null);
  if v_via_support then
    perform public.write_audit_log_as_support(v_club_id, 'shop_category.updated', 'shop_category', p_category_id, v_before,
      jsonb_build_object('name_ar', p_name_ar, 'name_en', p_name_en, 'status', p_status, 'display_order', p_display_order), null);
  end if;
end;
$$;

-- Old 4-arg signature is a distinct overload from the 6-arg one above
-- -- drop it explicitly (matches this project's own established
-- practice, e.g. 20260826235307_drop_orphaned_return_shop_sale_overload.sql).
drop function if exists public.update_shop_category(uuid, text, text, text);

revoke all on function public.update_shop_category(uuid, text, text, text, text, integer) from public;
revoke all on function public.update_shop_category(uuid, text, text, text, text, integer) from anon;
grant execute on function public.update_shop_category(uuid, text, text, text, text, integer) to authenticated;

-- ============================================================
-- list_shop_products: append image_urls to the returned row shape.
--
-- CORRECTION (orchestrator review, applying this migration live):
-- the original comment here was wrong -- Postgres rejects
-- `create or replace function` when the RETURNS TABLE row shape
-- changes, even with an unchanged input signature
-- ("cannot change return type of existing function... Row type
-- defined by OUT parameters is different"), confirmed live applying
-- this exact migration. An explicit `drop function` is required first
-- for all three read RPCs below, matching the pattern already used
-- elsewhere in this file for input-signature changes. Grants ARE
-- re-stated after each drop+create, since a dropped function loses its
-- prior grants.
-- ============================================================
drop function if exists public.list_shop_products(uuid, text, uuid, text);

create function public.list_shop_products(p_club_id uuid, p_search text default null, p_category_id uuid default null, p_status text default 'active')
returns table(
  product_id uuid, name_ar text, name_en text, category_id uuid, category_name_ar text,
  description text, image_url text, has_variants boolean, base_price numeric,
  sku text, barcode text, reorder_level integer, status text, created_at timestamptz,
  image_urls jsonb
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
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  return query
  select p.id, p.name_ar, p.name_en, p.category_id, c.name_ar,
         p.description, p.image_url, p.has_variants, p.base_price,
         p.sku, p.barcode, p.reorder_level, p.status, p.created_at,
         p.image_urls
  from public.shop_products p
  left join public.shop_categories c on c.id = p.category_id
  where p.club_id = p_club_id
    and (p_status is null or p.status = p_status)
    and (p_category_id is null or p.category_id = p_category_id)
    and (p_search is null or p_search = '' or p.name_ar ilike '%' || p_search || '%' or p.name_en ilike '%' || p_search || '%' or p.sku ilike '%' || p_search || '%' or p.barcode = p_search)
  order by p.name_ar;
end;
$$;

revoke all on function public.list_shop_products(uuid, text, uuid, text) from public;
revoke all on function public.list_shop_products(uuid, text, uuid, text) from anon;
grant execute on function public.list_shop_products(uuid, text, uuid, text) to authenticated;

-- ============================================================
-- list_shop_categories: append image_url, display_order; order by
-- display_order first (falls back to name_ar for equal/default-0
-- orders, preserving today's alphabetical behavior for clubs that
-- never set an explicit order). Same drop+recreate reason as above.
-- ============================================================
drop function if exists public.list_shop_categories(uuid);

create function public.list_shop_categories(p_club_id uuid)
returns table(category_id uuid, name_ar text, name_en text, status text, image_url text, display_order integer)
language plpgsql
stable security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  return query select c.id, c.name_ar, c.name_en, c.status, c.image_url, c.display_order
    from public.shop_categories c
    where c.club_id = p_club_id and c.status = 'active'
    order by c.display_order, c.name_ar;
end;
$$;

revoke all on function public.list_shop_categories(uuid) from public;
revoke all on function public.list_shop_categories(uuid) from anon;
grant execute on function public.list_shop_categories(uuid) to authenticated;

-- ============================================================
-- list_shop_categories_all: same additions, used by Manage Categories
-- UI. Same drop+recreate reason as above.
-- ============================================================
drop function if exists public.list_shop_categories_all(uuid);

create function public.list_shop_categories_all(p_club_id uuid)
returns table(category_id uuid, name_ar text, name_en text, status text, image_url text, display_order integer)
language plpgsql
stable security definer
set search_path = public, pg_temp
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;
  return query select c.id, c.name_ar, c.name_en, c.status, c.image_url, c.display_order
    from public.shop_categories c
    where c.club_id = p_club_id
    order by c.display_order, c.status, c.name_ar;
end;
$$;

revoke all on function public.list_shop_categories_all(uuid) from public;
revoke all on function public.list_shop_categories_all(uuid) from anon;
grant execute on function public.list_shop_categories_all(uuid) to authenticated;

commit;
