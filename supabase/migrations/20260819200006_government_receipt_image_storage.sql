-- Government / Ministry Collection Compliance -- private storage
-- (directive sections 23-24).
--
-- A dedicated bucket, not the existing payment-proofs bucket -- an
-- official receipt image is a distinct legal artifact from a customer-
-- submitted payment proof (directive section 50), and mixing them in
-- one bucket would make future access-policy divergence (e.g. if
-- payment-proof retention rules ever differ from receipt-image
-- retention rules) harder to reason about.

begin;

insert into storage.buckets (id, name, public)
values ('official-receipts', 'official-receipts', false)
on conflict (id) do nothing;

-- Path convention: club_id/receipt_id/filename -- mirrors the
-- payment-proofs bucket's club_id/booking_id/filename convention.
-- Staff with payment.create can upload; staff with payment.view can
-- read; platform owner has no special storage access here (receipt
-- images are never exposed to platform-wide oversight per directive
-- section 45: "لا تعرض Sensitive receipt images بلا حاجة").
create policy official_receipts_bucket_insert on storage.objects
  for insert
  with check (
    bucket_id = 'official-receipts'
    and (storage.foldername(name))[1]::uuid in (select public.user_club_ids())
    and public.has_permission('payment.create', (storage.foldername(name))[1]::uuid)
  );

create policy official_receipts_bucket_select on storage.objects
  for select
  using (
    bucket_id = 'official-receipts'
    and (storage.foldername(name))[1]::uuid in (select public.user_club_ids())
    and public.has_permission('payment.view', (storage.foldername(name))[1]::uuid)
  );

commit;
