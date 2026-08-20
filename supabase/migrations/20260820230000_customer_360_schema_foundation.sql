-- Customer 360 directive: "ONE CUSTOMER, ONE SOURCE OF TRUTH."
--
-- Audit findings this migration addresses (see conversation record):
--   1. No DB-level uniqueness ever backed (club_id, phone_e164) --
--      four independent client-side dedupe checks race each other.
--   2. guardian_links has no uniqueness on "one primary guardian per
--      player" -- the frontend's find(isPrimary) ?? guardians[0]
--      fallback means multiple primaries are silently possible.
--   3. notification_consent stores its own phone_display/
--      normalized_phone snapshot with no phone_e164 column, while
--      every WhatsApp send path is E.164-gated -- the consent ledger
--      can silently drift from the number actually messaged.
--   4. No merge/soft-delete primitive exists for customers, and there
--      is no DELETE RLS policy (by design -- official_collection_
--      receipts has ON DELETE RESTRICT on customer_id) -- a
--      merged_into_customer_id column is the safe alternative.
--
-- Live data confirmed via direct query before writing this migration:
--   - 51 customers total, 4 with NULL phone_e164 (already surfaced by
--     the existing get_phone_data_issues() banner -- untouched here).
--   - Exactly ONE (club_id, phone_e164) collision among the other 47:
--     "Ali" (6 bookings/invoices/payments) vs "Aliiii" (zero activity,
--     created ~13h later, clearly an accidental duplicate). Per the
--     directive section 11 ("do NOT auto-merge... build a review
--     path"), this migration does NOT delete or merge it -- the
--     unique index below explicitly excludes this one known pair so
--     the constraint can go live immediately; the new duplicate-
--     review workflow (separate migration/UI) is where a human
--     resolves it.
--   - 24 of 27 players already have a guardian_links row -- confirms
--     "Customer/Guardian -> Player" (directive section 3) is already
--     the live model. No players.customer_id column is added: that
--     would duplicate guardian_links, not fix a gap.

-- 1. Unique (club_id, phone_e164), excluding NULLs (unresolved phone
-- data, already tracked separately) and the one known pre-existing
-- collision (tracked for manual review, never auto-resolved).
create unique index if not exists customers_club_phone_e164_unique
  on public.customers (club_id, phone_e164)
  where phone_e164 is not null
    and id not in ('cb989bb7-8e4b-4890-b591-0aa4dce807f4', '8a398e82-5b24-4453-a8f1-3658d3425945');

-- 2. At most one primary guardian per player. Existing duplicate
-- primaries (if any survive past the partial-exclusion check) will
-- block this index from being created -- confirmed zero exist in live
-- data before writing this migration, so no exclusion needed here.
create unique index if not exists guardian_links_one_primary_per_player
  on public.guardian_links (player_id)
  where is_primary = true;

-- 3. notification_consent gains a real phone_e164 column so the
-- consent ledger can be reconciled against the same canonical number
-- every send path already gates on. Backfilled from the linked
-- customer's phone_e164 (best available data -- record_staff_
-- whatsapp_consent's own params only ever carried the legacy
-- normalized phone, per the audit). Kept nullable: a consent row can
-- still exist for a customer whose phone was later invalidated.
alter table public.notification_consent
  add column if not exists phone_e164 text;

update public.notification_consent nc
set phone_e164 = c.phone_e164
from public.customers c
where nc.customer_id = c.id
  and nc.phone_e164 is null
  and c.phone_e164 is not null;

-- 4. Soft "merged into" pointer -- the only safe way to retire a
-- duplicate customer given official_collection_receipts' ON DELETE
-- RESTRICT and the complete absence of a DELETE RLS policy on
-- customers (both by original design, confirmed via audit). A merge
-- workflow (future migration, per directive section 39: "design as a
-- separate controlled workflow", explicitly not auto-built this
-- phase) will set this rather than deleting rows or reassigning FKs.
alter table public.customers
  add column if not exists merged_into_customer_id uuid references public.customers(id);

create index if not exists idx_customers_merged_into
  on public.customers (merged_into_customer_id)
  where merged_into_customer_id is not null;

comment on column public.customers.merged_into_customer_id is
  'Set when this customer record has been identified as a duplicate and superseded by another customer. Historical financial/booking/academy rows are NEVER reassigned or deleted -- this column is purely a UI signal to redirect staff to the surviving record. NULL means this is not a known duplicate.';
