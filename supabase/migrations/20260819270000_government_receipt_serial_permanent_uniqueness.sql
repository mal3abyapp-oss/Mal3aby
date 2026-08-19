-- Financial accountability fix (acceptance-pass review): an official
-- receipt serial that has ever been used must never be reusable, even
-- after reversal/cancellation. Reversal records that the collection was
-- undone; it does not erase the historical fact that this receipt
-- number was once issued under this club/book/series. No documented
-- ministry policy in this project permits reuse, so the safest default
-- applies: uniqueness must hold across ALL historical statuses
-- (active, reversed, cancelled), not just currently-active rows.
--
-- Replaces the previous partial unique index (WHERE status='active',
-- which allowed a reversed receipt's serial to be reused) with a
-- full-table unique index scoped to (club, book, series, normalized
-- serial) covering every row regardless of status.
drop index if exists public.ocr_unique_active_serial_idx;

create unique index ocr_unique_serial_all_time_idx
  on public.official_collection_receipts (
    club_id,
    coalesce(receipt_book, ''),
    coalesce(receipt_series, ''),
    normalized_receipt_serial
  );

comment on index public.ocr_unique_serial_all_time_idx is
  'Official receipt serials are unique per club/book/series across ALL history (active, reversed, cancelled) -- once issued, a serial can never be reused, per government financial accountability requirements. Corrections must always use a new serial.';
