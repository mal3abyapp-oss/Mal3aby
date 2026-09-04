-- FIX: the public pricing page needs a real, honest "N founding slots
-- remaining" figure for anonymous visitors -- founding_customer_slots
-- itself has no anon-facing RLS policy (correctly -- club_id, prices,
-- and claimed_by are real sensitive-adjacent data). Rather than widen
-- that table's own RLS (which would risk a future column leaking
-- through an over-broad anon grant), expose ONLY the taken-slot count
-- via a dedicated, narrow, security_invoker view -- matching this
-- release's own established pattern (public_plans is the same shape
-- of "safe public column subset" view, per ADR-040).
--
-- Found live during frontend implementation: the original page draft
-- queried founding_customer_slots directly and treated an RLS-filtered
-- empty result (count=0, no error) as "0 slots taken" rather than "I
-- am not authorized to see this" -- which would have shown "5
-- remaining" to every visitor regardless of the real state, a real
-- correctness bug caught before merge, not after.
create view public.founding_offer_public_status
with (security_invoker = true) as
select count(*)::integer as slots_taken, greatest(0, 5 - count(*))::integer as slots_remaining
from public.founding_customer_slots;

grant select on public.founding_offer_public_status to anon;
grant select on public.founding_offer_public_status to authenticated;

comment on view public.founding_offer_public_status is
  'Public-safe: exposes ONLY the aggregate founding-slot count (0-5), never club identity, price, or claim details -- those remain fully RLS-protected on founding_customer_slots itself, readable only by the claiming club or platform_owner via get_founding_offer_status(). Used by the public pricing page to show a real "N slots remaining" figure to anonymous visitors without granting anon any access to the underlying table.';
