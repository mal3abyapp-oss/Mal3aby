-- Security hardening (task #18 regression pass, part 2): expire_stale_booking_holds()
-- is an internal maintenance function invoked only by the pg_cron job
-- ('expire-stale-booking-holds', every minute) and has no legitimate
-- frontend caller. It was left with the default PUBLIC EXECUTE grant, so
-- Supabase security advisor flagged it as reachable by anon/authenticated
-- via PostgREST (/rest/v1/rpc/expire_stale_booking_holds). The function
-- has no auth/permission check of its own by design (cron runs as the
-- table owner, not a user session), so unlike the write RPCs fixed in the
-- prior migration this one has no internal defense-in-depth -- it must be
-- revoked at the grant level. Not calling it directly does not corrupt
-- data (it is idempotent -- only touches already-expired pending_payment
-- rows), but there is no reason to leave a cron-only reaper open to the
-- public API surface.

revoke execute on function public.expire_stale_booking_holds() from anon;
revoke execute on function public.expire_stale_booking_holds() from authenticated;
