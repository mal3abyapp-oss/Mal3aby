-- Commerce Pro C4 -- Club branding logo storage bucket.
-- See COMMERCE_PRO_UPGRADE_PLAN.md Section 1/4: no logo upload UI
-- exists anywhere in the app today (clubs.logo_url is read-only in
-- MembershipCard.tsx / PublicClubBookingPage.tsx, confirmed via full
-- src/ grep before this migration was written). Per the plan's own
-- instruction ("if no upload UI exists anywhere yet, use the same
-- shop-product-images-bucket-pattern approach from C1 -- a new small,
-- appropriately-scoped bucket or path"), this is a NEW, narrowly-scoped
-- bucket rather than reusing shop-product-images: a club logo is not a
-- product photo, and gating it on shop.product.manage (the existing
-- bucket's write permission) would be semantically wrong -- this phase
-- introduces shop.settings.manage specifically for branding/print
-- settings, so the bucket's write policies gate on that instead.
--
-- Deliberately PUBLIC, same reasoning as shop-product-images
-- (20260828100000): a club logo is displayed on public-facing surfaces
-- already (PublicClubBookingPage.tsx, membership cards, and now printed
-- invoices/receipts a customer walks away with) -- there is nothing
-- sensitive about it, and a public bucket avoids needing signed-URL
-- refresh logic for a value that must render reliably on a printed
-- physical document.
--
-- Path convention: club_id/branding/filename -- mirrors the
-- club_id/entity_id/filename convention (shop-product-images,
-- official-receipts, payment-proofs), with 'branding' as the fixed
-- entity segment since a club has exactly one logo, not many.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'club-branding',
  'club-branding',
  true,
  2 * 1024 * 1024,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

-- SELECT: open to anyone (public bucket -- the logo appears on public
-- booking pages and printed documents handed to customers), written
-- explicitly rather than relying on the bucket's public flag alone,
-- matching this project's defense-in-depth convention.
create policy club_branding_bucket_select on storage.objects
  for select
  using (bucket_id = 'club-branding');

-- INSERT/UPDATE/DELETE: gated on club membership + shop.settings.manage
-- + the shop module being active for this club -- same three-part gate
-- shape as shop_product_images_bucket_insert/update/delete
-- (20260828100000), substituting shop.settings.manage for
-- shop.product.manage since this is a distinct capability.
create policy club_branding_bucket_insert on storage.objects
  for insert
  with check (
    bucket_id = 'club-branding'
    and (storage.foldername(name))[1]::uuid in (select public.user_club_ids())
    and public.has_permission('shop.settings.manage', (storage.foldername(name))[1]::uuid)
    and public._shop_module_active((storage.foldername(name))[1]::uuid)
  );

create policy club_branding_bucket_update on storage.objects
  for update
  using (
    bucket_id = 'club-branding'
    and (storage.foldername(name))[1]::uuid in (select public.user_club_ids())
    and public.has_permission('shop.settings.manage', (storage.foldername(name))[1]::uuid)
    and public._shop_module_active((storage.foldername(name))[1]::uuid)
  );

create policy club_branding_bucket_delete on storage.objects
  for delete
  using (
    bucket_id = 'club-branding'
    and (storage.foldername(name))[1]::uuid in (select public.user_club_ids())
    and public.has_permission('shop.settings.manage', (storage.foldername(name))[1]::uuid)
    and public._shop_module_active((storage.foldername(name))[1]::uuid)
  );

commit;
