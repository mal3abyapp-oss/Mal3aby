-- V1 Implementation Gap Audit (2026-08-16): protect_club_status_from_non_platform_owner
-- is a trigger function -- it should never be directly RPC-callable
-- (Postgres invokes it automatically on UPDATE; there is no legitimate
-- reason for a client to call it directly). The security advisor
-- correctly flagged it as callable via /rest/v1/rpc after its creation
-- migration (20260816040000) didn't include the same explicit
-- revoke-from-public/anon/authenticated pattern already used for every
-- other internal-only function in this codebase (e.g. handle_new_user).
revoke execute on function public.protect_club_status_from_non_platform_owner() from public;
revoke execute on function public.protect_club_status_from_non_platform_owner() from anon;
revoke execute on function public.protect_club_status_from_non_platform_owner() from authenticated;
