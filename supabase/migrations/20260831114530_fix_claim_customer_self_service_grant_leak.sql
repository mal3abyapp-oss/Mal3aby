-- The new 3-arg claim_customer_self_service() function object picked
-- up Postgres's own default PUBLIC EXECUTE grant on creation,
-- regardless of what grants the old 2-arg overload had. Confirmed
-- live: `anon`/PUBLIC both had EXECUTE on the new signature
-- immediately after it was created, even though the original
-- 20260816130000_customer_self_service_link.sql migration explicitly
-- granted only `authenticated`. The function's own auth.uid() null
-- check means this was not independently exploitable by a genuinely
-- unauthenticated caller, but it breaks this codebase's established
-- least-privilege convention. Re-apply the exact original grant set.

revoke all on function public.claim_customer_self_service(uuid, uuid, text) from public;
revoke all on function public.claim_customer_self_service(uuid, uuid, text) from anon;
grant execute on function public.claim_customer_self_service(uuid, uuid, text) to authenticated;
