-- COMMERCE PRO C1 (2026-08-28) -- Product Media storage bucket.
-- See COMMERCE_PRO_UPGRADE_PLAN.md Section 4/5 (Phase C1).
--
-- Deliberately PUBLIC, unlike payment-proofs/official-receipts (which
-- are private): a product photo is not sensitive data, and a public
-- bucket lets the catalog grid/POS render thumbnails directly from a
-- stable public URL without needing signed-URL refresh logic on every
-- product card. This is a considered exception to this project's
-- default "private bucket" posture, not an oversight -- explicitly
-- called out in the plan (Section 2 invariant 7).
--
-- Path convention: club_id/product_id/filename -- mirrors the
-- club_id/entity_id/filename convention established by
-- official-receipts (20260819200006) and payment-proofs.
--
-- Even though the bucket is public (Supabase serves public-bucket
-- objects over the public API without a policy check), an explicit
-- SELECT policy is still written here -- matching this project's own
-- defense-in-depth convention of never relying on implicit
-- public-bucket behavior alone (confirmed via official-receipts/
-- payment-proofs both writing explicit policies even where a single
-- catch-all would technically suffice).

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'shop-product-images',
  'shop-product-images',
  true,
  5 * 1024 * 1024,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- SELECT: open to anyone (public bucket -- product photos are shown on
-- the public storefront/POS without requiring a session), written
-- explicitly rather than relying on the bucket's public flag alone.
create policy shop_product_images_bucket_select on storage.objects
  for select
  using (bucket_id = 'shop-product-images');

-- INSERT/UPDATE/DELETE: gated on club membership + shop.product.manage,
-- same shape as official-receipts' write policies, plus the module-active
-- gate this project's Shop domain applies to every other product/category
-- write path (create_shop_product, create_shop_category, etc. -- see
-- 20260828085500_shop_products_categories_variants_module_active_and_grants.sql).
create policy shop_product_images_bucket_insert on storage.objects
  for insert
  with check (
    bucket_id = 'shop-product-images'
    and (storage.foldername(name))[1]::uuid in (select public.user_club_ids())
    and public.has_permission('shop.product.manage', (storage.foldername(name))[1]::uuid)
    and public._shop_module_active((storage.foldername(name))[1]::uuid)
  );

create policy shop_product_images_bucket_update on storage.objects
  for update
  using (
    bucket_id = 'shop-product-images'
    and (storage.foldername(name))[1]::uuid in (select public.user_club_ids())
    and public.has_permission('shop.product.manage', (storage.foldername(name))[1]::uuid)
    and public._shop_module_active((storage.foldername(name))[1]::uuid)
  );

create policy shop_product_images_bucket_delete on storage.objects
  for delete
  using (
    bucket_id = 'shop-product-images'
    and (storage.foldername(name))[1]::uuid in (select public.user_club_ids())
    and public.has_permission('shop.product.manage', (storage.foldername(name))[1]::uuid)
    and public._shop_module_active((storage.foldername(name))[1]::uuid)
  );

commit;
