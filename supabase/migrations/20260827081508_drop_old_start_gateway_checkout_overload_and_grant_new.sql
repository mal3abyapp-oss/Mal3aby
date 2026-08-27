-- Drop the OLD 3-arg start_gateway_checkout (stripe/paypal-only,
-- payment_gateway_configs-only) now that the widened 5-arg version
-- (club_gateway_connections-based, all 5 providers) fully supersedes
-- it. Leaving both would be a live orphaned-overload security/grant-
-- hygiene defect exactly like the one flagged (but left, WhatsApp-
-- adjacent) in RPC_GRANT_AUDIT.md -- here there IS proven cause
-- (this table is Phase 2 in-progress work, not the protected WhatsApp
-- subsystem) so it's safe to remove outright rather than merely flag.
drop function if exists public.start_gateway_checkout(uuid, text, numeric);

revoke all on function public.start_gateway_checkout(uuid, text, numeric, uuid, uuid) from public, anon;
grant execute on function public.start_gateway_checkout(uuid, text, numeric, uuid, uuid) to authenticated;
