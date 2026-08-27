-- LAUNCH READINESS AUDIT finding (MEDIUM): official-receipts bucket had
-- no server-side file_size_limit/allowed_mime_types, unlike
-- payment-proofs. Client-side checks exist in
-- official-collection-receipt-fields.tsx but weren't backstopped
-- server-side. Matches payment-proofs' existing limits exactly.
update storage.buckets
set file_size_limit = 10485760, allowed_mime_types = array['image/jpeg','image/png','application/pdf']
where id = 'official-receipts';
