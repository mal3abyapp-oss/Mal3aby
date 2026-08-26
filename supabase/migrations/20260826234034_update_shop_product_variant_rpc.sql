-- COMMERCIAL MODULE ARCHITECTURE, continued -- directive Section 8:
-- variant lifecycle. create_shop_product_variant existed but there was
-- no way to deactivate a variant without deleting it (which would
-- break historical shop_sale_items/shop_inventory_movements/
-- invoice_items foreign keys pointing at it -- the same "never
-- hard-delete something with history" principle already applied to
-- products). update_shop_product_variant() lets a variant be archived
-- (or edited) safely -- create_shop_sale() already filters
-- `status = 'active'` on variants (confirmed in its own body), so an
-- archived variant is immediately unsellable without touching any
-- historical row.
create or replace function public.update_shop_product_variant(
  p_variant_id uuid,
  p_size text default null,
  p_color text default null,
  p_sku text default null,
  p_barcode text default null,
  p_price_override numeric default null,
  p_status text default 'active'
)
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

revoke all on function public.update_shop_product_variant(uuid, text, text, text, text, numeric, text) from public;
revoke all on function public.update_shop_product_variant(uuid, text, text, text, text, numeric, text) from anon;
grant execute on function public.update_shop_product_variant(uuid, text, text, text, text, numeric, text) to authenticated;
