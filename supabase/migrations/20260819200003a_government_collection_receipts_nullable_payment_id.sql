-- Bug fix, caught in review before any production data existed in the
-- new tables: official_collection_receipts.payment_id was NOT NULL,
-- but record_payment_with_official_receipt() must insert the receipt
-- FIRST (so its unique-serial constraint fires before any payment is
-- touched -- directive section 13/18: duplicate detection must happen
-- before money moves, and payment+receipt must be atomic) and only
-- knows the resulting payment_id afterward, from inside
-- record_payment() itself, in the same transaction.
--
-- Relaxed to nullable at insert time; ocr_unique_active_payment_idx
-- (a partial unique index on payment_id where status='active') still
-- guarantees a payment is never linked to more than one active
-- receipt -- multiple receipts can be transiently unlinked (payment_id
-- IS NULL) only for the instant between their own insert and the
-- record_payment() call inside the SAME transaction; the function
-- always fills it in or the whole transaction rolls back, so no
-- unlinked receipt is ever visible outside a transaction that failed
-- entirely.

begin;

alter table public.official_collection_receipts
  alter column payment_id drop not null;

commit;
