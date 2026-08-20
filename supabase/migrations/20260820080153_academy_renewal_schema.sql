-- Phase E (Academy simplification, directive E4): "Renewal creates a
-- new monthly period. Do not overwrite the old month." Confirmed live
-- that this was architecturally impossible before this migration --
-- subscriptions_enrollment_id_key was a hard UNIQUE constraint on
-- enrollment_id, meaning at most one subscription row could ever exist
-- per enrollment. A "renewal" today could only mean overwriting that
-- one row's start_date/end_date -- exactly what the directive forbids.
--
-- Fix: replace the table-wide unique constraint with a partial unique
-- index that only applies to non-terminal statuses (pending/active/
-- frozen) -- so an enrollment can never have two subscriptions someone
-- would currently be paying/renewing against at once (preserving the
-- real invariant the old constraint was protecting), while still
-- allowing renewal to insert a brand-new row once the prior period's
-- subscription has moved to a terminal status (expired/cancelled).
-- Confirmed safe against existing data: all 21 current rows are
-- status IN ('active','pending'), one per enrollment -- this migration
-- does not touch or reinterpret a single existing row, it only changes
-- what's allowed going forward.

begin;

alter table public.subscriptions drop constraint subscriptions_enrollment_id_key;

create unique index subscriptions_one_non_terminal_per_enrollment
  on public.subscriptions (enrollment_id)
  where status in ('pending', 'active', 'frozen');

comment on index public.subscriptions_one_non_terminal_per_enrollment is
  'Phase E: at most one non-terminal (pending/active/frozen) subscription per enrollment at a time -- the real invariant the old table-wide UNIQUE(enrollment_id) was protecting. Once a subscription reaches expired/cancelled, a new one can be inserted for the same enrollment (renewal), preserving the old row as history rather than overwriting it.';

commit;
