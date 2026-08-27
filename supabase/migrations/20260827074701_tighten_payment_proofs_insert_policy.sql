-- LAUNCH READINESS AUDIT finding (HIGH): payment_proofs_bucket_insert's
-- with_check was `bucket_id = 'payment-proofs'` only -- any anon/
-- authenticated caller could write to an arbitrary path in this bucket.
-- Real tenant scoping already happens downstream in
-- record_payment_proof_upload() (validates the storage_path prefix
-- against the real booking/club before creating any DB row), so this
-- was never a read-exposure bug -- but it allowed unauthenticated
-- storage-squatting and orphaned uploads with no owning row. This adds
-- a cheap first-path-segment UUID-shape check, matching the pattern
-- already used by official_receipts_bucket_insert/_select
-- (foldername[1]::uuid). Does not fully replace the RPC's own
-- club/booking validation (a UUID-shaped folder name proves nothing
-- about which club/booking it claims to be), but closes the "any
-- string works" gap and cuts down junk/squatting uploads cheaply.
drop policy if exists payment_proofs_bucket_insert on storage.objects;

create policy payment_proofs_bucket_insert on storage.objects
  for insert to anon, authenticated
  with check (
    bucket_id = 'payment-proofs'
    and (storage.foldername(name))[1] ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
