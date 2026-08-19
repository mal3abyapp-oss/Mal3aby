-- Root-cause fix for the anon-grant leak on the two new WhatsApp
-- failed-message RPCs (found via a live has_function_privilege() check
-- immediately after the prior migration -- the earlier "revoke ...
-- from anon" alone was insufficient). pg_proc.proacl showed a bare
-- "=X/postgres" entry (grant to the PUBLIC pseudo-role, no role name)
-- left over from this database's default privilege
-- (ALTER DEFAULT PRIVILEGES ... GRANT EXECUTE ON FUNCTIONS TO anon,
-- authenticated, ... -- confirmed via pg_default_acl) -- anon inherits
-- EXECUTE through implicit PUBLIC membership regardless of an explicit
-- per-role revoke. The correct fix is to also revoke from PUBLIC
-- itself, which is what every other correctly-locked-down RPC in this
-- schema (e.g. set_club_booking_policy) actually has, confirmed by
-- comparing pg_proc.proacl directly between the two.

revoke execute on function public.get_whatsapp_failed_messages(uuid) from public;
revoke execute on function public.retry_failed_whatsapp_message(uuid) from public;

grant execute on function public.get_whatsapp_failed_messages(uuid) to authenticated;
grant execute on function public.retry_failed_whatsapp_message(uuid) to authenticated;
