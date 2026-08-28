-- SHOP MODULE UX HARDENING (2026-08-28) -- real production acceptance
-- pass found create_shop_category/list_shop_categories already existed
-- but had NO update path at all: no rename, no archive/reactivate.
-- shop_categories.status already exists and list_shop_categories
-- already filters status='active' -- the column and its consumer were
-- ready, only the write RPC was missing. Same authorization/audit
-- pattern as update_shop_product, create_shop_category.
create or replace function public.update_shop_category(
  p_category_id uuid,
  p_name_ar text default null,
  p_name_en text default null,
  p_status text default null
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
        status = coalesce(p_status, status)
    where id = p_category_id;

  perform public.write_audit_log(v_club_id, 'shop_category.updated', 'shop_category', p_category_id, v_before,
    jsonb_build_object('name_ar', p_name_ar, 'name_en', p_name_en, 'status', p_status), null);
  if v_via_support then
    perform public.write_audit_log_as_support(v_club_id, 'shop_category.updated', 'shop_category', p_category_id, v_before,
      jsonb_build_object('name_ar', p_name_ar, 'name_en', p_name_en, 'status', p_status), null);
  end if;
end;
$$;

revoke execute on function public.update_shop_category(uuid, text, text, text) from public;
revoke execute on function public.update_shop_category(uuid, text, text, text) from anon;
grant execute on function public.update_shop_category(uuid, text, text, text) to authenticated;

-- list_shop_categories only ever returned status='active' rows -- the
-- Manage Categories UI needs to show archived ones too (so they can be
-- reactivated), so a second, explicit "include archived" listing RPC
-- is added rather than changing the existing one's contract (the
-- existing one is also used by every product-picker select, which
-- must keep excluding archived categories unchanged).
create or replace function public.list_shop_categories_all(p_club_id uuid)
returns table(category_id uuid, name_ar text, name_en text, status text)
language plpgsql
stable security definer
set search_path = public, pg_temp
as $$
begin
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.product.manage', p_club_id)
          or public.has_platform_support_access(p_club_id, false)) then
    raise exception 'not authorized';
  end if;
  return query select c.id, c.name_ar, c.name_en, c.status from public.shop_categories c where c.club_id = p_club_id order by c.status, c.name_ar;
end;
$$;

revoke execute on function public.list_shop_categories_all(uuid) from public;
revoke execute on function public.list_shop_categories_all(uuid) from anon;
grant execute on function public.list_shop_categories_all(uuid) to authenticated;
