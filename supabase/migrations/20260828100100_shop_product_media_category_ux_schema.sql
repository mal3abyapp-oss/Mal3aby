-- COMMERCE PRO C1 (2026-08-28) -- additive schema for Product Media +
-- Category UX. See COMMERCE_PRO_UPGRADE_PLAN.md Section 4 (Phase C1).
-- All additive, all reversible, no destructive rewrite.

begin;

-- shop_products.image_url stays the primary-image column (unchanged,
-- not renamed -- avoids touching every existing read RPC's column list
-- unnecessarily, per the plan). image_urls holds the ordered array of
-- *additional* gallery images.
alter table public.shop_products
  add column if not exists image_urls jsonb not null default '[]'::jsonb;

comment on column public.shop_products.image_urls is
  'Ordered array of additional product image URLs (public shop-product-images bucket paths/URLs). image_url remains the primary image.';

-- shop_categories: image/icon + explicit display ordering for the POS
-- category strip/selector (consumed starting Phase C2 -- this phase
-- only adds the schema + this phase''s own product/category management UI).
alter table public.shop_categories
  add column if not exists image_url text,
  add column if not exists display_order integer not null default 0;

comment on column public.shop_categories.display_order is
  'Explicit sort order for category UI (POS strip, catalog filters). Lower sorts first. Default 0 for all existing rows -- no ordering regression for categories created before this column existed.';

-- NOTE on parent_category_id: the plan (Section 4) flags this as
-- optional/speculative, to be added only if a genuine concrete need
-- surfaces while building this phase's UI. No such need surfaced --
-- Phase C1 is Products + Categories management only, a flat list is
-- sufficient for both the management UI built here and the POS
-- category strip planned for Phase C2 (a single-level strip of
-- category chips does not require hierarchy). Deliberately NOT added
-- in this migration; a future phase can add it additively if a real
-- nesting requirement appears.

commit;
