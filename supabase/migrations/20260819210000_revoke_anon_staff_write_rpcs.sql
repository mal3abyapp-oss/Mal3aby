-- Security hardening (task #18 regression pass): three staff-only write
-- RPCs added earlier this session were left with their default PUBLIC
-- EXECUTE grant, which PostgREST/Supabase exposes to both `anon` and
-- `authenticated`. Each RPC already re-checks has_permission() internally,
-- so an anon caller was never able to actually mutate data -- but granting
-- EXECUTE to anon on a write RPC is inconsistent with this codebase's own
-- posture (every other staff-only RPC explicitly revokes anon), and the
-- Supabase security advisor correctly flagged it. Belt-and-suspenders:
-- close the grant, keep the internal permission check as defense-in-depth.
--
-- record_payment_proof_upload is deliberately left anon-executable: guest
-- customers upload payment receipts without an account, and the function
-- itself validates booking existence + storage path prefix.

revoke execute on function public.set_club_booking_policy(uuid, boolean, integer, integer, integer, boolean) from anon;
revoke execute on function public.approve_payment_proof(uuid, text) from anon;
revoke execute on function public.reject_payment_proof(uuid, text) from anon;
