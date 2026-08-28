-- Commerce Pro C4 -- Club branding / print settings read+write RPCs.
-- See COMMERCE_PRO_UPGRADE_PLAN.md Section 1/4/14.
--
-- Shape chosen for the existing, previously-unused clubs.tax_info /
-- clubs.invoice_settings jsonb columns (documented here since this is
-- the migration that gives them their first real meaning):
--
--   tax_info: {
--     tax_number: text | null,
--     commercial_registration: text | null
--   }
--
--   invoice_settings: {
--     trading_name_ar: text | null,
--     trading_name_en: text | null,
--     address: text | null,
--     phone: text | null,
--     footer_note: text | null,
--     return_policy: text | null
--   }
--
-- Every key is optional/nullable -- printed documents render ONLY the
-- fields that are actually configured (plan's explicit "never force
-- empty placeholders" instruction; enforced on the frontend render
-- path, not here, since this RPC's job is just to read/write the blob
-- faithfully). logo_url stays on its own existing top-level
-- clubs.logo_url column (unchanged, already populated by nothing today
-- -- this phase adds the first write path for it via
-- update_shop_print_settings below).
--
-- get_shop_print_settings: read path. Gated on shop.view only (any
-- staff member who can see the shop should be able to preview the
-- current print branding, e.g. a cashier opening Settings to check
-- what's configured) -- NOT gated on shop.settings.manage, matching
-- this codebase's general "read broadly, write narrowly" posture
-- (explicitly the plan's own invariant 7 wording, applied here to a
-- settings read rather than a storage bucket).
create or replace function public.get_shop_print_settings(p_club_id uuid)
returns table(
  logo_url text,
  tax_number text,
  commercial_registration text,
  trading_name_ar text,
  trading_name_en text,
  address text,
  phone text,
  footer_note text,
  return_policy text
)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
begin
  if not (
    (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.view', p_club_id))
    or public.has_platform_support_access(p_club_id, false)
  ) then
    raise exception 'not authorized';
  end if;

  return query
  select
    c.logo_url,
    c.tax_info->>'tax_number',
    c.tax_info->>'commercial_registration',
    c.invoice_settings->>'trading_name_ar',
    c.invoice_settings->>'trading_name_en',
    c.invoice_settings->>'address',
    c.invoice_settings->>'phone',
    c.invoice_settings->>'footer_note',
    c.invoice_settings->>'return_policy'
  from public.clubs c
  where c.id = p_club_id;
end;
$$;

revoke all on function public.get_shop_print_settings(uuid) from public, anon;
grant execute on function public.get_shop_print_settings(uuid) to authenticated;

-- update_shop_print_settings: write path. Gated on shop.settings.manage
-- (new permission, previous migration) + module-active, matching this
-- module's standard write-RPC shape (auth check -> has_permission ->
-- _shop_module_active -> business logic -> write_audit_log). Every
-- parameter defaults to null = "leave unchanged" is NOT used here on
-- purpose -- unlike update_shop_product's per-field coalesce pattern,
-- a settings form always submits its full current state (it's a single
-- small settings section, not a partial-patch entity), so every field
-- is always supplied and this simply overwrites the two jsonb blobs
-- plus logo_url wholesale. Empty-string inputs are normalized to null
-- (nullif(btrim(...), '')) so an emptied form field actually clears the
-- stored value rather than persisting '' -- consistent with this
-- module's existing btrim/nullif convention (create_shop_sale's
-- discount_reason handling).
create or replace function public.update_shop_print_settings(
  p_club_id uuid,
  p_logo_url text default null,
  p_tax_number text default null,
  p_commercial_registration text default null,
  p_trading_name_ar text default null,
  p_trading_name_en text default null,
  p_address text default null,
  p_phone text default null,
  p_footer_note text default null,
  p_return_policy text default null
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_before public.clubs;
  v_tax_info jsonb;
  v_invoice_settings jsonb;
  v_via_support boolean;
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  v_via_support := not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.settings.manage', p_club_id))
    and public.has_platform_support_access(p_club_id, true);
  if not (p_club_id in (select public.user_club_ids()) and public.has_permission('shop.settings.manage', p_club_id) or v_via_support) then
    raise exception 'not authorized';
  end if;
  if not public._shop_module_active(p_club_id) then
    raise exception 'the shop module is not active for this club';
  end if;

  select * into v_before from public.clubs where id = p_club_id;
  if v_before.id is null then
    raise exception 'club not found';
  end if;

  v_tax_info := jsonb_strip_nulls(jsonb_build_object(
    'tax_number', nullif(btrim(coalesce(p_tax_number, '')), ''),
    'commercial_registration', nullif(btrim(coalesce(p_commercial_registration, '')), '')
  ));
  v_invoice_settings := jsonb_strip_nulls(jsonb_build_object(
    'trading_name_ar', nullif(btrim(coalesce(p_trading_name_ar, '')), ''),
    'trading_name_en', nullif(btrim(coalesce(p_trading_name_en, '')), ''),
    'address', nullif(btrim(coalesce(p_address, '')), ''),
    'phone', nullif(btrim(coalesce(p_phone, '')), ''),
    'footer_note', nullif(btrim(coalesce(p_footer_note, '')), ''),
    'return_policy', nullif(btrim(coalesce(p_return_policy, '')), '')
  ));

  update public.clubs
  set logo_url = nullif(btrim(coalesce(p_logo_url, '')), ''),
      tax_info = v_tax_info,
      invoice_settings = v_invoice_settings
  where id = p_club_id;

  perform public.write_audit_log(
    p_club_id, 'shop.print_settings.update', 'club', p_club_id,
    jsonb_build_object('logo_url', v_before.logo_url, 'tax_info', v_before.tax_info, 'invoice_settings', v_before.invoice_settings),
    jsonb_build_object('logo_url', nullif(btrim(coalesce(p_logo_url, '')), ''), 'tax_info', v_tax_info, 'invoice_settings', v_invoice_settings),
    null
  );
  if v_via_support then
    perform public.write_audit_log_as_support(
      p_club_id, 'shop.print_settings.update', 'club', p_club_id,
      jsonb_build_object('logo_url', v_before.logo_url, 'tax_info', v_before.tax_info, 'invoice_settings', v_before.invoice_settings),
      jsonb_build_object('logo_url', nullif(btrim(coalesce(p_logo_url, '')), ''), 'tax_info', v_tax_info, 'invoice_settings', v_invoice_settings),
      null
    );
  end if;
end;
$$;

revoke all on function public.update_shop_print_settings(uuid, text, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.update_shop_print_settings(uuid, text, text, text, text, text, text, text, text, text) to authenticated;
